#!/usr/bin/env node
// Smoke test for built artifacts. Run after `bash scripts/build.sh && npm run build:client`.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = new URL('..', import.meta.url)

const host = await import(new URL('lib/index.js', root))
if (host.name !== '@dsh-external/dsh-remote-workspace') {
  throw new Error(`unexpected plugin name: ${host.name}`)
}
for (const service of ['webServer', 'tools', 'workspaceRegistry']) {
  if (!host.inject.includes(service)) {
    throw new Error(`host inject list is missing '${service}': ${host.inject.join(',')}`)
  }
}
if (typeof host.apply !== 'function') throw new Error('host apply is missing')

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

console.log(`[smoke] ok: ${host.name} inject=[${host.inject.join(', ')}]`)
