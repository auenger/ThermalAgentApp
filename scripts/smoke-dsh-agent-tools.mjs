import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import { prepareDshProfile } from '../apps/core/dist/dsh-profile.js'

const home = mkdtempSync(join(tmpdir(), 'thermal-agent-tools-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
let ctx
let handle

try {
  const profileDir = join(home, 'profiles', 'spec')
  mkdirSync(profileDir, { recursive: true })
  const config = join(profileDir, 'cordis.yml')
  writeFileSync(config, '[]\n')
  const settings = join(home, 'settings.yaml')
  writeFileSync(settings, '{}\n')
  const installAnchor = resolve('node_modules/@deepseek-ai/dsh/package.json')
  const patch = prepareDshProfile(home, resolve('plugins/dsh-thermal/dist/index.js'))
  await healProfilesModuleFallback({ installAnchor, home })
  const patches = [
    ...loadOverlayPatches('thermal-smoke', resolve('node_modules/@deepseek-ai/dsh-base/cordis.patch.yml')),
    ...loadOverlayPatches('thermal-smoke', resolve('node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml')),
    { id: 'settings', config: { path: settings, watch: false } },
    { id: 'storage-json', config: { root: join(home, 'storages') } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions') } },
    { id: 'webserver', disabled: true },
    { id: 'web-runtime', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    { id: 'session-log-download', disabled: true },
    { id: 'open-in-app', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
    ...loadOverlayPatches('thermal-smoke', patch),
  ]
  ctx = await boot('thermal-smoke', config, patches, bootContext => {
    bootContext.provide('connection', {
      fetch: { register: () => () => {} },
      rpc: { intercept: () => () => {} },
    })
    provideCmdline(bootContext, { args: [], exit: () => {} })
  })
  const presets = await ctx.agentPresets.list()
  assert.ok(presets.some(preset => preset.id === 'thermal-agent'))
  handle = await ctx.agents.create({
    sessionId: SessionId('thermal-smoke'),
    setup: agentContext => ctx.agentPresets.mount(agentContext).then(() => undefined),
  })
  const names = ctx.tools.schemas(handle.agent).map(tool => tool.name).sort()
  for (const expected of [
    'thermal_list_tasks',
    'thermal_get_task',
    'thermal_create_task',
    'thermal_probe_icepak',
    'thermal_inspect_project',
    'read',
    'write',
  ]) assert.ok(names.includes(expected), `missing DSH tool: ${expected}`)
  assert.ok(!names.includes('thermal_start_baseline'), 'DSH must not bypass the human confirmation gate')
  process.stdout.write(`Thermal Agent DSH preset exposes ${names.length} tools with five controlled thermal tools.\n`)
} finally {
  await handle?.dispose()
  await ctx?.fiber.dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
}

