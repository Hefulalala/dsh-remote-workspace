#!/usr/bin/env node
// Smoke test for built artifacts. Run after `bash scripts/build.sh && npm run build:client`.
// This is a textual artifact check only: it must not import the host module at
// runtime, because the host's framework peers are supplied by the DSH harness,
// not by this package's standalone npm install (CI uses --legacy-peer-deps).
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)

const hostPath = new URL('lib/index.js', root)
const host = readFileSync(hostPath, 'utf8')

for (const needle of [
  '@dsh-external/dsh-remote-workspace',
  'workspaceRegistry',
  'webServer',
  'remote-workspaces/api',
  '/workspaces/append',
  '/workspaces/writeat',
  '/pool-stats',
]) {
  if (!host.includes(needle)) throw new Error(`host bundle is missing '${needle}'`)
}
if (!/export\s+const\s+name\s*=/.test(host)) throw new Error('host bundle is missing the plugin name export')
if (!/export\s+function\s+apply/.test(host)) throw new Error('host bundle is missing apply()')

const clientPath = new URL('lib/client.js', root)
const client = readFileSync(clientPath, 'utf8')
if (!client.includes('window.__ModuleLoader__.load')) {
  throw new Error('client bundle is missing the ModuleLoader entry')
}
if (!client.includes('@dsh-external/dsh-remote-workspace')) {
  throw new Error('client bundle is missing the plugin id')
}
for (const route of ['sites/list', 'workspaces/add']) {
  if (!client.includes(route)) throw new Error(`client bundle is missing API route '${route}'`)
}

console.log('[smoke] ok: host + client artifacts look valid')
