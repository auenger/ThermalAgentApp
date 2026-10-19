import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
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
