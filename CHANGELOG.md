# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
