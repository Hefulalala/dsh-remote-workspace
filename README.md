# dsh-remote-workspace

A plugin for **DSH** that brings SSH/SFTP remote workspaces into the workspace sidebar — alongside your local directories.

- **Remote site** = one SSH/SFTP connection profile (host / user / auth / home directory), managed from the **🌐 Remote Sites** button.
- **Remote workspace** = a remote site + a directory on that server. It appears in the left workspace tree exactly like a local workspace, owns its own sessions, and lets the agent read/write remote files directly.
- **Unified "Add Workspace" flow** — the same add-workspace entry point now asks you to choose a connection first: *Local (this computer)* or one of your remote sites.

[![Listed in awesome-dsh-plugin](https://img.shields.io/badge/awesome--dsh--plugin-listed%20%7C%20tools-7c5cff?style=flat-square&logo=awesome-lists&logoColor=white)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin#tools)

---

## 中文速览

- **远程站点**：SSH/SFTP 连接配置（主机 / 用户 / 认证 / 家目录），左下角“🌐 远程站点”管理。
- **远程工作区**：远程站点 + 远程目录；和本地目录一样出现在左侧栏、按工作区分组 session。
- **统一添加入口**：左侧栏“添加工作区”先选连接（本地 / 远程站点 / 新建站点），再选目录。
- **默认家目录**：站点配置中目录留空时，自动通过 SFTP 解析服务器真实 home。
- **Agent 工具**：`remote_site_*` 管理连接，`remote_workspace_*` 在会话中直接读写远程文件。

---

## Features

- **Site management (bottom-left panel)**
  - Add / edit / test / delete SSH/SFTP connection profiles
  - Auth modes: password, private key file (host path), or SSH Agent
  - Empty home path is resolved via SFTP `realpath('.')` to the server's real home

- **Unified add-workspace flow (left sidebar)**
  - Step 1 — choose connection: local computer, an existing remote site, or create a new site
  - Step 2 — choose directory:
    - Local → native-style directory browser (breadcrumbs, enter folders, create folder)
    - Remote → SFTP directory browser starting at the site home; supports navigation and folder creation
  - One site can host **multiple remote workspaces**

- **Native workspace/session grouping**
  - Each remote workspace gets a local anchor directory (`$DSH_HOME/remote-workspaces/<id>/`)
  - The anchor is registered into DSH's `workspaceRegistry`, so remote workspaces appear and behave like local ones: click to start a session, session history stays grouped
  - `AGENTS.md` is generated in the anchor: the agent learns the real remote endpoint/root and routes file operations through `remote_workspace_*` tools

- **Agent tools**
  - `remote_site_list / add / test / rename / update / remove / browse`
  - `remote_workspace_list / add / browse / read / write / test / remove`
  - Path traversal protection (everything is confined to the workspace root), read/write size limits

- **Security**
  - SSH host-key TOFU: first connection records `sha256:<fingerprint>`, later connections reject mismatches
  - Config is persisted in `$DSH_HOME/storages/remote-workspaces.json` with `0600` permissions
  - Deleting sites/workspaces never deletes remote files; session logs are preserved

---

## Install

The package declares a `dsh.bundle` manifest, so it is installable through
DSH's plugin command and by plugin storefronts such as
[dsh-market](https://github.com/dsh-market/dsh-market).

### Option A — GitHub Release tarball (recommended)

1. Download `dsh-external-dsh-remote-workspace-0.1.0.tgz` from the
   [Releases](../../releases/latest) page.
2. Extract and prepare it:

   ```bash
   mkdir -p ~/dsh-plugins
   tar -xzf dsh-external-dsh-remote-workspace-0.1.0.tgz -C ~/dsh-plugins
   bash ~/dsh-plugins/package/install.sh   # installs ssh2 and validates artifacts
   ```

3. Inject it from your DSH session:

   ```bash
   # DSH injector environment:
   #   dev_inject_plugin ~/dsh-plugins/package
   ```

4. Refresh the DSH web page.

### Option B — DSH plugin manager

The repo ships `dsh.bundle.patch` + `cordis.patch.yml`, so a DSH install that
supports bundle installation can add it directly:

```bash
dsh plugin --profile web add Hefulalala/dsh-remote-workspace
```

### Option C — build from source

```bash
git clone https://github.com/Hefulalala/dsh-remote-workspace.git dsh-remote-workspace
cd dsh-remote-workspace

# Install the runtime dependency (and, if you want local builds, the toolchain):
npm install --omit=dev ssh2
npm install --save-dev typescript tsdown @types/node @types/react @types/react-dom @types/ssh2

bash scripts/build.sh        # host: src/index.ts → lib/
npm run build:client         # client: src/client/index.tsx → lib/client.js

# In the DSH injector environment:
#   dev_inject_plugin /absolute/path/to/dsh-remote-workspace
```

`scripts/build.sh` auto-detects a DSH source checkout (`DSH_CHECKOUT`) for peer-type linking;
otherwise it falls back to the locally installed toolchain.

---

## Usage

1. Open **🌐 Remote Sites** in the bottom-left sidebar and add a site:

   | Field | Notes |
   | --- | --- |
   | Host / Port / Username | SSH target |
   | Home directory | optional; empty = auto-detect the remote home |
   | Auth | password / private-key file / SSH agent |

2. Click **Add Workspace** in the left workspace tree:

   - Choose **Local** → pick a local folder (same as before)
   - Choose a **remote site** → pick a remote folder (starts at the site home)
   - Choose **New remote site** → configure the connection, then continue to folder selection

3. A remote workspace now appears in the left tree. Click it to open a new session, then just talk to the agent, e.g.:

   ```
   "Read /srv/app/config.yml and change the port to 8081"
   ```

The agent resolves paths against the remote root and uses `remote_workspace_read/write` automatically (guided by the generated `AGENTS.md`).

---

## Security notes

- **MVP storage**: passwords and private-key passphrases are currently stored **in plain text** inside a `0600` JSON file. For production, wire the plugin to DSH's credentials service or an OS keyring.
- Private keys are never copied into the plugin store — only the host path is saved.
- Remote file APIs are same-origin and enforce workspace-root confinement (8 MB write cap, 2 MB default read cap).
- Host fingerprint changes cause the connection to be rejected (manual fix: edit the site / re-add).

---

## Agent tools

| Tool | Purpose |
| --- | --- |
| `remote_site_list` | List configured SSH/SFTP connection profiles |
| `remote_site_add` | Add a site (tests the connection; home defaults to the remote home) |
| `remote_site_test` | Test a site connection |
| `remote_site_rename` | Rename a site (auto-derived workspace names follow) |
| `remote_site_update` | Update connection/auth/home of a site |
| `remote_site_remove` | Remove a site and its workspace registrations |
| `remote_site_browse` | Browse site directories (workspace folder picking) |
| `remote_workspace_list` | List remote workspaces |
| `remote_workspace_add` | Create a workspace for `siteId + rootPath` |
| `remote_workspace_browse` | Browse a workspace directory |
| `remote_workspace_read` | Read a remote file (binary → base64) |
| `remote_workspace_write` | Overwrite a remote file (utf8/base64) |
| `remote_workspace_append` | Append to a remote file (no whole-file rewrite) |
| `remote_workspace_write_at` | Patch part of a remote file at a byte offset |
| `remote_workspace_test` | Test a workspace root |
| `remote_workspace_remove` | Remove the sidebar grouping only |

---

## Host HTTP API

Prefix: `/remote-workspaces/api` — every response is `{ok:true,value}` or `{ok:false,error:{code,message}}`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/ping` | Health check |
| GET | `/sites/list` | List sites |
| POST | `/sites/add` | Add site |
| POST | `/sites/test` | Test site |
| POST | `/sites/rename` | Rename site |
| POST | `/sites/update` | Update site |
| POST | `/sites/remove` | Remove site |
| POST | `/sites/browse` | Browse a site directory |
| POST | `/sites/mkdir` | Create a remote folder |
| GET | `/workspaces/list` | List remote workspaces |
| POST | `/workspaces/add` | Create remote workspace (`siteId`, optional `rootPath`, optional `name`) |
| POST | `/workspaces/ensure` | Ensure sidebar anchor exists |
| POST | `/workspaces/rename` | Rename workspace |
| POST | `/workspaces/remove` | Remove workspace |
| POST | `/workspaces/test` | Test workspace root |
| POST | `/workspaces/browse` | Browse workspace directory |
| POST | `/workspaces/read` | Read file (cached by `mtime+size`) |
| POST | `/workspaces/write` | Write file |
| POST | `/workspaces/append` | Append to a file |
| POST | `/workspaces/writeat` | Patch part of a file at a byte offset |
| GET  | `/pool-stats` | Connection-pool and file-cache stats |

---

## Data model

`$DSH_HOME/storages/remote-workspaces.json` (v2):

- `sites[]` — connection profiles: host, port, user, auth, resolved `homePath`, host fingerprint
- `workspaces[]` — `siteId` + `rootPath` + sidebar anchor (`localWorkspaceId`)

Version 1 stores are migrated automatically on first load.

---

## Development

```
src/index.ts             Host: data model, SSH2/SFTP, workspaceRegistry anchors, HTTP API, tools
src/client/index.tsx     Client: Remote Sites panel + unified add-workspace flow
cordis.patch.yml         dsh.bundle patch used by `dsh plugin add`
scripts/build.sh         Host build
scripts/smoke.mjs        Artifact smoke test
lib/                     Build output
```

More design details: [docs/architecture.md](docs/architecture.md) ·
[CHANGELOG.md](CHANGELOG.md).

- Host services required: `webServer`, `tools`, `workspaceRegistry`
- Client services required: `slots`, `workspaces`
- The client shadows DSH's built-in directory-flow slots at priority `-1` and wraps
  local-picking behavior, so removing the plugin cleanly restores the built-in flow.

## Known limitations

- Remote file editing happens through the agent tools; the site panel itself only manages connections
- Connections are **pooled** per site (idle TTL + auto-reconnect); hot-path file ops also get an `mtime+size` content cache
- No remote rename/delete, directory sync, or conflict handling yet
- Passwords are stored in plain text (see Security notes)

## License

BSD-3-Clause © 2026 dsh-remote-workspace contributors. See [LICENSE](LICENSE).
