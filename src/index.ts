/**
 * @dsh-external/dsh-remote-workspace — 远程站点与远程工作区（SSH/SFTP）。
 *
 * 概念模型：
 *  - RemoteSite       = 一个 SSH/SFTP 连接配置（host / user / auth / homePath）
 *  - RemoteWorkspace  = 远程站点 + 远程目录，拥有左侧栏锚点工作区（session 分组）
 *  - 本地目录是“本地连接”的特殊情况，由 DSH 原生 workspace 体系处理
 *
 * 宿主端职责：
 *  1. 持久化 Site / Workspace 两张表（~/.dsh/storages/remote-workspaces.json，0600）
 *  2. SSH2 + SFTP：连接测试、家目录解析、目录浏览/新建、文件读写
 *  3. 把远程工作区注册进 DSH workspaceRegistry（左侧栏与本地工作区平等）
 *  4. 经 ctx.webServer 暴露 HTTP API（/remote-workspaces/api/*），供客户端面板调用
 *  5. 向 agent 注册 remote_site_* / remote_workspace_* 工具
 */
import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2'

interface LocalWorkspaceEntity {
  id: string
  path: string
  title: string
  sessionIds: string[]
  setTitle(title: string): Promise<void>
}

type AppContext = Context & {
  webServer: {
    register(route: {
      kind: 'exact' | 'prefixes'
      path: string
      handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
    }): () => void
  }
  tools: {
    register(tool: unknown): () => void
  }
  workspaceRegistry: {
    get(id: string): LocalWorkspaceEntity | undefined
    list(): LocalWorkspaceEntity[]
    create(path: string, title?: string): Promise<LocalWorkspaceEntity>
    delete(id: string): Promise<boolean>
    resolveByPath(path: string): Promise<LocalWorkspaceEntity | undefined>
  }
}

/* ------------------------------------------------------------------ */
/* 类型与常量                                                          */
/* ------------------------------------------------------------------ */

export const name = '@dsh-external/dsh-remote-workspace'
export const inject = ['webServer', 'tools', 'workspaceRegistry']

const API_PREFIX = '/remote-workspaces/api'
const STORAGE_VERSION = 2
const MAX_BODY_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024
const READY_TIMEOUT_MS = 12_000

type AuthConfig =
  | { kind: 'password'; password: string }
  | { kind: 'privateKey'; privateKeyPath: string; passphrase?: string }
  | { kind: 'agent' }

interface RemoteSiteRecord {
  id: string
  name: string
  host: string
  port: number
  username: string
  homePath: string
  auth: AuthConfig
  hostHash?: string
  createdAt: string
  updatedAt: string
}

interface RemoteSiteView {
  id: string
  name: string
  host: string
  port: number
  username: string
  homePath: string
  authKind: AuthConfig['kind']
  endpoint: string
  workspaceCount: number
  createdAt: string
  updatedAt: string
}

interface RemoteWorkspaceRecord {
  id: string
  siteId: string
  name: string
  rootPath: string
  localWorkspaceId?: string
  createdAt: string
  updatedAt: string
}

interface RemoteWorkspaceView {
  id: string
  siteId: string
  siteName: string
  name: string
  rootPath: string
  endpoint: string
  anchorPath: string
  localWorkspaceId?: string
  createdAt: string
  updatedAt: string
}

interface StorageShape {
  version: typeof STORAGE_VERSION
  sites: RemoteSiteRecord[]
  workspaces: RemoteWorkspaceRecord[]
}

interface SftpEntry {
  name: string
  path: string
  type: 'd' | 'l' | 'f' | 'other'
  size: number
  mtime: number
  mode: number
}

