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
let repairHandle

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
    { id: 'thermal-session-control', disabled: true },
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
    'thermal_list_skills',
    'thermal_recommend_optimizations',
    'thermal_create_optimization_skill',
    'thermal_update_optimization_skill',
    'thermal_get_task',
    'thermal_create_task',
    'thermal_probe_icepak',
    'thermal_inspect_project',
    'thermal_plugin_status',
    'thermal_plugin_repair_context',
    'thermal_stage_plugin_repair',
    'thermal_reconcile_plugins',
    'thermal_install_plugin_release',
    'thermal_script_library', 'thermal_stage_script', 'thermal_script_task_context',
    'thermal_run_script', 'thermal_script_runs', 'thermal_cancel_script',
    'thermal_plan_script_iteration', 'thermal_script_iterations', 'thermal_cancel_script_iteration',
    'read',
    'write',
  ]) assert.ok(names.includes(expected), `missing DSH tool: ${expected}`)
  assert.ok(!names.includes('thermal_start_baseline'), 'DSH must not bypass the human confirmation gate')
  assert.ok(presets.some(preset => preset.id === 'thermal-plugin-repair'))
  repairHandle = await ctx.agents.create({ sessionId: SessionId('thermal-repair-smoke'),
    setup: agentContext => ctx.agentPresets.mount(agentContext, 'thermal-plugin-repair').then(() => undefined) })
  const repairNames = ['thermal_plugin_status', 'thermal_plugin_repair_context', 'thermal_stage_plugin_repair'].sort()
  assert.deepEqual(ctx.tools.schemas(repairHandle.agent).map(tool => tool.name).sort(), repairNames)
  assert.deepEqual(ctx.tools.schemas(handle.agent).map(tool => tool.name).sort(), names, 'repair restrictions do not change the task assistant')
  let sequence = 0, forbiddenExecutions = 0, allowedExecutions = 0
  const invoke = name => ctx.tools.execute({ name, arguments: {}, agent: repairHandle.agent,
    callId: `repair-policy-${sequence++}`, signal: new AbortController().signal })
  for (const name of ['bash', 'pwsh', 'read', 'write', 'run_code', 'thermal_create_task', 'thermal_install_plugin_release', 'thermal_reconcile_plugins']) {
    assert.equal((await invoke(name)).isError, true, `repair session must reject ${name}`)
  }
  // A late scoped registration is exempt from inherited schema filters. The execution guard must still deny it.
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }
  repairHandle.agent.ctx.tools.register({ name: 'fixture_forbidden', description: 'Test late registration', parameters: {}, output,
    async execute() { forbiddenExecutions++; return 'unexpected' } })
  repairHandle.agent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
  const forbidden = await invoke('fixture_forbidden')
  assert.equal(forbidden.isError, true); assert.match(forbidden.error.message, /Repair sessions may only/)
  assert.equal(forbiddenExecutions, 0, 'pre-execute allow cannot override the monotonic repair guard')
  // Trusted test doubles replace bridge I/O only; calls still traverse the real DSH execution pipeline.
  for (const name of repairNames) repairHandle.agent.ctx.tools.register({ name, description: 'Policy test fixture', parameters: {}, output,
    async execute() { allowedExecutions++; return 'fixture' } })
  for (let i = 0; i < 3; i++) assert.equal((await invoke('thermal_stage_plugin_repair')).isError, false)
  const extraProposal = await invoke('thermal_stage_plugin_repair')
  assert.equal(extraProposal.isError, true); assert.match(extraProposal.error.message, /3 proposal-attempt/)
  for (let i = 0; i < 61; i++) assert.equal((await invoke('thermal_plugin_repair_context')).isError, false)
  const exhausted = await invoke('thermal_plugin_status')
  assert.equal(exhausted.isError, true); assert.match(exhausted.error.message, /64 tool-call/)
  assert.equal(allowedExecutions, 64)
  process.stdout.write('Repair preset: exactly 3 tools; forbidden dispatch and late registrations denied; 64 calls and 3 proposals bounded.\n')

  process.stdout.write(`Thermal Agent DSH preset exposes ${names.length} tools with ${names.filter(name => name.startsWith('thermal_')).length} controlled thermal tools.\n`)
} finally {
  await repairHandle?.dispose()
  await handle?.dispose()
  await ctx?.fiber.dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
}
