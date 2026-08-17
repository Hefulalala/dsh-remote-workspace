# Architecture

## Goal

Treat an SSH/SFTP server directory as a first-class DSH workspace: it appears
in the sidebar workspace tree, owns sessions, and is readable/writable by the
agent — without mounting or syncing the remote filesystem locally.

## Concepts

```
Connection
├── Local (this computer)                 handled natively by DSH
└── RemoteSite                            one SSH/SFTP connection profile

Workspace
├── Local workspace  = local directory
└── Remote workspace = RemoteSite + remote rootPath
```

- A **site** knows *how to connect*: host, port, user, auth, resolved home path,
  and the trusted SSH host fingerprint.
- A **workspace** knows *what to expose in the sidebar*: the site plus one
  remote directory, a display name, and the local anchor workspace id.

## Persistence

`$DSH_HOME/storages/remote-workspaces.json` (created with mode `0600`):

```jsonc
{
  "version": 2,
  "sites": [ /* connection profiles */ ],
  "workspaces": [ /* siteId + rootPath + localWorkspaceId */ ]
}
```

Version 1 stores (connection and workspace merged) are migrated automatically
on first load: one legacy record becomes one site + one workspace, preserving
the workspace id, host fingerprint and anchor mapping.

## Host half (`src/index.ts`)

Responsibilities:

1. **Storage** — load/migrate/save the JSON store through an atomic
   tmp-file + rename, serialized by a mutation queue.
2. **SSH/SFTP** — uses `ssh2` behind a per-site **connection pool**
   (`SftpConnectionPool`): lazy connect, keepalive, idle TTL, auto-reconnect,
   and a limited number of persistent connections per site (concurrency spikes
   degrade to one-off connections instead of blocking). Hot-path file reads are
   cached by `mtime + size`, and appends / byte-offset writes avoid whole-file
   rewrites. `prepareSiteConnection` resolves the remote home with
   `sftp.realpath('.')` and canonicalizes an explicitly configured home path.
3. **Sidebar integration** — for every remote workspace, `ensureLocalWorkspace`
   creates `$DSH_HOME/remote-workspaces/<workspaceId>/`, writes `AGENTS.md`,
   and registers the directory with DSH's `workspaceRegistry` under the
   workspace display name. Sessions created for that workspace therefore group
   natively in the sidebar.
4. **HTTP API** — routes under `/remote-workspaces/api`:
   - `/sites/*` — connection profile management and directory browsing
   - `/workspaces/*` — workspace management and file read/write
5. **Agent tools** — `remote_site_*` and `remote_workspace_*` registered
   through `@deepseek-ai/dsh-tools`.

### Remote path safety

Workspace file operations (`browse`, `read`, `write`) resolve requested paths
against the workspace root and reject anything that escapes it. Site directory
browsing is intentionally unrestricted because it is used to *choose* the
workspace root before a workspace exists.

## Client half (`src/client/index.tsx`)

Two registrations:

1. **`sidebar.footer.action`** — the “Remote Sites” button and panel. This
   surface manages connections only (add / edit / test / delete).
2. **Directory-flow slots** — `sidebar.workspaces.directoryFlow` and
   `conversation.hero.workspace.directoryFlow` are registered at priority `-1`,
   shadowing the built-in local directory flow while it remains installed.
   The unified flow has two steps:
   - choose a connection (local / site / new site)
   - choose a directory (local directory browser or SFTP directory browser)

When the user picks a remote directory, the client calls
`POST /workspaces/add` and then hands the resulting anchor path to DSH's
`onPicked(path)` contract. DSH resolves that path to the already-created
anchor workspace, so the standard “create workspace → open new session” flow
completes unchanged. Uninstalling this plugin restores the built-in flow.

### AGENTS.md contract

Each anchor contains an `AGENTS.md` that DSH loads as workspace instructions:

```markdown
# Remote workspace: <name>
- Remote workspace id: ...
- Remote site: ...
- Endpoint: user@host:port
- Remote root: /path/on/server

Rules for this session:
- Resolve user file paths against the remote root ...
- Use remote_workspace_browse / read / write for ALL remote file operations.
- Do NOT expect project files in this local anchor directory ...
```

Site rename / connection edits rewrite this file for all affected workspaces.

## Request flow (remote workspace creation)

```
User clicks Add Workspace
  → UnifiedWorkspaceFlow (connection step)
    → RemoteDirectoryPicker (SFTP /sites/browse from site.homePath)
      → POST /workspaces/add {siteId, rootPath}
        → host verifies remote directory
        → host creates anchor dir + AGENTS.md
        → host registers anchor in workspaceRegistry
        → returns {anchorPath, localWorkspaceId, ...}
      → flow calls owner.onPicked(anchorPath)
        → DSH createWorkspace({path}) resolves existing anchor workspace
        → DSH opens a new session with cwd = anchorPath
```

## Uninstall / cleanup

- `POST /workspaces/remove` removes only the workspace registration from the
  sidebar; session logs remain and become ungrouped.
- `POST /sites/remove` removes the site and all of its workspace registrations;
  remote files are never deleted.
- Anchor directories are retained after removal so historical session `cwd`
  values still resolve; only `AGENTS.md` is removed.