interface ApiErr {
  ok: false
  error: { code: string; message: string }
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function nowIso(): string {
  return new Date().toISOString()
}

function posixNormalize(path: string): string {
  const norm = posix.normalize(path)
  if (norm === '.' || norm === '/') return '/'
  return norm
}

/**
 * 把相对路径解析为 rootPath 之下的绝对远程路径；越界直接抛错。
 */
function resolveRemotePath(rootPath: string, rel?: string): string {
  const root = posixNormalize(rootPath)
  const base = root === '/' ? '' : root.replace(/\/+$/, '')
  const candidate = rel === undefined || rel === '' ? root : posix.resolve(root, rel)
  const norm = posixNormalize(candidate)
  const insideRoot = root === '/'
    ? norm.startsWith('/')
    : norm === base || norm.startsWith(base + '/')
  if (!insideRoot) {
    throw new Error(`remote path '${rel ?? ''}' escapes workspace root '${rootPath}'`)
  }
  return norm
}

function defaultWorkspaceName(site: RemoteSiteRecord, rootPath: string): string {
  const root = posixNormalize(rootPath)
  if (root === site.homePath) return site.name
  const base = posix.basename(root) || '/'
  return `${site.name} · ${base}`
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function apiError(error: unknown, fallback = 'internal-error'): ApiErr {
  const message = errorMessage(error)
  const code = /EACCES|permission/i.test(message)
    ? 'permission-denied'
    : /connect|ECONN|ENOTFOUND|timeout|Timed out|readyTimeout/i.test(message)
      ? 'connect-failed'
      : /authentication|auth|invalid user|password|private key|All configured/i.test(message)
        ? 'auth-failed'
        : /No such file|ENOENT|does not exist/i.test(message)
          ? 'not-found'
          : /escapes workspace/i.test(message)
            ? 'path-denied'
            : /Host key|fingerprint|verification|Host denied/i.test(message)
              ? 'host-key-changed'
              : fallback
  return { ok: false, error: { code, message } }
}

/* ------------------------------------------------------------------ */
/* 存储与迁移                                                          */
/* ------------------------------------------------------------------ */

function storagePaths() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return {
    dir: join(dshHome, 'storages'),
    file: join(dshHome, 'storages', 'remote-workspaces.json'),
  }
}

function saveStoreAtomic(store: StorageShape): void {
  const { dir, file } = storagePaths()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  // 0600 的 tmp 原子替换后即成为正式文件，权限随 inode 保留
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

interface LegacyWorkspaceRecord {
  id: string
  name: string
  host: string
  port: number
  username: string
  rootPath: string
  auth: AuthConfig
  hostHash?: string
  localWorkspaceId?: string
  createdAt: string
  updatedAt: string
}

/** v1（连接与工作区合一）→ v2（Site + Workspace 分离）迁移。 */
function migrateLegacyStore(legacyWorkspaces: LegacyWorkspaceRecord[]): StorageShape {
  const sites: RemoteSiteRecord[] = []
  const workspaces: RemoteWorkspaceRecord[] = []
  for (const old of legacyWorkspaces) {
    const siteId = `site-${old.id}`
    sites.push({
      id: siteId,
      name: old.name,
      host: old.host,
      port: old.port,
      username: old.username,
      homePath: posixNormalize(old.rootPath),
      auth: old.auth,
      hostHash: old.hostHash,
      createdAt: old.createdAt,
      updatedAt: old.updatedAt,
    })
    workspaces.push({
      id: old.id,
      siteId,
      name: old.name,
      rootPath: posixNormalize(old.rootPath),
      localWorkspaceId: old.localWorkspaceId,
      createdAt: old.createdAt,
      updatedAt: old.updatedAt,
    })
  }
  return { version: STORAGE_VERSION, sites, workspaces }
}

function loadStore(): StorageShape {
  const { file } = storagePaths()
  if (!existsSync(file)) return { version: STORAGE_VERSION, sites: [], workspaces: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      version?: unknown
      sites?: unknown
      workspaces?: unknown
    }
    if (
      parsed.version === STORAGE_VERSION
      && Array.isArray(parsed.sites)
      && Array.isArray(parsed.workspaces)
    ) {
      return {
        version: STORAGE_VERSION,
        sites: parsed.sites as RemoteSiteRecord[],
        workspaces: parsed.workspaces as RemoteWorkspaceRecord[],
      }
    }
    if (parsed.version === 1 && Array.isArray(parsed.workspaces)) {
      const migrated = migrateLegacyStore(parsed.workspaces as LegacyWorkspaceRecord[])
      saveStoreAtomic(migrated)
      return migrated
    }
    return { version: STORAGE_VERSION, sites: [], workspaces: [] }
  } catch (error) {
    console.error('[remote-workspace] failed to read store:', errorMessage(error))
    return { version: STORAGE_VERSION, sites: [], workspaces: [] }
  }
}

/* ------------------------------------------------------------------ */
/* 视图与锚点                                                          */
/* ------------------------------------------------------------------ */

function siteView(site: RemoteSiteRecord, workspaceCount: number): RemoteSiteView {
  return {
    id: site.id,
    name: site.name,
    host: site.host,
    port: site.port,
    username: site.username,
    homePath: site.homePath,
    authKind: site.auth.kind,
    endpoint: `${site.username}@${site.host}:${site.port}`,
    workspaceCount,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  }
}

function anchorDir(workspaceId: string): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'remote-workspaces', workspaceId)
}

function anchorInstructions(site: RemoteSiteRecord, workspace: RemoteWorkspaceRecord): string {
  return `# Remote workspace: ${workspace.name}

This session belongs to a REMOTE SSH/SFTP workspace. The local working
directory is only an anchor used for session grouping in the sidebar; the real
project files live on the remote host.

- Remote workspace id: ${workspace.id}
- Remote site: ${site.name} (${site.id})
- Endpoint: ${site.username}@${site.host}:${site.port}
- Remote root: ${workspace.rootPath}

Rules for this session:
- Resolve user file paths against the remote root ${workspace.rootPath}.
- Use remote_workspace_browse / remote_workspace_read / remote_workspace_write
  (and remote_workspace_test) for ALL remote file operations.
- Do NOT expect project files to exist in this local anchor directory, and do
  not use local file tools on it as a substitute for the remote filesystem.
`
}

