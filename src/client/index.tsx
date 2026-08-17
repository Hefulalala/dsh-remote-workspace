/**
 * @dsh-external/dsh-remote-workspace — 客户端。
 *
 * 1. 左下角“远程站点”面板：管理 SSH/SFTP 连接（添加/测试/编辑/删除）。
 * 2. 统一“添加工作区”流：shadow 系统 directory-flow 插槽，
 *    第一步选择连接（本地 / 远程站点 / 新建站点），第二步选目录。
 *    - 本地：复用系统 BrowseDirectoryFlow
 *    - 远程：SFTP 目录选择器，默认从站点家目录开始
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

type AuthKind = 'password' | 'privateKey' | 'agent'

type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

interface SiteView {
  id: string
  name: string
  host: string
  port: number
  username: string
  homePath: string
  authKind: AuthKind
  endpoint: string
  workspaceCount: number
  createdAt: string
  updatedAt: string
}

interface WorkspaceView {
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

interface RemoteEntry {
  name: string
  path: string
  type: 'd' | 'l' | 'f' | 'other'
  size: number
  mtime: number
  mode: number
}

interface DirectoryFlowOwnerProps {
  open: boolean
  busy: boolean
  onPicked: (path: string) => void
  onCancel: () => void
  onError: (message: string) => void
}

type SlotsLike = {
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
  register(options: unknown, component: unknown): () => void
}

type AppContext = {
  slots: SlotsLike
  workspaces: {
    startSession(workspaceId: string): void
    listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListingLike>
    createDirectory(path: string, name: string): Promise<string>
  }
}

export const inject = ['slots', 'workspaces']

interface DirectoryEntryLike {
  name: string
  path: string
  hidden: boolean
}

interface DirectoryListingLike {
  path: string
  home: string
  crumbs: DirectoryEntryLike[]
  entries: DirectoryEntryLike[]
  truncated: boolean
}

/* ------------------------------------------------------------------ */
/* HTTP 客户端                                                         */
/* ------------------------------------------------------------------ */

const API_BASE = '/remote-workspaces/api'

async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = (await response.json()) as ApiResult<T>
  if (!payload.ok) {
    throw new Error(payload.error?.message ?? `HTTP ${response.status}`)
  }
  return payload.value
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  if (at <= 0) return '/'
  return trimmed.slice(0, at) || '/'
}

/* ------------------------------------------------------------------ */
/* 样式                                                                */
/* ------------------------------------------------------------------ */

const palette = {
  border: '1px solid rgba(127,127,127,.28)',
  borderSoft: '1px solid rgba(127,127,127,.16)',
  text: 'var(--dsw-alias-label-primary, #e7e7e7)',
  secondary: 'var(--dsw-alias-label-secondary, #b8b8b8)',
  tertiary: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
  bg: 'var(--dsw-alias-bg-base, #1c1c1e)',
  bgHover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))',
  accent: 'var(--dsw-alias-state-business-primary, #4c8dff)',
  danger: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
  success: 'var(--dsw-alias-state-success-primary, #3fb27f)',
}

