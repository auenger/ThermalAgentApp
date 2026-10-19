import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto'
import { PluginRuntimeStorage } from '../apps/core/dist/plugin-runtime-storage.js'
import { ThermalToolsBridge } from '../apps/core/dist/thermal-tools-bridge.js'
import { PluginHost } from '../apps/core/dist/plugin-host.js'
import { createCoreApp } from '../apps/core/dist/server.js'
import { LocalDatabase, ModelPreparationStore } from '@thermal-agent/sqlite-store'
import { lockIcepakOperations } from '../apps/core/dist/icepak-operation-lock.js'

const python = process.platform === 'win32' ? 'python' : 'python3'
const executable = execFileSync(python, ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
const environment = { platform: process.platform, architecture: process.arch, versions: { python: 'test-fixture', pyaedt: 'missing' } }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'thermal-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  async function source(kind, version) {
    const path = join(root, kind)
    await mkdir(join(path, 'adapter'), { recursive: true })
    const id = kind === 'icepak' ? 'icepak-pyaedt' : 'report-reportlab'
    await writeFile(join(path, 'plugin.json'), JSON.stringify({ schemaVersion: 1, hostApi: 1, id, version, kind,
      entry: { root: 'python', module: 'adapter' }, capabilities: ['health', 'environment_probe'], permissions: [],
      compatibility: { platforms: [process.platform], architectures: [process.arch], versions: {} } }))
    await writeFile(join(path, 'adapter', '__main__.py'), `import sys,json\nr=json.loads(sys.stdin.readline())\nprint(json.dumps({'id':r['id'],'ok':True,'result':{'pluginId':'${id}','pluginVersion':'${version}','protocolVersion':'1.0.0','status':'ok' if r['method']=='health' else 'NOT_INSTALLED','platform':sys.platform,'aedtVersions':[]}}))\n`)
    return { python: executable, pluginRoot: path }
  }
  const options = { icepak: await source('icepak', '1.0.0'), report: await source('report', '1.0.0'),
    inspect: async () => ({ executable, environment: structuredClone(environment) }) }
  return { root, home: join(root, 'plugins'), options, source }
}

test('host shutdown retains exclusive home ownership until pinned work releases', async t => {
  const f = await fixture(t)
  const host = new PluginHost(f.home, f.options)
  t.after(() => host.close())
  assert.throws(() => new PluginHost(f.home, f.options), /already owned/)
  const pinned = await host.icepak.pinRuntime()
  let closed = false
  const closing = host.close().then(() => { closed = true })
  try {
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(closed, false)
    assert.throws(() => new PluginHost(f.home, f.options), /already owned/)
    assert.throws(() => host.setAutomaticUpdates(false), /closed/)
    await assert.rejects(host.icepak.probeEnvironment(), /closed/)
  } finally { pinned.release(); await closing }
  const replacement = new PluginHost(f.home, f.options)
  const digest = host.status().active['icepak-pyaedt'].current
  assert.throws(() => host.store.install(f.options.icepak.pluginRoot), /closing/)
  assert.throws(() => host.store.activate(digest, environment, []), /closing/)
  await assert.rejects(host.store.validate(digest, environment, async () => []), /closing/)
  assert.equal(host.store.isBusy('icepak-pyaedt'), false)
  await replacement.close()
  await writeFile(join(f.home, 'policy.json'), '{invalid')
  assert.throws(() => new PluginHost(f.home, f.options), /JSON/)
  await rm(join(f.home, 'policy.json'))
  await new PluginHost(f.home, f.options).close()
})

test('a duplicate default Core is rejected before task recovery and releases failed startup resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-core-owner-'))
  let app = createCoreApp({ home: root, startAgentRuntime: false })
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  assert.throws(() => createCoreApp({ home: root, startAgentRuntime: false }), /already owned/)
  assert.ok(app.database.listTasks(1))
  await app.close()
  app = createCoreApp({ home: root, startAgentRuntime: false })
  assert.ok(app.database.listTasks(1))
})

