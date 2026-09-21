import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  DshHost,
  ThermalToolsBridge,
  parseDshReadyUrl,
  prepareDshProfile,
  resolveDshCli,
} from '@thermal-agent/core'
import { LocalDatabase } from '@thermal-agent/sqlite-store'

function unused() { throw new Error('not used') }

test('pinned DSH profile loads the Thermal Agent preset and controlled tool plugin', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-dsh-profile-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cli = resolveDshCli()
  assert.match(cli ?? '', /@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/u)
  const plugin = resolve('plugins/dsh-thermal/dist/index.js')
  const patch = prepareDshProfile(root, plugin)
  const persona = await readFile(join(root, 'thermal-presets', 'thermal-agent', 'agent.cordis.yml'), 'utf8')
  assert.match(persona, /不得自动开始昂贵求解/u)
  assert.match(persona, /tool-skill/u)
  const configured = spawnSync(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--dump-config'], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, DSH_HOME: root },
  })
  assert.equal(configured.status, 0, configured.stderr || configured.error?.message)
  assert.match(configured.stdout, /default: thermal-agent/u)
  assert.match(configured.stdout, /thermal-agent-tools/u)
})

test('DSH Host keeps only the authenticated loopback launch URL and reaps its child', async t => {
  assert.equal(
    parseDshReadyUrl('dsh web: http://127.0.0.1:4567/?token=secret (LAN: http://10.0.0.2:4567/?token=secret)\n', 4567),
    'http://127.0.0.1:4567/?token=secret',
  )
  const root = await mkdtemp(join(tmpdir(), 'thermal-dsh-host-'))
  const workspace = join(root, 'workspace')
  const cli = join(root, 'fake-dsh.mjs')
  const plugin = join(root, 'fake-plugin.mjs')
  const pidFile = join(root, 'pids.txt')
  await writeFile(plugin, 'export function apply() {}\n')
  await writeFile(cli, `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.THERMAL_FAKE_PID_FILE, process.pid + '\\n')
const port = process.argv[process.argv.indexOf('--port') + 1]
console.log('dsh web: http://127.0.0.1:' + port + '/?token=fake')
setInterval(() => {}, 1000)
`)
  const previousCli = process.env.THERMAL_AGENT_DSH_CLI
  const previousPid = process.env.THERMAL_FAKE_PID_FILE
  process.env.THERMAL_AGENT_DSH_CLI = cli
  process.env.THERMAL_FAKE_PID_FILE = pidFile
  const statuses = []
  const host = new DshHost(join(root, 'dsh'), workspace, { url: 'http://127.0.0.1:1', token: 'bridge' }, plugin, value => statuses.push(value))
  t.after(async () => {
    await host.shutdown()
    if (previousCli === undefined) delete process.env.THERMAL_AGENT_DSH_CLI
    else process.env.THERMAL_AGENT_DSH_CLI = previousCli
    if (previousPid === undefined) delete process.env.THERMAL_FAKE_PID_FILE
    else process.env.THERMAL_FAKE_PID_FILE = previousPid
    await rm(root, { recursive: true, force: true })
  })
  await host.start()
  await waitFor(() => statuses.some(status => status.phase === 'ready'), 'host did not become ready')
  const firstPid = Number((await readFile(pidFile, 'utf8')).trim())
  await host.restart()
  await waitFor(() => statuses.filter(status => status.phase === 'ready').length === 2, 'host did not restart')
  assert.throws(() => process.kill(firstPid, 0), { code: 'ESRCH' })
  await host.shutdown()
  assert.equal(host.getStatus().phase, 'stopped')
})

test('DSH thermal bridge is token-protected and exposes only controlled Core operations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-dsh-bridge-'))
  const database = new LocalDatabase(join(root, 'thermal.db'))
  const calls = []
  const icepak = {
    async probeEnvironment() { return { pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', protocolVersion: '1.0.0', status: 'DETECTED', platform: 'test', aedtVersions: ['2024.2'], selectedVersion: '2024.2', pyaedtAvailable: true, licenseStatus: 'UNKNOWN', capabilities: [], diagnostics: [] } },
    async inspectProject(input) { calls.push(input); return { status: 'ok', mode: 'inspect', sourceProject: input.projectPath, workingProject: join(input.outputDir, 'Project1.aedt'), inputSha256: 'a'.repeat(64), project: { name: 'Project1', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: [], setups: ['Setup1'], boundaries: [], nativeComponents: [], monitors: [], objects: [] }, validation: { verified: true, checks: [] } } },
    fanCheck: unused, solveProject: unused, fanSolve: unused,
  }
  const bridge = new ThermalToolsBridge(root, database, icepak)
  const address = await bridge.start()
  t.after(async () => {
    await bridge.stop()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  assert.equal(new URL(address.url).hostname, '127.0.0.1')
  assert.equal((await fetch(`${address.url}/v1/tasks`)).status, 401)
  const headers = { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' }
  const createdResponse = await fetch(`${address.url}/v1/tasks`, {
    method: 'POST', headers,
    body: JSON.stringify({ title: '自然语言散热任务', description: '检查 Project1 并建立基线', projectPath: 'C:\\models\\Project1.aedt', targetTmaxC: 85 }),
  })
  assert.equal(createdResponse.status, 201)
  const created = await createdResponse.json()
  assert.equal(created.task.executionStatus, 'DRAFT')
  assert.equal(created.task.requirementSnapshot.source, 'dsh-natural-language')
  const detail = await fetch(`${address.url}/v1/tasks/detail?id=${created.task.id}`, { headers })
  assert.equal((await detail.json()).task.title, '自然语言散热任务')
  const probe = await fetch(`${address.url}/v1/icepak/probe`, { headers })
  assert.equal((await probe.json()).probe.status, 'DETECTED')
  const inspected = await fetch(`${address.url}/v1/icepak/inspect`, {
    method: 'POST', headers,
    body: JSON.stringify({ projectPath: 'C:\\models\\Project1.aedt', version: '2024.2' }),
  })
  assert.equal(inspected.status, 200)
  assert.match(calls[0].outputDir, /runs[/\\]dsh-inspect[/\\][0-9a-f-]+$/u)
})

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  throw new Error(message)
}

