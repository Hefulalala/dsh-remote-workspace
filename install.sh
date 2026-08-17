#!/usr/bin/env bash
# Prepare a released/extracted copy of dsh-remote-workspace for injection.
#
# Usage:
#   tar -xzf dsh-external-dsh-remote-workspace-<version>.tgz -C ~/dsh-plugins
#   bash ~/dsh-plugins/package/install.sh
#
# The script only installs the runtime dependency (ssh2). The plugin is then
# ready for `dev_inject_plugin <this-directory>` inside a DSH session, or for
# `dsh plugin add` when the tarball is used as a bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [ ! -d node_modules/ssh2 ]; then
  echo "[install] installing runtime dependency ssh2 ..."
  # --legacy-peer-deps: DSH peers are supplied by the harness, not by this
  # standalone package install.
  npm install --omit=dev --legacy-peer-deps --ignore-scripts
fi

if [ ! -f lib/index.js ] || [ ! -f lib/client.js ]; then
  echo "[install] missing lib/ artifacts. Build them first:" >&2
  echo "  bash scripts/build.sh && npm run build:client" >&2
  exit 1
fi

echo "[install] ready."
echo "  In a DSH injector session run:"
echo "    dev_inject_plugin $ROOT"
echo "  Or install the bundle with:"
echo "    dsh plugin --profile web add <path-or-package>"