test('releasing a workflow pin cannot surrender ownership while its Python call is still running', async t => {
  const f = await fixture(t)
  const entry = join(f.options.icepak.pluginRoot, 'adapter', '__main__.py')
  await writeFile(entry, (await readFile(entry, 'utf8')).replace('print(json.dumps', 'import time\nif r["method"] == "probe_environment": time.sleep(0.4)\nprint(json.dumps'))
  const host = new PluginHost(f.home, f.options)
  t.after(() => host.close())
  const pinned = await host.icepak.pinRuntime()
  const call = pinned.port.probeEnvironment()
  pinned.release(); pinned.release()
  let closed = false
  const closing = host.close().then(() => { closed = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    assert.equal(host.store.isBusy('icepak-pyaedt'), true)
    assert.throws(() => new PluginHost(f.home, f.options), /already owned/)
    await assert.rejects(pinned.port.probeEnvironment(), /lease has ended/)
    assert.equal((await call).pluginVersion, '1.0.0')
  } finally { await call; await closing }
  await new PluginHost(f.home, f.options).close()
})

test('host maintenance waits for leases and fences new work while loading saved runtime references', async t => {
  const f = await fixture(t), host = new PluginHost(f.home, f.options)
  t.after(() => host.close())
  const runtimeHome = join(f.home, 'python-environments'), name = `env-${randomUUID()}`, directory = join(runtimeHome, name)
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'module.py'), 'value = 1')
  new PluginRuntimeStorage(runtimeHome).own(directory, 'f'.repeat(64), 'e'.repeat(64), 'd'.repeat(64))
  const metaPath = join(runtimeHome, 'managed-environments', `${name}.json`), record = JSON.parse(await readFile(metaPath, 'utf8'))
  record.createdAt = '2020-01-01T00:00:00Z'; await writeFile(metaPath, JSON.stringify(record))
  let refs = [{ pluginId: 'icepak-pyaedt', pluginVersion: '0.1.0', packageDigest: 'e'.repeat(64), environmentDigest: 'd'.repeat(64) }]
  let entered, resume, waiting
  host.attachRuntimeReferences(async () => { entered?.(); if (waiting) await waiting; return refs })
  await host.reconcile()
  assert.equal(host.status().runtimeStorage.retained[0].reason, 'saved workflow or readiness reference')
  const pinned = await host.icepak.pinRuntime()
  refs = []
  try { await host.reconcile(); assert.equal(await readFile(join(directory, 'module.py'), 'utf8'), 'value = 1') }
  finally { pinned.release() }
  const inspecting = new Promise(resolve => { entered = resolve })
  waiting = new Promise(resolve => { resume = resolve })
  const collecting = host.reconcile()
  await inspecting
  let executed = false
  const call = host.icepak.probeEnvironment().then(value => { executed = true; return value })
  try { await new Promise(resolve => setImmediate(resolve)); assert.equal(executed, false) }
  finally { resume() }
  await collecting; await call
  assert.deepEqual(host.status().runtimeStorage.removed, [name])
  await assert.rejects(readFile(join(directory, 'module.py')), { code: 'ENOENT' })
})

test('a cold managed engineering call initializes before acquiring its operation gate', async t => {
  const f = await fixture(t)
  const database = new LocalDatabase(join(f.root, 'cold.sqlite'))
  const store = new ModelPreparationStore(database.path)
  const host = new PluginHost(f.home, f.options)
  host.attachEngineeringStore(store)
  try {
    const port = lockIcepakOperations(host.icepak, store)
    assert.equal((await port.probeLaunchability({})).pluginVersion, '1.0.0')
    assert.equal(Boolean(store.reconcileRecoveredOperation()), false)
    assert.equal(host.status().runtimes.find(runtime => runtime.kind === 'icepak').phase, 'ready')
  } finally { await host.close(); store.close(); database.close() }
})

test('default clients run immutable registered code, updates and rollback survive app restart', async t => {
  const f = await fixture(t)
  let host = new PluginHost(f.home, f.options)
  t.after(() => host.close())
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
  const pinned = await host.icepak.pinRuntime()
  assert.match(pinned.identity.packageDigest, /^[a-f0-9]{64}$/)
  await f.source('icepak', '2.0.0')
  assert.equal((await pinned.port.probeEnvironment()).pluginVersion, '1.0.0', 'editing the source must not change a registered runtime')
  pinned.release()
  await host.close()
  host = new PluginHost(f.home, f.options)
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '2.0.0')
  const second = host.status().active['icepak-pyaedt'].current
  await host.rollback('icepak-pyaedt')
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
  await host.reconcile()
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0', 'automatic reconciliation respects rollback hold')
  await host.close()
  host = new PluginHost(f.home, f.options)
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
  host.resume('icepak-pyaedt')
  await host.reconcile()
  assert.equal(host.status().active['icepak-pyaedt'].current, second)
})

test('disabled automatic upgrades retain an installed version while still checking its environment', async t => {
  const f = await fixture(t)
  let host = new PluginHost(f.home, f.options)
  t.after(() => host.close())
  await host.icepak.probeEnvironment()
  host.setAutomaticUpdates(false)
  await host.close()
  await f.source('icepak', '2.0.0')
  host = new PluginHost(f.home, f.options)
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
  assert.equal(host.status().automaticUpdates, false)
  host.setAutomaticUpdates(true)
  await host.reconcile()
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '2.0.0')
})