function workspaceView(site: RemoteSiteRecord, workspace: RemoteWorkspaceRecord): RemoteWorkspaceView {
  return {
    id: workspace.id,
    siteId: site.id,
    siteName: site.name,
    name: workspace.name,
    rootPath: workspace.rootPath,
    endpoint: `${site.username}@${site.host}:${site.port}`,
    anchorPath: anchorDir(workspace.id),
    localWorkspaceId: workspace.localWorkspaceId,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

/* ------------------------------------------------------------------ */
/* SSH/SFTP                                                            */
/* ------------------------------------------------------------------ */

interface ConnectResult {
  client: Client
  sftp: SFTPWrapper
  presentedHostHash?: string
}

function buildConnectConfig(
  site: RemoteSiteRecord,
  expectedHash?: string,
  onPresented?: (fingerprint: string) => void,
): ConnectConfig {
  const auth = site.auth
  const config: ConnectConfig = {
    host: site.host,
    port: site.port,
    username: site.username,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: 15_000,
  } as ConnectConfig
  // ssh2 约定：配置 hostHash（算法名）后，hostVerifier 收到哈希后的指纹字符串。
  if (expectedHash) config.hostHash = 'sha256'
  config.hostVerifier = ((key: unknown, verify?: (permitted: boolean) => void): boolean => {
    const fingerprint = typeof key === 'string'
      ? key
      : createHash('sha256').update(key as Buffer).digest('hex')
    const presented = `sha256:${fingerprint}`
    onPresented?.(presented)
    const permitted = expectedHash === undefined || expectedHash === presented
    if (verify) verify(permitted)
    return permitted
  }) as ConnectConfig['hostVerifier']
  if (auth.kind === 'password') {
    config.password = auth.password
  } else if (auth.kind === 'privateKey') {
    if (!existsSync(auth.privateKeyPath)) {
      throw new Error(`private key file not found: ${auth.privateKeyPath}`)
    }
    config.privateKey = readFileSync(auth.privateKeyPath)
    if (auth.passphrase) config.passphrase = auth.passphrase
  } else if (auth.kind === 'agent') {
    config.agent = process.env.SSH_AUTH_SOCK
    if (!config.agent) throw new Error('SSH agent auth requested but SSH_AUTH_SOCK is not set')
  }
  return config
}

async function connectSftp(site: RemoteSiteRecord): Promise<ConnectResult> {
  const expectedHash = site.hostHash
  let presentedHash: string | undefined
  const client = new Client()

  const connected = new Promise<ConnectResult>((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      try { client.end() } catch { /* ignore */ }
      reject(error)
    }
    client.once('error', fail)
    client.once('ready', () => {
      if (settled) return
      client.sftp((error, sftp) => {
        if (settled) return
        if (error) {
          fail(error as Error)
          return
        }
        settled = true
        resolve({ client, sftp, presentedHostHash: presentedHash })
      })
    })
    try {
      const config = buildConnectConfig(site, expectedHash, (fingerprint) => {
        presentedHash = fingerprint
      })
      client.connect(config)
    } catch (error) {
      fail(error as Error)
    }
  })

  return connected
}

async function withSiteSftp<T>(site: RemoteSiteRecord, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const connection = await connectSftp(site)
  try {
    return await fn(connection.sftp)
  } finally {
    try { connection.sftp.end() } catch { /* ignore */ }
    try { connection.client.end() } catch { /* ignore */ }
  }
}

/**
 * 连接并落地站点的家目录：
 *  - homeInput 为空 → sftp.realpath('.') 解析服务器真实家目录
 *  - homeInput 非空 → realpath 规范化并验证是目录
 * 返回时 site.homePath 已是规范化绝对路径。
 */
async function prepareSiteConnection(
  site: RemoteSiteRecord,
  homeInput?: string,
  onHostHash?: (hash?: string) => void,
): Promise<void> {
  const connection = await connectSftp(site)
  try {
    const requested = homeInput !== undefined && homeInput.trim() !== ''
      ? homeInput.trim()
      : await sftpRealpath(connection.sftp, '.')
    const canonical = await sftpRealpath(connection.sftp, requested)
    const stats = await sftpStat(connection.sftp, canonical)
    if (!stats.isDirectory()) throw new Error(`remote home '${canonical}' is not a directory`)
    site.homePath = posixNormalize(canonical)
    onHostHash?.(connection.presentedHostHash)
  } finally {
    try { connection.sftp.end() } catch { /* ignore */ }
    try { connection.client.end() } catch { /* ignore */ }
  }
}

async function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    sftp.realpath(path, (error, resolved) => (error ? reject(error) : resolve(resolved)))
  })
}

async function sftpStat(sftp: SFTPWrapper, path: string) {
  return new Promise<{ isDirectory(): boolean; isFile(): boolean; size: number; mtime: number; mode: number }>((resolve, reject) => {
    sftp.stat(path, (error, stats) => (error ? reject(error) : resolve(stats)))
  })
}

async function sftpMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.mkdir(path, (error) => (error ? reject(error) : resolve()))
  })
}

async function sftpList(sftp: SFTPWrapper, path: string): Promise<SftpEntry[]> {
  const list = await new Promise<Array<{ filename: string; longname: string; attrs: { size: number; mtime: number; mode: number } }>>((resolve, reject) => {
    sftp.readdir(path, (error, entries) => (error ? reject(error) : resolve(entries)))
  })
  return list
    .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
    .map((entry) => {
      const type = entry.attrs.mode & 0o170000
      const kind = type === 0o040000 ? 'd' : type === 0o120000 ? 'l' : type === 0o100000 ? 'f' : 'other'
      return {
        name: entry.filename,
        path: posixNormalize(posix.join(path, entry.filename)),
        type: kind as SftpEntry['type'],
        size: entry.attrs.size ?? 0,
        mtime: entry.attrs.mtime ?? 0,
        mode: entry.attrs.mode ?? 0,
      }
    })
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'd' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
}

async function sftpReadText(sftp: SFTPWrapper, path: string, maxBytes: number) {
  const content = await new Promise<Buffer>((resolve, reject) => {
    sftp.readFile(path, (error, buffer) => (error ? reject(error) : resolve(buffer as Buffer)))
  })
  if (content.length > maxBytes) {
    throw new Error(`file is ${content.length} bytes, exceeds maxBytes=${maxBytes}`)
  }
  if (content.subarray(0, Math.min(content.length, 8192)).includes(0)) {
    return { encoding: 'base64' as const, content: content.toString('base64'), size: content.length }
  }
  return { encoding: 'utf8' as const, content: content.toString('utf8'), size: content.length }
}

async function sftpWrite(sftp: SFTPWrapper, path: string, content: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.writeFile(path, content, (error) => (error ? reject(error) : resolve()))
  })
}

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

interface SiteAddInput {
  name?: string
  host: string
  port?: number
  username: string
  homePath?: string
  auth: AuthConfig
}

interface SiteUpdateInput {
  name?: string
  host?: string
  port?: number
  username?: string
  homePath?: string
  auth?: AuthConfig
}

interface WorkspaceAddInput {
  siteId: string
  rootPath?: string
  name?: string
}

class RemoteService {
  private ctx: AppContext
  private store: StorageShape = loadStore()
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(ctx: AppContext) {
    this.ctx = ctx
  }