const S = {
  trigger: (wide: boolean): CSSProperties => ({
    width: wide ? '100%' : 36,
    height: wide ? 40 : 36,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: wide ? 'flex-start' : 'center',
    gap: 8,
    padding: wide ? '8px 12px' : 0,
    border: wide ? palette.borderSoft : 'none',
    borderRadius: wide ? 12 : 18,
    background: 'transparent',
    color: palette.text,
    cursor: 'pointer',
    fontSize: 14,
  }),
  panel: {
    position: 'fixed' as const,
    zIndex: 30,
    left: 12,
    bottom: 128,
    width: 440,
    maxWidth: 'calc(100vw - 24px)',
    maxHeight: '72vh',
    display: 'flex',
    flexDirection: 'column' as const,
    border: palette.border,
    borderRadius: 12,
    background: palette.bg,
    boxShadow: '0 12px 32px rgba(0,0,0,.35)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    padding: '10px 12px',
    borderBottom: palette.borderSoft,
  },
  title: { fontSize: 13, fontWeight: 600 as const, color: palette.text },
  iconButton: {
    width: 26,
    height: 26,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: 999,
    background: 'transparent',
    color: palette.tertiary,
    cursor: 'pointer',
    fontSize: 14,
  },
  body: { flex: 1, minHeight: 0, overflowY: 'auto' as const, padding: '10px 12px' },
  sectionTitle: {
    margin: '10px 0 6px',
    fontSize: 11,
    fontWeight: 600 as const,
    color: palette.tertiary,
    textTransform: 'uppercase' as const,
    letterSpacing: '.04em',
  },
  row: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    padding: '9px 10px',
    border: palette.borderSoft,
    borderRadius: 10,
    marginBottom: 8,
  },
  rowHead: { display: 'flex', alignItems: 'center', gap: 8 },
  rowName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, fontSize: 13, color: palette.text, fontWeight: 600 as const },
  rowMeta: { fontSize: 11, color: palette.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  badge: {
    fontSize: 10,
    padding: '1px 7px',
    borderRadius: 999,
    color: palette.tertiary,
    background: palette.bgHover,
  },
  actions: { display: 'flex', gap: 6, flexWrap: 'wrap' as const },
  button: (primary = false, danger = false): CSSProperties => ({
    border: palette.borderSoft,
    borderRadius: 999,
    padding: '3px 10px',
    fontSize: 11,
    cursor: 'pointer',
    background: primary ? palette.accent : 'transparent',
    color: primary ? '#fff' : danger ? palette.danger : palette.secondary,
  }),
  input: {
    width: '100%',
    boxSizing: 'border-box' as const,
    height: 30,
    padding: '4px 9px',
    border: palette.border,
    borderRadius: 8,
    background: 'rgba(0,0,0,.2)',
    color: palette.text,
    fontSize: 12,
  },
  label: { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: 11, color: palette.tertiary },
  banner: (kind: 'error' | 'info'): CSSProperties => ({
    margin: '8px 0',
    padding: '7px 9px',
    borderRadius: 8,
    fontSize: 12,
    color: kind === 'error' ? palette.danger : palette.success,
    background: kind === 'error' ? 'rgba(255,107,107,.12)' : 'rgba(63,178,127,.12)',
  }),
  empty: { margin: '12px 0', fontSize: 12, color: palette.tertiary, lineHeight: 1.6 },
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,.45)',
    padding: 16,
  },
  modal: {
    width: 520,
    maxWidth: '100%',
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column' as const,
    border: palette.border,
    borderRadius: 12,
    background: palette.bg,
    boxShadow: '0 18px 48px rgba(0,0,0,.5)',
    overflow: 'hidden',
  },
  choiceRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '10px 12px',
    border: palette.borderSoft,
    borderRadius: 10,
    marginBottom: 8,
    background: 'transparent',
    color: palette.text,
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  choiceTitle: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 as const, color: palette.text },
  choiceMeta: { fontSize: 11, color: palette.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  breadcrumb: { display: 'flex', alignItems: 'center', gap: 6, margin: '8px 0', fontSize: 11, color: palette.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  dirRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '6px 8px',
    border: 'none',
    borderRadius: 8,
    background: 'transparent',
    color: palette.text,
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontSize: 12,
  },
  footer: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderTop: palette.borderSoft },
}

/* ------------------------------------------------------------------ */
/* 站点表单                                                            */
/* ------------------------------------------------------------------ */

interface SiteFormValue {
  name: string
  host: string
  port: string
  username: string
  homePath: string
  authKind: AuthKind
  password: string
  privateKeyPath: string
  passphrase: string
}

const EMPTY_SITE: SiteFormValue = {
  name: '',
  host: '',
  port: '22',
  username: '',
  homePath: '',
  authKind: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: '',
}