test('startup prepares local runtimes before network discovery and disabling updates cancels pending downloads', async t => {
  const f = await fixture(t)
  let announce, aborted = false
  const entered = new Promise(resolve => { announce = resolve })
  const host = new PluginHost(f.home, { ...f.options,
    updateSources: () => [{ id: 'company', url: 'https://updates.test/index.json' }],
    fetchUpdates: async (_url, options) => new Promise((_resolve, reject) => {
      announce()
      options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason) }, { once: true })
    }) })
  t.after(() => host.close())
  host.start()
  await entered
  assert.equal(host.status().updates.phase, 'checking')
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0', 'slow discovery must not block the local runtime')
  assert.equal(host.status().runtimes.every(runtime => runtime.phase === 'ready'), true)
  host.setAutomaticUpdates(false)
  await host.close()
  assert.equal(aborted, true)
  assert.equal(host.status().automaticUpdates, false)
  assert.equal(host.status().updates.phase, 'cancelled')
})

test('Core plugin management API uses the managed default client and rejects foreign-origin mutations', async t => {
  const f = await fixture(t)
  const host = new PluginHost(f.home, f.options)
  const app = createCoreApp({ home: join(f.root, 'app'), pluginHost: host, startAgentRuntime: false })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(() => app.close())
  const base = `http://127.0.0.1:${app.server.address().port}`
  const foreign = await fetch(`${base}/api/plugin-runtime/policy`, { method: 'POST',
    headers: { Origin: 'http://foreign.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ automaticUpdates: false }) })
  assert.equal(foreign.status, 403)
  const checked = await fetch(`${base}/api/plugin-runtime/reconcile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(checked.status, 200)
  const status = await checked.json()
  assert.equal(status.runtimes.every(runtime => runtime.phase === 'ready'), true, JSON.stringify(status.runtimes))
  assert.equal(status.revisions.length, 2)
  const probe = await fetch(`${base}/api/plugins/icepak/probe`)
  assert.equal(probe.status, 200)
  const pinned = await host.icepak.pinRuntime()
  assert.equal(pinned.identity.packageDigest, status.active['icepak-pyaedt'].current)
  pinned.release()
  const policy = await fetch(`${base}/api/plugin-runtime/policy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"automaticUpdates":false}' })
  assert.equal((await policy.json()).automaticUpdates, false)
  assert.equal(JSON.parse(await readFile(join(f.home, 'policy.json'), 'utf8')).automaticUpdates, false)
})

test('host admits automatic repair for a failed active environment and persists the separate policy', async t => {
  const f = await fixture(t)
  const entry = join(f.options.icepak.pluginRoot, 'adapter', '__main__.py'), marker = join(f.root, 'break-protocol')
  await writeFile(entry, (await readFile(entry, 'utf8')).replace('print(json.dumps',
    `import os\nif r['method']=='probe_environment' and os.path.exists(${JSON.stringify(marker)}):\n print('invalid protocol'); sys.exit(0)\nprint(json.dumps`))
  let host = new PluginHost(f.home, f.options)
  t.after(() => host.close())
  await host.icepak.probeEnvironment()
  assert.equal(host.status().automaticRepair, false)
  host.setAutomaticRepair(true)
  assert.deepEqual(host.repairJobInputs().targets, [])
  const pinned = await host.icepak.pinRuntime()
  await writeFile(marker, 'fail')
  await assert.rejects(pinned.port.probeEnvironment(), /invalid JSON/)
  assert.equal(host.repairJobInputs().canDispatch, false)
  pinned.release()
  await host.reconcile()
  const input = host.repairJobInputs()
  assert.equal(input.enabled, true)
  assert.deepEqual(input.targets, [{ basePackageDigest: pinned.identity.packageDigest, environmentDigest: pinned.identity.environmentDigest }])
  let dispatched = 0, stopped = 0
  const transport = { dispatch: async () => { dispatched++ }, stop: async () => { stopped++ } }
  await host.repairJobs.reconcile(() => host.repairJobInputs(), transport)
  assert.equal(dispatched, 1)
  host.setAutomaticUpdates(false)
  await host.repairJobs.reconcile(() => host.repairJobInputs(), transport)
  assert.equal(stopped, 1)
  assert.equal(host.status().repairJobs.jobs[0].state, 'cancelled')
  await host.close()
  host = new PluginHost(f.home, f.options)
  assert.equal(host.status().automaticRepair, true)
  assert.equal(host.status().automaticUpdates, false)
  assert.equal(host.status().repairJobs.jobs[0].state, 'cancelled')
  host.setAutomaticUpdates(true)
  await host.reconcile()
  await host.repairJobs.reconcile(() => host.repairJobInputs(), transport)
  assert.equal(dispatched, 1)
})

test('business compatibility symptoms reach repair context without quarantining or replaying work', async t => {
  const f = await fixture(t), marker = join(f.root, 'business-error')
  const entry = join(f.options.icepak.pluginRoot, 'adapter', '__main__.py')
  const manifestPath = join(f.options.icepak.pluginRoot, 'plugin.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.capabilities.push('project_inspect'); await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(entry, (await readFile(entry, 'utf8')).replace("'ok' if r['method']=='health' else 'NOT_INSTALLED'", "'ok'").replace('print(json.dumps',
    `import os\nif r['method']=='inspect_project' and os.path.exists(${JSON.stringify(marker)}):\n code=open(${JSON.stringify(marker)}).read(); print(json.dumps({'id':r['id'],'ok':False,'error':{'code':code,'message':'compatibility fixture'}})); sys.exit(0)\nprint(json.dumps`))
  let host = new PluginHost(f.home, f.options)
  t.after(() => host.close())
  host.setAutomaticRepair(true)
  await host.reconcile()
  await writeFile(marker, 'VALUEERROR')
  await assert.rejects(host.icepak.inspectProject({}), /VALUEERROR/)
  assert.deepEqual(host.repairJobInputs().targets, [], 'ordinary input errors do not trigger repair')
  for (const code of ['ATTRIBUTEERROR', 'TYPEERROR', 'MODULENOTFOUNDERROR', 'IMPORTERROR']) {
    await writeFile(marker, code)
    await assert.rejects(host.icepak.inspectProject({}), error => error.code === code)
  }
  const targets = host.repairJobInputs().targets
  assert.equal(targets.length, 1)
  const context = host.repairContext(targets[0].basePackageDigest, 'python/adapter/__main__.py')
  let dispatched = 0, stopped = 0
  const transport = { dispatch: async job => { dispatched++; assert.equal(job.basePackageDigest, targets[0].basePackageDigest) }, stop: async () => { stopped++ } }
  await host.repairJobs.reconcile(() => host.repairJobInputs(), transport)
  assert.equal(dispatched, 1, 'a passing health receipt does not hide a captured business failure')
  assert.equal(context.executionFailures.length, 1)
  assert.equal(context.executionFailures[0].method, 'inspect_project')
  assert.equal(context.executionFailures[0].code, 'IMPORTERROR')
  assert.ok(context.validations.every(item => item.passed), 'business symptoms never revoke a host validation')
  assert.equal(host.status().runtimes.find(item => item.kind === 'icepak').phase, 'ready')
  const candidate = host.stageRepairCandidate({ schemaVersion: 1, ...targets[0], version: '1.0.1', reason: 'Business fixture',
    files: [{ path: context.source.path, content: context.source.content + '\n# staged diagnostic fixture\n' }] })
  assert.equal(candidate.executionFailures[0].code, 'IMPORTERROR')
  await host.repairJobs.reconcile(() => host.repairJobInputs(), transport)
  assert.equal(stopped, 1)
  assert.equal(host.status().repairJobs.jobs[0].state, 'candidate-ready')
  await host.close()
  host = new PluginHost(f.home, f.options)
  assert.deepEqual(host.repairJobInputs().targets, [], 'restart has not inspected the current runtime')
  await host.reconcile()
  assert.deepEqual(host.repairJobInputs().targets, targets)
  await host.repairJobs.reconcile(() => host.repairJobInputs(), transport)
  assert.equal(dispatched, 1, 'business failure does not consume the model again after restart')
  await host.icepak.probeEnvironment()
  assert.deepEqual(host.repairJobInputs().targets, targets, 'another method succeeding cannot clear this failure')
  await rm(marker)
  await host.icepak.inspectProject({})
  assert.deepEqual(host.repairJobInputs().targets, [])
  assert.equal(host.status().executionFailures.length, 0)
})

test('first-start validation failure admits one repair without an active revision and refresh rejects stale evidence', async t => {
  const f = await fixture(t)
  const entry = join(f.options.icepak.pluginRoot, 'adapter', '__main__.py')
  await writeFile(entry, (await readFile(entry, 'utf8')).replace("'status':'ok'", "'status':'broken'"))
  let unavailable = false
  let inspectionGate, inspectionEntered
  f.options.inspect = async () => {
    if (inspectionGate) { inspectionEntered(); await inspectionGate }
    if (unavailable) throw new Error('environment inspection unavailable')
    return { executable, environment: structuredClone(environment) }
  }
  let host = new PluginHost(f.home, f.options)
  t.after(() => host.close())
  host.setAutomaticRepair(true)
  await host.reconcile()
  assert.equal(host.status().active['icepak-pyaedt'], undefined)
  const targets = host.repairJobInputs().targets
  assert.equal(targets.length, 1)
  const evidence = host.repairContext(targets[0].basePackageDigest).validations
  assert.ok(evidence.some(item => !item.passed && item.environmentDigest === targets[0].environmentDigest))
  let dispatched = 0, stopped = 0
  const transport = { dispatch: async () => { dispatched++ }, stop: async () => { stopped++ } }
  await host.repairJobs.reconcile(() => host.repairJobInputs(), transport)
  assert.equal(dispatched, 1)
  await host.close()
  host = new PluginHost(f.home, f.options)
  assert.deepEqual(host.repairJobInputs().targets, [], 'restart requires a current environment scan')
  await host.reconcile()
  assert.deepEqual(host.repairJobInputs().targets, targets)
  await host.repairJobs.reconcile(() => host.repairJobInputs(), transport)
  assert.equal(dispatched, 1, 'first-start failure deduplicates across restart')
  assert.equal(stopped, 1)
  unavailable = true
  let resumeInspection, markInspectionEntered
  const entered = new Promise(resolve => { markInspectionEntered = resolve })
  inspectionEntered = markInspectionEntered
  inspectionGate = new Promise(resolve => { resumeInspection = resolve })
  host.setAutomaticUpdates(false); host.setAutomaticUpdates(true)
  const checking = host.reconcile()
  try {
    await entered
    assert.deepEqual(host.repairJobInputs().targets, targets, 'a scan in progress does not invalidate a running repair')
    assert.equal(host.repairJobInputs().canDispatch, false)
  } finally { resumeInspection(); await checking; inspectionGate = undefined }
  assert.deepEqual(host.repairJobInputs().targets, [], 'failed new inspection cannot reuse the previous failure as current evidence')
  unavailable = false
  host.setAutomaticUpdates(false); host.setAutomaticUpdates(true)
  await host.reconcile()
  assert.deepEqual(host.repairJobInputs().targets, targets)
  const context = host.repairContext(targets[0].basePackageDigest, 'python/adapter/__main__.py')
  const candidate = host.stageRepairCandidate({ schemaVersion: 1, ...targets[0], version: '1.0.1', reason: 'First-start health compatibility fixture',
    files: [{ path: context.source.path, content: context.source.content.replace("'status':'broken'", "'status':'ok'") }] })
  assert.equal(candidate.status, 'awaiting-isolated-validation')
  assert.equal(host.status().active['icepak-pyaedt'], undefined, 'source staging does not grant execution permission')
  host.setAutomaticRepair(false)
  assert.equal(host.repairJobInputs().enabled, false)
})

test('host repairs missing AEDT launch variables in real Python calls and preserves pinned launch settings', async t => {
  const f = await fixture(t)
  const programFiles = join(f.root, 'Program Files'), install = join(programFiles, 'ANSYS Inc', 'v261', 'AnsysEM')
  await mkdir(install, { recursive: true }); await writeFile(join(install, 'ansysedt.exe'), 'NOT AEDT: installation inventory fixture')
  const canonicalInstall = await realpath(install)
  const previousProgramFiles = process.env.ProgramFiles, previousRoot = process.env.ANSYSEM_ROOT261
  process.env.ProgramFiles = programFiles; delete process.env.ANSYSEM_ROOT261
  t.after(() => {
    if (previousProgramFiles === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = previousProgramFiles
    if (previousRoot === undefined) delete process.env.ANSYSEM_ROOT261; else process.env.ANSYSEM_ROOT261 = previousRoot
  })
  for (const kind of ['icepak', 'report']) {
    const path = join(f.options[kind].pluginRoot, 'plugin.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.compatibility.platforms = ['win32']; await writeFile(path, JSON.stringify(manifest))
  }
  f.options.inspect = async () => ({ executable, environment: { ...structuredClone(environment), platform: 'win32' } })
  const entry = join(f.options.icepak.pluginRoot, 'adapter', '__main__.py')
  await writeFile(entry, (await readFile(entry, 'utf8')).replace('import sys,json', 'import sys,json,os')
    .replace("'aedtVersions':[]", "'aedtVersions':[], 'launchRoot':os.environ.get('ANSYSEM_ROOT261')"))
  let host = new PluginHost(f.home, f.options)
  t.after(() => host.close())
  host.setAutomaticUpdates(false)
  assert.equal((await host.icepak.probeEnvironment()).launchRoot, null)
  const unboundIdentity = (await host.icepak.pinRuntime())
  const unboundDigest = unboundIdentity.identity.environmentDigest
  unboundIdentity.release()
  host.setAutomaticUpdates(true)
  assert.equal((await host.icepak.probeEnvironment()).launchRoot, canonicalInstall)
  const pinned = await host.icepak.pinRuntime()
  const identity = pinned.identity
  assert.notEqual(identity.environmentDigest, unboundDigest)
  assert.equal(host.status().runtimes.find(item => item.id === 'icepak-pyaedt').aedtBindings.repairs[0].path, canonicalInstall)
  const conflicting = join(f.root, 'other-install')
  await mkdir(conflicting); await writeFile(join(conflicting, 'ansysedt.exe'), 'other fixture')
  process.env.ANSYSEM_ROOT261 = conflicting
  try {
    await host.reconcile()
    assert.equal((await pinned.port.probeEnvironment()).launchRoot, canonicalInstall, 'live workflow retains the captured binding')
  } finally { pinned.release() }
  await host.reconcile()
  assert.equal((await host.icepak.probeEnvironment()).launchRoot, conflicting, 'new work honors a valid explicit setting')
  delete process.env.ANSYSEM_ROOT261
  await host.close()
  host = new PluginHost(f.home, f.options)
  assert.equal((await host.icepak.probeEnvironment()).launchRoot, canonicalInstall, 'restart reconstructs the same automatic repair')
  assert.equal(process.env.ANSYSEM_ROOT261, undefined, 'repair does not change the parent environment')
  assert.equal(host.status().revisions.find(item => item.digest === identity.packageDigest).manifest.version, identity.pluginVersion)
})

for (const automatic of [true, false]) test(`runtime protocol quarantine respects pins, restart and automatic updates=${automatic}`, async t => {
  const f = await fixture(t)
  let host = new PluginHost(f.home, f.options)
  t.after(() => host.close())
  await host.icepak.probeEnvironment()
  const previous = host.status().active['icepak-pyaedt'].current
  await host.close()
  await f.source('icepak', '2.0.0')
  const entry = join(f.options.icepak.pluginRoot, 'adapter', '__main__.py'), marker = join(f.root, 'break-protocol')
  await writeFile(entry, (await readFile(entry, 'utf8')).replace('print(json.dumps',
    `import os\nif r['method']=='probe_environment' and os.path.exists(${JSON.stringify(marker)}):\n print('invalid protocol'); sys.exit(0)\nprint(json.dumps`))
  host = new PluginHost(f.home, f.options)
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '2.0.0')
  const broken = host.status().active['icepak-pyaedt'].current
  host.setAutomaticUpdates(automatic)
  const pinned = await host.icepak.pinRuntime(), other = await host.icepak.pinRuntime()
  await writeFile(marker, 'fail')
  try {
    await assert.rejects(pinned.port.probeEnvironment(), /invalid JSON/)
    assert.equal(host.isCurrentIcepakRuntime(pinned.identity), false)
    const receipt = host.status().validations.find(item => item.packageDigest === broken && item.environmentDigest === pinned.identity.environmentDigest)
    assert.equal(receipt.passed, false)
    assert.equal(receipt.checks.at(-1).name, 'runtime-protocol')
    await host.reconcile()
    await assert.rejects(host.rollback('icepak-pyaedt'), /busy/)
    assert.equal(host.status().active['icepak-pyaedt'].current, broken, 'other pinned work retains the active revision')
  } finally { pinned.release(); other.release() }
  if (!automatic) {
    await assert.rejects(host.icepak.probeEnvironment(), /Previous validation failed/)
    assert.equal(host.status().active['icepak-pyaedt'].current, broken)
    await host.close()
    host = new PluginHost(f.home, f.options)
    await assert.rejects(host.icepak.probeEnvironment(), /Previous validation failed/)
    assert.equal(host.status().active['icepak-pyaedt'].current, broken)
    await host.rollback('icepak-pyaedt')
    assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
    assert.equal(host.status().held['icepak-pyaedt'], previous)
    assert.equal(host.status().automaticUpdates, false)
    assert.equal(host.status().runtimes.find(item => item.id === 'icepak-pyaedt').retry, undefined)
    await host.close()
    host = new PluginHost(f.home, f.options)
    assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
    return
  }
  // The final pin release schedules recovery; no failed business call is retried.
  for (let i = 0; i < 100 && host.status().active['icepak-pyaedt'].current !== previous; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(host.status().active['icepak-pyaedt'].current, previous)
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
  await host.close()
  host = new PluginHost(f.home, f.options)
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
  assert.equal(host.status().events.filter(event => event.action === 'runtime-protocol-failed' && event.digest === broken).length, 1)
})

test('unavailable runtime retries back off across calls and reconcile, then reset on real policy changes', async t => {
  const f = await fixture(t)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  let inspections = 0, failing = true
  const inspect = f.options.inspect
  const host = new PluginHost(f.home, { ...f.options, inspect: async (python, distributions) => {
    if (distributions.includes('pyaedt')) { inspections++; if (failing) throw new Error('Python unavailable fixture') }
    return inspect(python, distributions)
  } })
  t.after(() => host.close())
  await assert.rejects(host.icepak.probeEnvironment(), /Python unavailable/)
  const first = host.status().runtimes.find(item => item.id === 'icepak-pyaedt').retry
  assert.equal(Date.parse(first.nextRetryAt) - Date.now(), 30_000)
  for (let i = 0; i < 4; i++) {
    await assert.rejects(host.icepak.probeEnvironment(), /Python unavailable/)
    await host.reconcile()
  }
  assert.equal(inspections, 1, 'DSH reconciliation cannot bypass unavailable runtime throttling')
  host.setAutomaticUpdates(true)
  await assert.rejects(host.icepak.probeEnvironment(), /Python unavailable/)
  assert.equal(inspections, 1, 'writing an unchanged policy is not new evidence')
  for (const expectedDelay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
    const retry = host.status().runtimes.find(item => item.id === 'icepak-pyaedt').retry
    t.mock.timers.tick(Date.parse(retry.nextRetryAt) - Date.now())
    await assert.rejects(host.icepak.probeEnvironment(), /Python unavailable/)
    assert.equal(Date.parse(host.status().runtimes.find(item => item.id === 'icepak-pyaedt').retry.nextRetryAt) - Date.now(), expectedDelay)
  }
  assert.equal(inspections, 6)
  failing = false
  host.setAutomaticUpdates(false)
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
  assert.equal(inspections, 7)
  assert.equal(host.status().runtimes.find(item => item.id === 'icepak-pyaedt').retry, undefined)
})


for (const delivery of ['import', 'feed']) test(`new signed release via ${delivery} bypasses retry delay once; duplicate import does not`, async t => {
  const f = await fixture(t), { privateKey, publicKey } = generateKeyPairSync('ed25519')
  let inspections = 0, release
  const host = new PluginHost(f.home, { ...f.options,
    updateSources: () => delivery === 'feed' ? [{ id: 'fixture', url: 'https://updates.test/index.json' }] : [],
    fetchUpdates: async url => url.endsWith('index.json') ? Response.json({ schemaVersion: 1, releases: [{ url: 'release.json', sha256: createHash('sha256').update(release).digest('hex') }] }) : new Response(release),
    publishers: () => [{ id: 'fixture', pluginIds: ['report-reportlab'], publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
    inspect: async (python, distributions) => {
      if (distributions.includes('reportlab')) { inspections++; throw new Error('report unavailable fixture') }
      return f.options.inspect(python, distributions)
    } })
  t.after(() => host.close())
  await assert.rejects(host.report.renderTaskReport({}), /report unavailable/)
  const source = await f.source('report', '2.0.0')
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, publishedAt: '2026-10-19T00:00:00Z', files: {
    'plugin.json': (await readFile(join(source.pluginRoot, 'plugin.json'))).toString('base64'),
    'python/adapter/__main__.py': (await readFile(join(source.pluginRoot, 'adapter', '__main__.py'))).toString('base64'),
  } }))
  release = Buffer.from(JSON.stringify({ schemaVersion: 1, publisherId: 'fixture', payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }))
  if (delivery === 'feed') await host.reconcile()
  else host.installRelease(release)
  await assert.rejects(host.report.renderTaskReport({}), /report unavailable/)
  assert.equal(inspections, 2)
  host.installRelease(release)
  await assert.rejects(host.report.renderTaskReport({}), /report unavailable/)
  assert.equal(inspections, 2)
})


for (const failure of ['changed-environment', 'corrupt-previous', 'corrupt-active']) test(`explicit rollback checks its own target: ${failure}`, async t => {
  const f = await fixture(t)
  let changed = false
  const options = { ...f.options, inspect: async (...args) => {
    const snapshot = await f.options.inspect(...args)
    if (changed) snapshot.environment.versions.python = 'different-runtime'
    return snapshot
  } }
  let host = new PluginHost(f.home, options)
  t.after(() => host.close())
  await host.icepak.probeEnvironment()
  const previous = host.status().active['icepak-pyaedt'].current
  await host.close()
  await f.source('icepak', '2.0.0')
  host = new PluginHost(f.home, options)
  await host.icepak.probeEnvironment()
  const current = host.status().active['icepak-pyaedt'].current
  host.setAutomaticUpdates(false)
  if (failure === 'changed-environment') changed = true
  else await writeFile(join(f.home, 'registry', 'packages', failure === 'corrupt-previous' ? previous : current, 'python', 'adapter', '__main__.py'), 'raise RuntimeError("changed bytes")')
  if (failure === 'corrupt-active') {
    await host.rollback('icepak-pyaedt')
    assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
    assert.equal(host.status().held['icepak-pyaedt'], previous)
  } else {
    await assert.rejects(host.rollback('icepak-pyaedt'), failure === 'changed-environment' ? /no passing validation/ : /integrity|changed|digest/i)
    assert.equal(host.status().active['icepak-pyaedt'].current, current)
    assert.equal(host.status().held['icepak-pyaedt'], undefined)
  }
})

test('overlapping rollback requests cannot toggle versions or invalidate the successful recovery', async t => {
  const f = await fixture(t)
  let host = new PluginHost(f.home, f.options)
  t.after(() => host.close())
  await host.icepak.probeEnvironment()
  const previous = host.status().active['icepak-pyaedt'].current
  await host.close()
  await f.source('icepak', '2.0.0')
  host = new PluginHost(f.home, f.options)
  await host.icepak.probeEnvironment()
  const results = await Promise.allSettled([host.rollback('icepak-pyaedt'), host.rollback('icepak-pyaedt')])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.match(results[1].reason.message, /target changed/)
  assert.equal(host.status().active['icepak-pyaedt'].current, previous)
  assert.equal(host.status().runtimes.find(item => item.id === 'icepak-pyaedt').error, undefined)
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
})


test('DSH repair proposals archive untrusted source with host evidence and never enter the executable registry', async t => {
  const f = await fixture(t)
  let host = new PluginHost(f.home, f.options)
  const database = new LocalDatabase(join(f.root, 'bridge.sqlite'))
  let bridge = new ThermalToolsBridge(f.root, database, host.icepak, 'fixture', host)
  const address = await bridge.start()
  t.after(async () => { await bridge.stop(); database.close(); await host.close() })
  await host.icepak.probeEnvironment()
  const active = host.status().active['icepak-pyaedt'].current
  const context = host.repairContext(active)
  const path = 'python/adapter/__main__.py'
  assert.match(host.repairContext(active, path).source.content, /pluginVersion/)
  assert.throws(() => host.repairContext(active, '../policy.json'), /listed Python/)
  const marker = join(f.root, 'candidate-executed')
  const proposal = { schemaVersion: 1, basePackageDigest: active, environmentDigest: context.validations[0].environmentDigest,
    version: '1.0.1', reason: 'Fixture candidate; not engineering validation',
    files: [{ path, content: `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('must never run')\n` }] }
  const request = async (path, body, authenticated = true) => fetch(`${address.url}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${address.token}` } : {}) }, body: JSON.stringify(body) })
  assert.equal((await request('/v1/plugins/repair-candidates', proposal, false)).status, 401)
  const read = await request('/v1/plugins/repair-context', { packageDigest: active, path })
  assert.equal(read.status, 200); assert.equal((await read.json()).source.path, path)
  const response = await request('/v1/plugins/repair-candidates', proposal)
  assert.equal(response.status, 201)
  const result = await response.json(), candidate = result.candidate
  assert.equal(result.executed, false); assert.equal(result.activated, false)
  assert.equal(candidate.status, 'awaiting-isolated-validation')
  const candidateManifest = JSON.parse(await readFile(join(f.home, 'repair-candidates', candidate.id, 'registry', 'packages', candidate.packageDigest, 'plugin.json'), 'utf8'))
  assert.deepEqual(candidateManifest, { ...context.base.manifest, version: '1.0.1' })
  assert.deepEqual(candidate.evidence, context.validations[0])
  assert.deepEqual(host.stageRepairCandidate(proposal), candidate, 'identical proposals are idempotent')
  assert.equal(host.status().repairCandidates.candidates.length, 1)
  assert.equal(host.store.list().revisions.some(item => item.digest === candidate.packageDigest), false)
  await host.reconcile()
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  for (const bad of [
    { ...proposal, environmentDigest: 'f'.repeat(64) },
    { ...proposal, basePackageDigest: 'f'.repeat(64) },
    { ...proposal, permissions: ['arbitrary-execution'] },
    { ...proposal, version: '1'.repeat(81) + '.0.0' },
    { ...proposal, files: [{ path: '../escape.py', content: 'pass' }] },
    { ...proposal, files: [{ path: 'plugin.json', content: '{}' }] },
    { ...proposal, files: [{ path: 'python/NUL.py', content: 'pass' }] },
    { ...proposal, files: [{ path, content: 'a'.repeat(1024 * 1024 + 1) }] },
    { ...proposal, files: [{ path, content: null }] },
    { ...proposal, files: [{ path, content: host.repairContext(active, path).source.content }] },
  ]) assert.throws(() => host.stageRepairCandidate(bad))
  assert.equal(host.status().repairCandidates.candidates.length, 1)
  assert.equal(host.status().active['icepak-pyaedt'].current, active)
  await bridge.stop(); await host.close()
  host = new PluginHost(f.home, f.options)
  assert.deepEqual(host.status().repairCandidates.candidates[0], candidate)
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
  const candidateSource = join(f.home, 'repair-candidates', candidate.id, 'registry', 'packages', candidate.packageDigest, path)
  await writeFile(candidateSource, 'changed after staging')
  assert.throws(() => host.stageRepairCandidate(proposal), /integrity|changed|digest/i)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  for (let i = 1; i < 32; i++) host.stageRepairCandidate({ ...proposal, reason: `separate proposal ${i}` })
  assert.equal(host.status().repairCandidates.candidates.length, 32)
  assert.throws(() => host.stageRepairCandidate({ ...proposal, reason: 'one too many' }), /storage is full/)
})