  private mutate<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.mutationTail.then(async () => {
      const result = await fn()
      saveStoreAtomic(this.store)
      return result
    })
    this.mutationTail = run.then(() => {}, () => {})
    return run
  }

  /* ---------------------------- sites ---------------------------- */

  listSites(): RemoteSiteView[] {
    return this.store.sites.map((site) => {
      const count = this.store.workspaces.filter((workspace) => workspace.siteId === site.id).length
      return siteView(site, count)
    })
  }

  getSite(id: string): RemoteSiteRecord {
    const site = this.store.sites.find((candidate) => candidate.id === id)
    if (!site) throw new Error(`remote site '${id}' not found`)
    return site
  }

  async addSite(input: SiteAddInput): Promise<RemoteSiteView> {
    const site: RemoteSiteRecord = {
      id: randomUUID(),
      name: input.name?.trim() || `${input.username}@${input.host}`,
      host: input.host.trim(),
      port: input.port ?? 22,
      username: input.username.trim(),
      homePath: '/',
      auth: input.auth,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    await prepareSiteConnection(site, input.homePath, (hash) => {
      if (hash) site.hostHash = hash
    })
    await this.mutate(() => {
      this.store.sites.unshift(site)
    })
    return siteView(site, 0)
  }

  async testSite(id: string): Promise<RemoteSiteView> {
    const site = this.getSite(id)
    const hadHash = Boolean(site.hostHash)
    const homeBefore = site.homePath
    await prepareSiteConnection(site, site.homePath, (hash) => {
      if (hash && !site.hostHash) site.hostHash = hash
    })
    if ((!hadHash && site.hostHash) || site.homePath !== homeBefore) {
      await this.mutate(() => {})
    }
    return siteView(site, this.workspaceCount(site.id))
  }

  async renameSite(id: string, nextName: string): Promise<RemoteSiteView> {
    const site = this.getSite(id)
    const oldName = site.name
    const updates = this.store.workspaces
      .filter((workspace) => workspace.siteId === id)
      .map((workspace) => {
        if (workspace.name === oldName) return { workspace, suffix: '' }
        const prefix = `${oldName} · `
        if (workspace.name.startsWith(prefix)) return { workspace, suffix: workspace.name.slice(prefix.length) }
        return null
      })
      .filter((entry): entry is { workspace: RemoteWorkspaceRecord; suffix: string } => entry !== null)
      .map(({ workspace, suffix }) => ({
        workspace,
        nextName: suffix === '' ? nextName : `${nextName} · ${suffix}`,
      }))
    await this.mutate(() => {
      site.name = nextName
      site.updatedAt = nowIso()
      for (const update of updates) {
        update.workspace.name = update.nextName
        update.workspace.updatedAt = nowIso()
      }
    })
    // 同步左侧栏锚点：标题 + AGENTS.md 中的站点信息
    for (const update of updates) {
      try {
        await this.ensureLocalWorkspace(site, update.workspace)
      } catch (error) {
        this.ctx.logger?.warn?.(`[remote-workspace] rename anchor refresh failed: ${errorMessage(error)}`)
      }
    }
    return siteView(site, this.workspaceCount(site.id))
  }

  async updateSite(id: string, input: SiteUpdateInput): Promise<RemoteSiteView> {
    const site = this.getSite(id)
    const next: RemoteSiteRecord = {
      ...site,
      name: input.name?.trim() || site.name,
      host: input.host?.trim() || site.host,
      port: input.port ?? site.port,
      username: input.username?.trim() || site.username,
      auth: input.auth ?? site.auth,
    }
    const connectionChanged = next.host !== site.host
      || next.port !== site.port
      || next.username !== site.username
      || input.auth !== undefined
      || input.homePath !== undefined
    if (connectionChanged) {
      await prepareSiteConnection(next, input.homePath ?? site.homePath, (hash) => {
        if (hash) next.hostHash = hash
      })
    } else {
      next.homePath = site.homePath
    }
    await this.mutate(() => {
      const at = this.store.sites.findIndex((candidate) => candidate.id === id)
      if (at === -1) throw new Error(`remote site '${id}' not found`)
      this.store.sites[at] = { ...next, updatedAt: nowIso() }
    })
    const currentSite = this.getSite(id)
    if (input.name !== undefined && input.name.trim() !== site.name) {
      await this.renameSite(id, input.name.trim())
    } else {
      // 连接信息变化：刷新该站点全部工作区锚点里的 AGENTS.md
      for (const workspace of this.store.workspaces.filter((candidate) => candidate.siteId === id)) {
        try {
          await this.ensureLocalWorkspace(currentSite, workspace)
        } catch (error) {
          this.ctx.logger?.warn?.(`[remote-workspace] site update anchor refresh failed: ${errorMessage(error)}`)
        }
      }
    }
    return siteView(this.getSite(id), this.workspaceCount(id))
  }

  async removeSite(id: string): Promise<boolean> {
    this.getSite(id)
    const workspaces = this.store.workspaces.filter((workspace) => workspace.siteId === id)
    await this.mutate(() => {
      this.store.workspaces = this.store.workspaces.filter((workspace) => workspace.siteId !== id)
      this.store.sites = this.store.sites.filter((site) => site.id !== id)
    })
    for (const workspace of workspaces) await this.detachLocalWorkspace(workspace)
    return true
  }

  async browseSite(id: string, path?: string): Promise<{ path: string; entries: SftpEntry[] }> {
    const site = this.getSite(id)
    const target = posixNormalize(path?.trim() || site.homePath)
    return withSiteSftp(site, async (sftp) => {
      const stats = await sftpStat(sftp, target)
      if (!stats.isDirectory()) throw new Error(`'${target}' is not a directory`)
      return { path: target, entries: await sftpList(sftp, target) }
    })
  }

  async mkdirSite(id: string, parentPath: string, name: string): Promise<string> {
    const site = this.getSite(id)
    const clean = name.trim()
    if (!clean) throw new Error('folder name must not be empty')
    const target = posixNormalize(posix.join(parentPath, clean))
    return withSiteSftp(site, async (sftp) => {
      await sftpMkdir(sftp, target)
      return target
    })
  }

  /* ------------------------- workspaces ------------------------- */

  listWorkspaces(): RemoteWorkspaceView[] {
    return this.store.workspaces.map((workspace) => {
      const site = this.store.sites.find((candidate) => candidate.id === workspace.siteId)
      if (!site) throw new Error(`workspace '${workspace.id}' references missing site '${workspace.siteId}'`)
      return workspaceView(site, workspace)
    })
  }

  getWorkspace(id: string): { workspace: RemoteWorkspaceRecord; site: RemoteSiteRecord } {
    const workspace = this.store.workspaces.find((candidate) => candidate.id === id)
    if (!workspace) throw new Error(`remote workspace '${id}' not found`)
    const site = this.store.sites.find((candidate) => candidate.id === workspace.siteId)
    if (!site) throw new Error(`remote workspace '${id}' references missing site '${workspace.siteId}'`)
    return { workspace, site }
  }

  private workspaceCount(siteId: string): number {
    return this.store.workspaces.filter((workspace) => workspace.siteId === siteId).length
  }

  async addWorkspace(input: WorkspaceAddInput): Promise<RemoteWorkspaceView> {
    const site = this.getSite(input.siteId)
    const rootPath = input.rootPath?.trim()
      ? posixNormalize(input.rootPath)
      : site.homePath
    await withSiteSftp(site, async (sftp) => {
      const stats = await sftpStat(sftp, rootPath)
      if (!stats.isDirectory()) throw new Error(`remote root '${rootPath}' is not a directory`)
    })
    const workspace: RemoteWorkspaceRecord = {
      id: randomUUID(),
      siteId: site.id,
      name: input.name?.trim() || defaultWorkspaceName(site, rootPath),
      rootPath,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    await this.ensureLocalWorkspace(site, workspace)
    await this.mutate(() => {
      this.store.workspaces.unshift(workspace)
    })
    return workspaceView(site, workspace)
  }

  async ensureWorkspace(id: string): Promise<RemoteWorkspaceView> {
    const { workspace, site } = this.getWorkspace(id)
    await this.ensureLocalWorkspace(site, workspace)
    if (workspace.localWorkspaceId) await this.mutate(() => {})
    return workspaceView(site, workspace)
  }

  async renameWorkspace(id: string, nextName: string): Promise<RemoteWorkspaceView> {
    const { workspace, site } = this.getWorkspace(id)
    await this.mutate(() => {
      workspace.name = nextName.trim() || defaultWorkspaceName(site, workspace.rootPath)
      workspace.updatedAt = nowIso()
    })
    try {
      await this.setLocalWorkspaceTitle(workspace)
    } catch (error) {
      this.ctx.logger?.warn?.(`[remote-workspace] rename anchor title failed: ${errorMessage(error)}`)
    }
    return workspaceView(site, workspace)
  }

  async removeWorkspace(id: string): Promise<boolean> {
    const { workspace } = this.getWorkspace(id)
    await this.mutate(() => {
      this.store.workspaces = this.store.workspaces.filter((candidate) => candidate.id !== id)
    })
    await this.detachLocalWorkspace(workspace)
    return true
  }

  async testWorkspace(id: string): Promise<RemoteWorkspaceView> {
    const { workspace, site } = this.getWorkspace(id)
    await withSiteSftp(site, async (sftp) => {
      const stats = await sftpStat(sftp, workspace.rootPath)
      if (!stats.isDirectory()) throw new Error(`remote root '${workspace.rootPath}' is not a directory`)
    })
    return workspaceView(site, workspace)
  }

  browseWorkspace(id: string, relPath?: string): Promise<{ path: string; entries: SftpEntry[] }> {
    const { workspace, site } = this.getWorkspace(id)
    const path = resolveRemotePath(workspace.rootPath, relPath)
    return withSiteSftp(site, async (sftp) => {
      const stats = await sftpStat(sftp, path)
      if (!stats.isDirectory()) throw new Error(`'${path}' is not a directory`)
      return { path, entries: await sftpList(sftp, path) }
    })
  }

  readWorkspace(
    id: string,
    relPath: string,
    maxBytes = DEFAULT_MAX_READ_BYTES,
  ): Promise<{ path: string; size: number; encoding: 'utf8' | 'base64'; content: string }> {
    const { workspace, site } = this.getWorkspace(id)
    const path = resolveRemotePath(workspace.rootPath, relPath)
    if (maxBytes > MAX_BODY_BYTES) maxBytes = MAX_BODY_BYTES
    return withSiteSftp(site, async (sftp) => {
      const stats = await sftpStat(sftp, path)
      if (!stats.isFile()) throw new Error(`'${path}' is not a file`)
      if (stats.size > maxBytes) {
        throw new Error(`file is ${stats.size} bytes, exceeds maxBytes=${maxBytes}`)
      }
      const result = await sftpReadText(sftp, path, maxBytes)
      return { path, size: result.size, encoding: result.encoding, content: result.content }
    })
  }

  writeWorkspace(
    id: string,
    relPath: string,
    content: string,
    encoding: 'utf8' | 'base64' = 'utf8',
  ): Promise<{ path: string; bytes: number }> {
    const { workspace, site } = this.getWorkspace(id)
    const path = resolveRemotePath(workspace.rootPath, relPath)
    const buffer = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8')
    if (buffer.length > MAX_BODY_BYTES) {
      throw new Error(`content is ${buffer.length} bytes, exceeds ${MAX_BODY_BYTES}`)
    }
    return withSiteSftp(site, async (sftp) => {
      await sftpWrite(sftp, path, buffer)
      return { path, bytes: buffer.length }
    })
  }

  /* --------------------- local anchor bridges --------------------- */

  private async ensureLocalWorkspace(site: RemoteSiteRecord, workspace: RemoteWorkspaceRecord): Promise<LocalWorkspaceEntity> {
    const anchor = anchorDir(workspace.id)
    mkdirSync(anchor, { recursive: true, mode: 0o700 })
    const instructions = anchorInstructions(site, workspace)
    const instructionFile = join(anchor, 'AGENTS.md')
    let dirty = false
    try {
      dirty = readFileSync(instructionFile, 'utf8') !== instructions
    } catch {
      dirty = true
    }
    if (dirty) writeFileSync(instructionFile, instructions, { mode: 0o600 })

    let entity = workspace.localWorkspaceId
      ? this.ctx.workspaceRegistry.get(workspace.localWorkspaceId)
      : undefined
    if (entity === undefined || entity.path !== anchor) {
      entity = await this.ctx.workspaceRegistry.resolveByPath(anchor)
        ?? await this.ctx.workspaceRegistry.create(anchor, workspace.name)
    }
    workspace.localWorkspaceId = entity.id
    if (entity.title !== workspace.name) await entity.setTitle(workspace.name)
    return entity
  }

  private async setLocalWorkspaceTitle(workspace: RemoteWorkspaceRecord): Promise<void> {
    if (!workspace.localWorkspaceId) return
    const entity = this.ctx.workspaceRegistry.get(workspace.localWorkspaceId)
    if (entity && entity.title !== workspace.name) await entity.setTitle(workspace.name)
  }

  private async detachLocalWorkspace(workspace: RemoteWorkspaceRecord): Promise<void> {
    if (workspace.localWorkspaceId) {
      try {
        await this.ctx.workspaceRegistry.delete(workspace.localWorkspaceId)
      } catch (error) {
        this.ctx.logger?.warn?.(`[remote-workspace] failed to delete anchor workspace '${workspace.localWorkspaceId}': ${errorMessage(error)}`)
      }
    }
    // 锚点目录保留（历史 session 的 cwd 仍有效），只移除远程指令文件
    try {
      rmSync(join(anchorDir(workspace.id), 'AGENTS.md'), { force: true })
    } catch { /* ignore */ }
  }

  async reconcile(): Promise<void> {
    let dirty = false
    for (const workspace of this.store.workspaces) {
      const site = this.store.sites.find((candidate) => candidate.id === workspace.siteId)
      if (!site) {
        this.ctx.logger?.warn?.(`[remote-workspace] workspace '${workspace.id}' references missing site '${workspace.siteId}', skipped`)
        continue
      }
      try {
        await this.ensureLocalWorkspace(site, workspace)
        dirty = true
      } catch (error) {
        this.ctx.logger?.warn?.(`[remote-workspace] anchor reconcile failed for '${workspace.id}': ${errorMessage(error)}`)
      }
    }
    if (dirty) saveStoreAtomic(this.store)
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 参数解析                                                       */
/* ------------------------------------------------------------------ */

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = encodeJson(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(body.length),
  })
  res.end(body)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function requireString(value: unknown, field: string, fallback?: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (fallback !== undefined) return fallback
  throw new Error(`field '${field}' must be a non-empty string`)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requirePort(value: unknown, fallback = 22): number {
  const port = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('field port must be an integer in 1..65535')
  return port
}

function parseAuth(body: Record<string, unknown>): AuthConfig {
  const kind = typeof body.authKind === 'string' ? body.authKind : 'password'
  if (kind === 'privateKey') {
    return {
      kind: 'privateKey',
      privateKeyPath: requireString(body.privateKeyPath, 'privateKeyPath'),
      ...(typeof body.passphrase === 'string' && body.passphrase ? { passphrase: body.passphrase } : {}),
    }
  }
  if (kind === 'agent') return { kind: 'agent' }
  return {
    kind: 'password',
    password: requireString(body.password, 'password'),
  }
}

function bodyAuth(body: Record<string, unknown>): AuthConfig | undefined {
  if (typeof body.authKind !== 'string' || body.authKind === '') return undefined
  return parseAuth(body)
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx: AppContext): void {
  const service = new RemoteService(ctx)
  void service.reconcile().catch((error) => {
    ctx.logger?.warn?.(`[remote-workspace] startup reconcile failed: ${errorMessage(error)}`)
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefixes',
    path: API_PREFIX,
    async handler(req, res) {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const pathname = url.pathname
        const method = req.method ?? 'GET'

        if (pathname === `${API_PREFIX}/ping` && method === 'GET') {
          sendJson(res, 200, { ok: true, value: { name, time: nowIso() } })
          return
        }

        /* ----- sites ----- */

        if (pathname === `${API_PREFIX}/sites/list` && method === 'GET') {
          sendJson(res, 200, { ok: true, value: service.listSites() })
          return
        }

        if (pathname === `${API_PREFIX}/sites/add` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          const value = await service.addSite({
            name: optionalString(body.name),
            host: requireString(body.host, 'host'),
            port: requirePort(body.port),
            username: requireString(body.username, 'username'),
            homePath: optionalString(body.homePath),
            auth: parseAuth(body),
          })
          sendJson(res, 200, { ok: true, value })
          return
        }

        if (pathname === `${API_PREFIX}/sites/test` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          sendJson(res, 200, { ok: true, value: await service.testSite(requireString(body.id, 'id')) })
          return
        }

        if (pathname === `${API_PREFIX}/sites/rename` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          sendJson(res, 200, { ok: true, value: await service.renameSite(requireString(body.id, 'id'), requireString(body.name, 'name')) })
          return
        }

        if (pathname === `${API_PREFIX}/sites/update` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          const value = await service.updateSite(requireString(body.id, 'id'), {
            name: optionalString(body.name),
            host: optionalString(body.host),
            port: body.port === undefined ? undefined : requirePort(body.port),
            username: optionalString(body.username),
            homePath: optionalString(body.homePath),
            auth: bodyAuth(body),
          })
          sendJson(res, 200, { ok: true, value })
          return
        }

        if (pathname === `${API_PREFIX}/sites/remove` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          sendJson(res, 200, { ok: true, value: await service.removeSite(requireString(body.id, 'id')) })
          return
        }

        if (pathname === `${API_PREFIX}/sites/browse` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          const value = await service.browseSite(
            requireString(body.id, 'id'),
            optionalString(body.path),
          )
          sendJson(res, 200, { ok: true, value })
          return
        }

        if (pathname === `${API_PREFIX}/sites/mkdir` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          const value = await service.mkdirSite(
            requireString(body.id, 'id'),
            requireString(body.path, 'path', '/'),
            requireString(body.name, 'name'),
          )
          sendJson(res, 200, { ok: true, value })
          return
        }

        /* ----- workspaces ----- */

        if (pathname === `${API_PREFIX}/workspaces/list` && method === 'GET') {
          sendJson(res, 200, { ok: true, value: service.listWorkspaces() })
          return
        }

        if (pathname === `${API_PREFIX}/workspaces/add` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          const value = await service.addWorkspace({
            siteId: requireString(body.siteId, 'siteId'),
            rootPath: optionalString(body.rootPath),
            name: optionalString(body.name),
          })
          sendJson(res, 200, { ok: true, value })
          return
        }

        if (pathname === `${API_PREFIX}/workspaces/ensure` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          sendJson(res, 200, { ok: true, value: await service.ensureWorkspace(requireString(body.id, 'id')) })
          return
        }

        if (pathname === `${API_PREFIX}/workspaces/rename` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          sendJson(res, 200, { ok: true, value: await service.renameWorkspace(requireString(body.id, 'id'), requireString(body.name, 'name')) })
          return
        }

        if (pathname === `${API_PREFIX}/workspaces/remove` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          sendJson(res, 200, { ok: true, value: await service.removeWorkspace(requireString(body.id, 'id')) })
          return
        }

        if (pathname === `${API_PREFIX}/workspaces/test` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          sendJson(res, 200, { ok: true, value: await service.testWorkspace(requireString(body.id, 'id')) })
          return
        }

        if (pathname === `${API_PREFIX}/workspaces/browse` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          const value = await service.browseWorkspace(
            requireString(body.id, 'id'),
            optionalString(body.path),
          )
          sendJson(res, 200, { ok: true, value })
          return
        }

        if (pathname === `${API_PREFIX}/workspaces/read` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          const maxBytes = body.maxBytes === undefined ? DEFAULT_MAX_READ_BYTES : Number(body.maxBytes)
          const value = await service.readWorkspace(
            requireString(body.id, 'id'),
            requireString(body.path, 'path'),
            Number.isFinite(maxBytes) ? maxBytes : DEFAULT_MAX_READ_BYTES,
          )
          sendJson(res, 200, { ok: true, value })
          return
        }

        if (pathname === `${API_PREFIX}/workspaces/write` && method === 'POST') {
          const body = (await readJsonBody(req)) as Record<string, unknown>
          const value = await service.writeWorkspace(
            requireString(body.id, 'id'),
            requireString(body.path, 'path'),
            requireString(body.content, 'content', ''),
            body.encoding === 'base64' ? 'base64' : 'utf8',
          )
          sendJson(res, 200, { ok: true, value })
          return
        }

        sendJson(res, 404, apiError(new Error(`unknown remote-workspace API route: ${method} ${pathname}`), 'not-found'))
      } catch (error) {
        sendJson(res, 500, apiError(error))
      }
    },
  }), '@dsh-external/dsh-remote-workspace: http api')

  /* ------------------------------ tools ------------------------------ */

  const tool = (
    toolName: string,
    description: string,
    parameters: unknown,
    execute: (args: any) => Promise<string>,
  ) =>
    defineTool({
      name: toolName,
      description,
      parameters,
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      execute: (args: any) => execute(args),
    } as any)

  const register = (toolName: string, description: string, parameters: unknown, execute: (args: any) => Promise<string>) =>
    ctx.tools.register(tool(toolName, description, parameters, execute))

  const authParameters = {
    authKind: { type: 'string', enum: ['password', 'privateKey', 'agent'], description: '认证方式，默认 password' },
    password: { type: 'string', description: 'authKind=password 时的密码' },
    privateKeyPath: { type: 'string', description: 'authKind=privateKey 时的宿主机私钥路径' },
    passphrase: { type: 'string', description: '私钥口令（可选）' },
  }

  ctx.effect(() => {
    const disposers: Array<() => void> = []

    disposers.push(register(
      'remote_site_list',
      '列出已配置的远程站点（SSH/SFTP 连接），不含敏感凭据。',
      {},
      async () => JSON.stringify(service.listSites(), null, 2),
    ))

    disposers.push(register(
      'remote_site_add',
      '添加一个 SSH/SFTP 远程站点（连接配置，会测试连接）。homePath 留空时自动使用服务器真实家目录。',
      {
        name: { type: 'string', description: '站点名称（缺省为 username@host）' },
        host: { type: 'string', required: true, description: '远程主机名或 IP' },
        port: { type: 'number', description: 'SSH 端口，默认 22' },
        username: { type: 'string', required: true, description: 'SSH 用户名' },
        homePath: { type: 'string', description: '远程家目录；留空自动解析' },
        ...authParameters,
      },
      async (args: any) => JSON.stringify(await service.addSite({
        name: args.name,
        host: String(args.host),
        port: args.port === undefined ? 22 : Number(args.port),
        username: String(args.username),
        homePath: args.homePath,
        auth: parseAuth({ ...args }),
      }), null, 2),
    ))

    disposers.push(register(
      'remote_site_test',
      '测试一个远程站点的 SSH/SFTP 连接与家目录可达性。',
      {
        id: { type: 'string', required: true, description: '远程站点 id' },
      },
      async (args: any) => JSON.stringify(await service.testSite(String(args.id)), null, 2),
    ))

    disposers.push(register(
      'remote_site_rename',
      '重命名一个远程站点（关联的自动命名工作区会同步改名）。',
      {
        id: { type: 'string', required: true, description: '远程站点 id' },
        name: { type: 'string', required: true, description: '新名称' },
      },
      async (args: any) => JSON.stringify(await service.renameSite(String(args.id), String(args.name)), null, 2),
    ))

    disposers.push(register(
      'remote_site_update',
      '更新远程站点连接信息（主机/端口/用户名/认证/家目录）。authKind 及其对应字段会替换认证配置。',
      {
        id: { type: 'string', required: true, description: '远程站点 id' },
        name: { type: 'string', description: '新站点名称' },
        host: { type: 'string', description: '新主机名或 IP' },
        port: { type: 'number', description: '新 SSH 端口' },
        username: { type: 'string', description: '新用户名' },
        homePath: { type: 'string', description: '新家目录；留空自动解析' },
        ...authParameters,
      },
      async (args: any) => JSON.stringify(await service.updateSite(String(args.id), {
        name: args.name,
        host: args.host,
        port: args.port === undefined ? undefined : Number(args.port),
        username: args.username,
        homePath: args.homePath,
        auth: bodyAuth(args as Record<string, unknown>),
      }), null, 2),
    ))

    disposers.push(register(
      'remote_site_remove',
      '移除一个远程站点及其全部远程工作区配置（不删除服务器文件；历史会话保留为未分组）。',
      {
        id: { type: 'string', required: true, description: '远程站点 id' },
      },
      async (args: any) => String(await service.removeSite(String(args.id))),
    ))

    disposers.push(register(
      'remote_site_browse',
      '浏览远程站点上的目录（用于选择工作区目录）。path 省略时从站点家目录开始。',
      {
        id: { type: 'string', required: true, description: '远程站点 id' },
        path: { type: 'string', description: '远程目录绝对路径；不传为站点家目录' },
      },
      async (args: any) => JSON.stringify(await service.browseSite(String(args.id), args.path), null, 2),
    ))

    disposers.push(register(
      'remote_workspace_list',
      '列出已配置的远程工作区（站点 + 远程目录），不含敏感凭据。',
      {},
      async () => JSON.stringify(service.listWorkspaces(), null, 2),
    ))

    disposers.push(register(
      'remote_workspace_add',
      '在远程站点上创建一个远程工作区（左侧栏会出现对应分组）。rootPath 留空使用站点家目录。',
      {
        siteId: { type: 'string', required: true, description: '远程站点 id（见 remote_site_list）' },
        rootPath: { type: 'string', description: '远程目录绝对路径；不传为站点家目录' },
        name: { type: 'string', description: '工作区显示名（缺省自动生成）' },
      },
      async (args: any) => JSON.stringify(await service.addWorkspace({
        siteId: String(args.siteId),
        rootPath: args.rootPath,
        name: args.name,
      }), null, 2),
    ))

    disposers.push(register(
      'remote_workspace_browse',
      '浏览远程工作区的目录。path 省略或传工作区根路径；返回目录项（目录/文件/大小/时间）。',
      {
        id: { type: 'string', required: true, description: '远程工作区 id（见 remote_workspace_list）' },
        path: { type: 'string', description: '远程目录绝对路径；不传为工作区根目录' },
      },
      async (args: any) => JSON.stringify(await service.browseWorkspace(String(args.id), args.path), null, 2),
    ))

    disposers.push(register(
      'remote_workspace_read',
      '读取远程工作区里的文件。文本文件返回 utf8 内容；二进制文件返回 base64 并标注 encoding。',
      {
        id: { type: 'string', required: true, description: '远程工作区 id' },
        path: { type: 'string', required: true, description: '远程文件绝对路径' },
        maxBytes: { type: 'number', description: '读取上限，默认 2MB' },
      },
      async (args: any) => JSON.stringify(await service.readWorkspace(
        String(args.id),
        String(args.path),
        args.maxBytes === undefined ? DEFAULT_MAX_READ_BYTES : Number(args.maxBytes),
      ), null, 2),
    ))

    disposers.push(register(
      'remote_workspace_write',
      '把内容写入远程工作区的文件（覆盖写）。encoding 默认 utf8，可选 base64。',
      {
        id: { type: 'string', required: true, description: '远程工作区 id' },
        path: { type: 'string', required: true, description: '远程文件绝对路径' },
        content: { type: 'string', required: true, description: '文件内容' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: '内容编码，默认 utf8' },
      },
      async (args: any) => JSON.stringify(await service.writeWorkspace(
        String(args.id),
        String(args.path),
        String(args.content),
        args.encoding === 'base64' ? 'base64' : 'utf8',
      ), null, 2),
    ))

    disposers.push(register(
      'remote_workspace_test',
      '测试一个远程工作区的根目录可达性。',
      {
        id: { type: 'string', required: true, description: '远程工作区 id' },
      },
      async (args: any) => JSON.stringify(await service.testWorkspace(String(args.id)), null, 2),
    ))

    disposers.push(register(
      'remote_workspace_remove',
      '移除一个远程工作区（只删除左侧栏分组配置；历史会话保留为未分组，不删除服务器文件）。',
      {
        id: { type: 'string', required: true, description: '远程工作区 id' },
      },
      async (args: any) => {
        const removed = await service.removeWorkspace(String(args.id))
        return removed ? `removed ${args.id}` : `workspace ${args.id} was not registered`
      },
    ))

    return disposers
  }, '@dsh-external/dsh-remote-workspace: tools')

  ctx.logger?.info?.('[remote-workspace] plugin ready')
}
