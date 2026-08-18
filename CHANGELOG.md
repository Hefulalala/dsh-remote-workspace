# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-18

### Changed

- SSH/SFTP connections are now **pooled per site** instead of opened per request:
  lazy connect, keepalive, idle TTL, auto-reconnect, bounded concurrency.
- Remote file reads are **cached by `mtime + size`**; writes, appends and
  byte-offset writes invalidate the cache automatically.

### Added

- `remote_workspace_append` tool + `/workspaces/append` endpoint (no whole-file rewrite).
- `remote_workspace_write_at` tool + `/workspaces/writeat` endpoint (byte-offset patch).
- `/pool-stats` endpoint for connection-pool and file-cache introspection.
- Pooled connections are closed when a site is removed or its connection info changes.
- File content cache is now bounded: LRU eviction (max 256 entries / 64 MB) with a
  10-minute TTL; cache hits refresh recency.
- `remote_workspace_write_at` rejects offsets beyond the current file size and
  returns a clear error instead of undefined SFTP behavior.

## [0.0.1] - 2026-08-17

### Added

- Remote Site management panel in the sidebar footer: add, edit, test and delete
  SSH/SFTP connection profiles (password / private key / SSH agent).
- Automatic remote home detection via SFTP `realpath('.')` when no home path is configured.
- Unified Add Workspace flow that shadows the built-in directory-flow slots:
  choose a connection (local / remote site / new site), then a directory.
- Remote workspaces registered as native DSH workspace anchors, so they appear
  in the sidebar workspace tree and group sessions like local workspaces.
- Automatic `AGENTS.md` generation in each workspace anchor so the agent routes
  file operations through `remote_workspace_*` tools.
- `remote_site_*` agent tools for connection management.
- `remote_workspace_*` agent tools for browsing, reading and writing remote files.
- Same-origin HTTP API under `/remote-workspaces/api` for the web client.
- SSH host key trust-on-first-use with `sha256` fingerprint verification.
- Automatic migration from the v1 store layout (connection = workspace) to the
  v2 layout (separate `sites` and `workspaces` tables).
- Root-path confinement, request size limits, and `0600`-permission persistence.

[0.0.1]: https://github.com/Hefulalala/dsh-remote-workspace/releases/tag/v0.0.1
[0.1.0]: https://github.com/Hefulalala/dsh-remote-workspace/releases/tag/v0.1.0
