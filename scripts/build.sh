#!/bin/bash
# Build @dsh-external/dsh-remote-workspace.
# - If a dsh source checkout is found: symlink its build deps and use its tsc.
# - Otherwise: use the plugin-local node_modules toolchain (typescript + tsdown).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi

link_pkg() {
  local name="$1" target="$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$name" "$target"
}

TSC=""
if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/packages" ]; then
  echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
  mkdir -p node_modules/@deepseek-ai
  node -e "const fs=require('fs');fs.rmSync('node_modules/@standard-schema',{recursive:true,force:true})"
  link_pkg cordis "$CHECKOUT/vendor/cordis"
  link_pkg @deepseek-ai/cordis "$CHECKOUT/vendor/cordis"
  link_pkg cosmokit "$CHECKOUT/vendor/cosmokit"
  link_pkg schemastery "$CHECKOUT/vendor/schemastery"
  link_pkg @deepseek-ai/dsh-tools "$CHECKOUT/packages/core/tools"
  link_pkg @deepseek-ai/dsh-llm "$CHECKOUT/packages/llm/llm"
  link_pkg @deepseek-ai/dsh-system-prompt "$CHECKOUT/packages/core/system-prompt"
  link_pkg @types/node "$CHECKOUT/node_modules/@types/node"

  STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1 || true)
  if [ -n "$STD_SCHEMA" ]; then
    node -e "
      const fs = require('fs');
      const path = require('path');
      fs.rmSync('node_modules/@standard-schema', { recursive: true, force: true });
      fs.mkdirSync('node_modules/@standard-schema', { recursive: true });
      fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/@standard-schema/spec'), process.platform === 'win32' ? 'junction' : 'dir');
    " "$STD_SCHEMA/node_modules/@standard-schema/spec"
  fi

  TSC="$CHECKOUT/node_modules/.bin/tsc"
  if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then TSC=""; fi
fi

if [ -z "$TSC" ]; then
  if [ -x "$ROOT/node_modules/.bin/tsc" ] || [ -f "$ROOT/node_modules/.bin/tsc.cmd" ]; then
    TSC="$ROOT/node_modules/.bin/tsc"
  elif command -v tsc >/dev/null 2>&1; then
    TSC="$(command -v tsc)"
  else
    echo "build: no tsc available (install typescript locally or set DSH_CHECKOUT)" >&2
    exit 1
  fi
fi

echo "=== Compiling src -> lib (tsc: $TSC) ==="
rm -rf lib
"$TSC" -p tsconfig.json

echo "=== Build complete ==="