function SiteForm({ initial, submitLabel, busy, onSubmit, onCancel }: {
  initial?: SiteFormValue
  submitLabel: string
  busy: boolean
  onSubmit(value: SiteFormValue): void | Promise<void>
  onCancel(): void
}) {
  const [form, setForm] = useState<SiteFormValue>(initial ?? EMPTY_SITE)
  const valid = form.host.trim() !== '' && form.username.trim() !== ''
    && (form.authKind !== 'password' || form.password !== '')
    && (form.authKind !== 'privateKey' || form.privateKeyPath.trim() !== '')
  return (
    <div style={S.row}>
      <label style={S.label}>站点名称
        <input style={S.input} value={form.name} placeholder="可选，默认 user@host" onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <label style={{ ...S.label, flex: 1 }}>主机
          <input style={S.input} value={form.host} placeholder="example.com" onChange={(event) => setForm({ ...form, host: event.target.value })} />
        </label>
        <label style={{ ...S.label, width: 72 }}>端口
          <input style={S.input} value={form.port} onChange={(event) => setForm({ ...form, port: event.target.value })} />
        </label>
      </div>
      <label style={S.label}>用户名
        <input style={S.input} value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
      </label>
      <label style={S.label}>远程家目录（绝对路径，留空 = 自动使用服务器家目录）
        <input style={S.input} value={form.homePath} placeholder="例如 /home/user" onChange={(event) => setForm({ ...form, homePath: event.target.value })} />
      </label>
      <label style={S.label}>认证方式
        <select style={S.input} value={form.authKind} onChange={(event) => setForm({ ...form, authKind: event.target.value as AuthKind })}>
          <option value="password">密码</option>
          <option value="privateKey">私钥文件（宿主机路径）</option>
          <option value="agent">SSH Agent</option>
        </select>
      </label>
      {form.authKind === 'password' ? (
        <label style={S.label}>密码
          <input style={S.input} type="password" value={form.password} placeholder={initial ? '留空 = 保持原密码' : ''} onChange={(event) => setForm({ ...form, password: event.target.value })} />
        </label>
      ) : null}
      {form.authKind === 'privateKey' ? (
        <>
          <label style={S.label}>私钥路径
            <input style={S.input} value={form.privateKeyPath} placeholder="~/.ssh/id_ed25519（写绝对路径）" onChange={(event) => setForm({ ...form, privateKeyPath: event.target.value })} />
          </label>
          <label style={S.label}>私钥口令（可选）
            <input style={S.input} type="password" value={form.passphrase} onChange={(event) => setForm({ ...form, passphrase: event.target.value })} />
          </label>
        </>
      ) : null}
      {form.authKind === 'agent' ? (
        <div style={{ fontSize: 11, color: palette.tertiary }}>使用 DSH 宿主进程的 SSH_AUTH_SOCK。</div>
      ) : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={S.button(Boolean(true))} disabled={busy || !valid} onClick={() => void onSubmit(form)}>{submitLabel}</button>
        <button type="button" style={S.button()} disabled={busy} onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}

function siteFormValue(site: SiteView): SiteFormValue {
  return {
    name: site.name,
    host: site.host,
    port: String(site.port),
    username: site.username,
    homePath: site.homePath,
    authKind: site.authKind,
    password: '',
    privateKeyPath: '',
    passphrase: '',
  }
}

/* ------------------------------------------------------------------ */
/* 左下角：远程站点面板                                                 */
/* ------------------------------------------------------------------ */

function RemoteSitePanel({ wide }: { wide?: boolean }) {
  const [open, setOpen] = useState(false)
  const [sites, setSites] = useState<SiteView[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<SiteView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [formKey, setFormKey] = useState(0)

  const refresh = useCallback(async () => {
    setSites(await api<SiteView[]>('sites/list'))
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    setInfo(null)
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }, [])

  const addSite = async (form: SiteFormValue) => {
    await run('添加并测试连接', async () => {
      await api<SiteView>('sites/add', {
        name: form.name.trim() || undefined,
        host: form.host.trim(),
        port: Number(form.port || 22),
        username: form.username.trim(),
        homePath: form.homePath.trim() || undefined,
        authKind: form.authKind,
        password: form.authKind === 'password' ? form.password : undefined,
        privateKeyPath: form.authKind === 'privateKey' ? form.privateKeyPath.trim() : undefined,
        passphrase: form.authKind === 'privateKey' && form.passphrase ? form.passphrase : undefined,
      })
      setShowForm(false)
      setFormKey((key) => key + 1)
      await refresh()
    })
  }

  const updateSite = async (form: SiteFormValue) => {
    if (!editing) return
    await run('保存连接', async () => {
      const patch: Record<string, unknown> = {
        id: editing.id,
        name: form.name.trim() || undefined,
        host: form.host.trim(),
        port: Number(form.port || 22),
        username: form.username.trim(),
        homePath: form.homePath.trim() || undefined,
      }
      const authChanged = form.authKind !== editing.authKind
        || (form.authKind === 'password' && form.password !== '')
        || (form.authKind === 'privateKey' && form.privateKeyPath.trim() !== '')
      if (authChanged) {
        patch.authKind = form.authKind
        patch.password = form.authKind === 'password' ? form.password : undefined
        patch.privateKeyPath = form.authKind === 'privateKey' ? form.privateKeyPath.trim() : undefined
        patch.passphrase = form.authKind === 'privateKey' && form.passphrase ? form.passphrase : undefined
      }
      await api<SiteView>('sites/update', patch)
      setEditing(null)
      setFormKey((key) => key + 1)
      await refresh()
    })
  }

  const testSite = async (site: SiteView) => {
    await run(`测试 ${site.name}`, async () => {
      const view = await api<SiteView>('sites/test', { id: site.id })
      setInfo(`连接正常：${view.endpoint}，家目录 ${view.homePath}`)
    })
  }

  const removeSite = async (site: SiteView) => {
    if (!window.confirm(`删除远程站点“${site.name}”？\n将同时移除它名下的 ${site.workspaceCount} 个远程工作区左侧栏分组；历史会话保留，远程文件不会被删除。`)) return
    await run('删除站点', async () => {
      await api<boolean>('sites/remove', { id: site.id })
      if (editing?.id === site.id) setEditing(null)
      await refresh()
    })
  }

  return (
    <>
      <button
        type="button"
        style={S.trigger(Boolean(wide))}
        aria-label="远程站点"
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={(event) => { event.currentTarget.style.background = palette.bgHover }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent' }}
      >
        <span style={{ fontSize: wide ? 14 : 16 }} aria-hidden>🌐</span>
        {wide ? <span>远程站点</span> : null}
      </button>

      {open ? (
        <div style={S.panel} role="dialog" aria-label="远程站点面板">
          <div style={S.header}>
            <span style={S.title}>远程站点 · SSH 连接管理</span>
            <button type="button" style={S.iconButton} aria-label="关闭" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div style={S.body}>
            {busy ? <div style={S.banner('info')}>{busy}…</div> : null}
            {error ? <div style={S.banner('error')}>{error}</div> : null}
            {info && !busy ? <div style={S.banner('info')}>{info}</div> : null}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={S.sectionTitle}>已配置站点（{sites.length}）</div>
              <button type="button" style={S.button(Boolean(true))} onClick={() => { setShowForm((value) => !value); setEditing(null) }}>
                {showForm || editing ? '收起' : '+ 添加站点'}
              </button>
            </div>

            {showForm || editing ? (
              <SiteForm
                key={formKey}
                initial={editing ? siteFormValue(editing) : undefined}
                submitLabel={editing ? '保存并测试连接' : '测试连接并添加'}
                busy={busy !== null}
                onSubmit={(form) => (editing ? void updateSite(form) : void addSite(form))}
                onCancel={() => { setShowForm(false); setEditing(null) }}
              />
            ) : null}

            {sites.length === 0 ? (
              <div style={S.empty}>还没有远程站点。点击“+ 添加站点”配置 SSH/SFTP 连接。工作区请在左侧栏的“添加工作区”里统一创建。</div>
            ) : (
              sites.map((site) => (
                <div key={site.id} style={S.row}>
                  <div style={S.rowHead}>
                    <span style={S.rowName}>{site.name}</span>
                    <span style={S.badge}>{site.authKind === 'password' ? '密码' : site.authKind === 'privateKey' ? '私钥' : 'agent'}</span>
                    <span style={S.badge}>{site.workspaceCount} 个工作区</span>
                  </div>
                  <div style={S.rowMeta}>{site.endpoint}</div>
                  <div style={S.rowMeta}>家目录：{site.homePath}</div>
                  <div style={S.actions}>
                    <button type="button" style={S.button()} onClick={() => { setEditing(site); setShowForm(false) }}>编辑</button>
                    <button type="button" style={S.button()} onClick={() => void testSite(site)}>测试</button>
                    <button type="button" style={S.button(false, true)} onClick={() => void removeSite(site)}>删除</button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}


/* ------------------------------------------------------------------ */
/* 本地目录选择器（统一流第二步）                                        */
/* ------------------------------------------------------------------ */

function LocalDirectoryPicker({ busy, onPickPath, onBack, onCancel, listDirectory, createDirectory }: {
  busy: boolean
  onPickPath(path: string): void
  onBack(): void
  onCancel(): void
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListingLike>
  createDirectory(path: string, name: string): Promise<string>
}) {
  const [listing, setListing] = useState<DirectoryListingLike | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async (target?: string) => {
    setLoading(true)
    setError(null)
    try {
      setListing(await listDirectory(target))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [listDirectory])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div>
      <div style={S.breadcrumb}>
        {listing?.crumbs.map((crumb, index) => (
          <span key={crumb.path}>
            {index > 0 ? <span style={{ color: palette.tertiary }}> / </span> : null}
            <button type="button" style={{ ...S.dirRow, width: 'auto', padding: '2px 4px' }} disabled={loading} onClick={() => void load(crumb.path)}>{crumb.name || '/'}</button>
          </span>
        ))}
      </div>
      {loading ? <div style={S.banner('info')}>加载目录…</div> : null}
      {error ? <div style={S.banner('error')}>{error}</div> : null}
      <div style={{ border: palette.borderSoft, borderRadius: 10, overflow: 'hidden', maxHeight: 300, overflowY: 'auto' }}>
        {(listing?.entries ?? []).map((entry) => (
          <button
            key={entry.path}
            type="button"
            style={S.dirRow}
            onMouseEnter={(event) => { event.currentTarget.style.background = palette.bgHover }}
            onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent' }}
            onClick={() => void load(entry.path)}
          >
            <span aria-hidden>📁</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
          </button>
        ))}
        {(listing?.entries.length ?? 0) === 0 && !loading ? <div style={{ ...S.empty, margin: 8 }}>没有子目录</div> : null}
      </div>
      <div style={S.footer}>
        <button type="button" style={S.button()} disabled={loading || creating} onClick={() => {
          const name = window.prompt('新文件夹名称')
          if (!name?.trim() || !listing) return
          setCreating(true)
          createDirectory(listing.path, name.trim())
            .then(() => load(listing.path))
            .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
            .finally(() => setCreating(false))
        }}>新建文件夹</button>
        <span style={{ flex: 1 }} />
        <button type="button" style={S.button()} disabled={loading || creating || busy} onClick={onBack}>← 连接</button>
        <button type="button" style={S.button()} disabled={busy || creating} onClick={onCancel}>取消</button>
        <button type="button" style={S.button(Boolean(true))} disabled={loading || creating || busy || !listing} onClick={() => listing && onPickPath(listing.path)}>在此目录创建工作区</button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 远程目录选择器（统一流第二步）                                        */
/* ------------------------------------------------------------------ */

function RemoteDirectoryPicker({ site, busy, onPickRoot, onBack, onCancel }: {
  site: SiteView
  busy: boolean
  onPickRoot(rootPath: string): void | Promise<void>
  onBack(): void
  onCancel(): void
}) {
  const [path, setPath] = useState(site.homePath || '/')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async (target: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await api<{ path: string; entries: RemoteEntry[] }>('sites/browse', { id: site.id, path: target })
      setPath(result.path)
      setEntries(result.entries)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [site.id])

  useEffect(() => {
    void load(site.homePath || '/')
  }, [load, site.homePath])

  const dirs = entries.filter((entry) => entry.type === 'd')

  return (
    <div>
      <div style={S.breadcrumb}>
        <button type="button" style={{ ...S.dirRow, width: 'auto', padding: '2px 6px' }} disabled={path === '/' || loading} onClick={() => void load(parentPath(path))}>↑ 上级</button>
        <span>{site.name}:{path}</span>
      </div>
      {loading ? <div style={S.banner('info')}>加载目录…</div> : null}
      {error ? <div style={S.banner('error')}>{error}</div> : null}
      <div style={{ border: palette.borderSoft, borderRadius: 10, overflow: 'hidden', maxHeight: 300, overflowY: 'auto' }}>
        {dirs.map((entry) => (
          <button
            key={entry.path}
            type="button"
            style={S.dirRow}
            onMouseEnter={(event) => { event.currentTarget.style.background = palette.bgHover }}
            onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent' }}
            onClick={() => void load(entry.path)}
          >
            <span aria-hidden>📁</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
          </button>
        ))}
        {dirs.length === 0 && !loading ? <div style={{ ...S.empty, margin: 8 }}>没有子目录</div> : null}
      </div>
      <div style={S.footer}>
        <button type="button" style={S.button()} disabled={loading || creating} onClick={() => {
          const name = window.prompt('新文件夹名称')
          if (!name?.trim()) return
          setCreating(true)
          api<string>('sites/mkdir', { id: site.id, path, name: name.trim() })
            .then(() => load(path))
            .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
            .finally(() => setCreating(false))
        }}>新建文件夹</button>
        <span style={{ flex: 1 }} />
        <button type="button" style={S.button()} disabled={loading || creating || busy} onClick={onBack}>← 连接</button>
        <button type="button" style={S.button()} disabled={busy || creating} onClick={onCancel}>取消</button>
        <button type="button" style={S.button(Boolean(true))} disabled={loading || creating || busy} onClick={() => void onPickRoot(path)}>在此目录创建工作区</button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 统一“添加工作区”流                                                  */
/* ------------------------------------------------------------------ */

type Step = 'idle' | 'connection' | 'local' | 'remote' | 'new-site'

function UnifiedWorkspaceFlow({ open, busy, onPicked, onCancel, onError, listDirectory, createDirectory }: DirectoryFlowOwnerProps & {
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListingLike>
  createDirectory: (path: string, name: string) => Promise<string>
}) {
  const [step, setStep] = useState<Step>('idle')
  const [sites, setSites] = useState<SiteView[]>([])
  const [selectedSite, setSelectedSite] = useState<SiteView | null>(null)
  const [sitesError, setSitesError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [formKey, setFormKey] = useState(0)
  const [flowError, setFlowError] = useState<string | null>(null)

  const loadSites = useCallback(async () => {
    try {
      setSites(await api<SiteView[]>('sites/list'))
      setSitesError(null)
    } catch (caught) {
      setSitesError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    if (open) {
      setStep('connection')
      setFlowError(null)
      setWorking(false)
      void loadSites()
    } else {
      setStep('idle')
    }
  }, [open, loadSites])

  const adoptRemoteRoot = useCallback(async (siteId: string, rootPath: string) => {
    setWorking(true)
    setFlowError(null)
    try {
      const workspace = await api<WorkspaceView>('workspaces/add', { siteId, rootPath })
      onPicked(workspace.anchorPath)
    } catch (caught) {
      setFlowError(caught instanceof Error ? caught.message : String(caught))
      setWorking(false)
    }
  }, [onPicked])

  const overlay = (step === 'connection' || step === 'local' || step === 'remote' || step === 'new-site') ? (
    createPortal(
      <div style={S.overlay} role="dialog" aria-label="添加工作区" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}>
        <div style={S.modal}>
          <div style={S.header}>
            <span style={S.title}>
              {step === 'connection' ? '添加工作区 · 选择连接'
                : step === 'local' ? '添加工作区 · 本地目录'
                : step === 'remote' ? `添加工作区 · ${selectedSite?.name ?? ''} 目录`
                : '添加工作区 · 新建远程站点'}
            </span>
            <button type="button" style={S.iconButton} aria-label="关闭" disabled={busy || working} onClick={onCancel}>✕</button>
          </div>
          <div style={S.body}>
            {busy ? <div style={S.banner('info')}>正在创建工作区…</div> : null}
            {flowError ? <div style={S.banner('error')}>{flowError}</div> : null}

            {step === 'connection' ? (
              <>
                <button type="button" style={S.choiceRow} disabled={busy} onClick={() => setStep('local')}>
                  <span style={{ fontSize: 18 }} aria-hidden>🖥</span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                    <span style={S.choiceTitle}>本地（此电脑）</span>
                    <span style={S.choiceMeta}>从本机选择一个已有目录</span>
                  </span>
                  <span style={{ color: palette.tertiary }}>→</span>
                </button>

                <div style={S.sectionTitle}>远程站点</div>
                {sitesError ? <div style={S.banner('error')}>{sitesError}</div> : null}
                {sites.map((site) => (
                  <button key={site.id} type="button" style={S.choiceRow} disabled={busy} onClick={() => { setSelectedSite(site); setStep('remote') }}>
                    <span style={{ fontSize: 18 }} aria-hidden>🌐</span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                      <span style={S.choiceTitle}>{site.name}</span>
                      <span style={S.choiceMeta}>{site.endpoint} · 家目录 {site.homePath}</span>
                    </span>
                    <span style={{ color: palette.tertiary }}>→</span>
                  </button>
                ))}

                <button type="button" style={{ ...S.choiceRow, borderStyle: 'dashed' }} disabled={busy} onClick={() => { setFormKey((key) => key + 1); setStep('new-site') }}>
                  <span style={{ fontSize: 18 }} aria-hidden>➕</span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                    <span style={S.choiceTitle}>新建远程站点</span>
                    <span style={S.choiceMeta}>先配置一个 SSH/SFTP 连接</span>
                  </span>
                  <span style={{ color: palette.tertiary }}>→</span>
                </button>
              </>
            ) : null}

            {step === 'local' ? (
              <LocalDirectoryPicker
                busy={busy || working}
                onPickPath={onPicked}
                onBack={() => setStep('connection')}
                onCancel={onCancel}
                listDirectory={listDirectory}
                createDirectory={createDirectory}
              />
            ) : null}

            {step === 'new-site' ? (
              <SiteForm
                key={formKey}
                submitLabel="测试连接并继续"
                busy={working || busy}
                onSubmit={async (form) => {
                  setWorking(true)
                  setFlowError(null)
                  try {
                    const site = await api<SiteView>('sites/add', {
                      name: form.name.trim() || undefined,
                      host: form.host.trim(),
                      port: Number(form.port || 22),
                      username: form.username.trim(),
                      homePath: form.homePath.trim() || undefined,
                      authKind: form.authKind,
                      password: form.authKind === 'password' ? form.password : undefined,
                      privateKeyPath: form.authKind === 'privateKey' ? form.privateKeyPath.trim() : undefined,
                      passphrase: form.authKind === 'privateKey' && form.passphrase ? form.passphrase : undefined,
                    })
                    await loadSites()
                    setSelectedSite(site)
                    setStep('remote')
                  } catch (caught) {
                    setFlowError(caught instanceof Error ? caught.message : String(caught))
                  } finally {
                    setWorking(false)
                  }
                }}
                onCancel={() => setStep('connection')}
              />
            ) : null}

            {step === 'remote' && selectedSite ? (
              <RemoteDirectoryPicker
                site={selectedSite}
                busy={busy || working}
                onPickRoot={(rootPath) => void adoptRemoteRoot(selectedSite.id, rootPath)}
                onBack={() => setStep('connection')}
                onCancel={onCancel}
              />
            ) : null}
          </div>
        </div>
      </div>,
      document.body,
    )
  ) : null

  return overlay
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

export function apply(ctx: AppContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: '@dsh-external/dsh-remote-workspace-sites',
    order: 30,
    label: '远程站点',
  }, RemoteSitePanel))

  const flowInjected = () => ({
    listDirectory: (path?: string, signal?: AbortSignal) => ctx.workspaces.listDirectory(path, signal),
    createDirectory: (path: string, name: string) => ctx.workspaces.createDirectory(path, name),
  })

  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({
        name: 'conversation.hero.workspace.directoryFlow',
        priority: -1,
        inject: flowInjected,
      }, UnifiedWorkspaceFlow)
      yield ctx.slots.register({
        name: 'sidebar.workspaces.directoryFlow',
        priority: -1,
        inject: flowInjected,
      }, UnifiedWorkspaceFlow)
    }))
}
