import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginStore, pluginEnvironmentDigest } from '../apps/core/dist/plugin-store.js'
import { PluginAdaptationController } from '../apps/core/dist/plugin-adaptation.js'
import { managedPythonRuntime } from '../apps/core/dist/plugin-python-runtime.js'
import { IcepakPluginClient } from '../apps/core/dist/icepak-plugin-client.js'
import { ReportClient } from '../apps/core/dist/report-client.js'

const python = process.env.THERMAL_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const environment = { platform: process.platform, architecture: process.arch, versions: { fixture: '1' } }

async function fixture(t, kind = 'icepak') {
  const root = await mkdtemp(join(tmpdir(), 'thermal-adapt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new PluginStore(join(root, 'store'))
  const id = `test-${kind}`
  async function install(version, options = {}) {
    const source = join(root, version)
    await mkdir(join(source, 'python', 'adapter'), { recursive: true })
    await writeFile(join(source, 'plugin.json'), JSON.stringify({ schemaVersion: 1, hostApi: 1, id, version, kind,
      entry: { root: 'python', module: 'adapter' }, capabilities: kind === 'report' ? ['render-task-report'] : ['environment_probe'], permissions: options.permissions ?? [],
      compatibility: { platforms: [process.platform], architectures: [process.arch], versions: { fixture: options.versions ?? ['1'] } } }))
    await writeFile(join(source, 'python', 'adapter', '__init__.py'), '')
    await writeFile(join(source, 'python', 'adapter', '__main__.py'), `import json, sys, time\nr=json.loads(sys.stdin.readline())\ntime.sleep(${options.delay ?? 0})\nprint(json.dumps({'id':r['id'],'ok':True,'result':{'pluginId':'${id}','pluginVersion':'${version}'}}))\n`)
    return store.install(source)
  }
  const validate = async lease => {
    const client = new IcepakPluginClient({ acquireRuntime: () => ({ python, pluginRoot: lease.root, module: 'adapter', release() {} }) })
    const result = await client.health()
    return [{ name: 'identity', passed: result.pluginVersion === lease.revision.manifest.version, detail: 'Real Python protocol round trip; not AEDT validation' }]
  }
  const controller = new PluginAdaptationController(store)
  const policy = () => ({ enabled: true, trustedDigests: store.list().revisions.map(item => item.digest), permissions: [] })
  return { root, id, store, controller, policy, install, validate }
}

test('probe identity comes from the host lease and cannot be supplied by Python output', async t => {
  const f = await fixture(t)
  const root = join(f.root, 'untrusted-probe')
  await mkdir(root)
  await writeFile(join(root, 'adapter.py'), `import json,sys\nr=json.loads(sys.stdin.readline())\nprint(json.dumps({'id':r['id'],'ok':True,'result':{'pluginId':'spoofed','pluginVersion':'99.0.0','pluginRuntime':{'packageDigest':'fake'},'status':'READY','platform':'win32','pyaedtAvailable':True,'licenseStatus':'AVAILABLE','readinessVerifiedAt':'fake'}}))\n`)
  const identity = { pluginId: 'icepak-pyaedt', pluginVersion: '1.0.0', packageDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) }
  const client = new IcepakPluginClient({ acquireRuntime: () => ({ python, pluginRoot: root, module: 'adapter', identity, release() {} }) })
  for (const probe of [await client.probeEnvironment(), await client.probeLaunchability()]) {
    assert.equal(probe.pluginId, identity.pluginId)
    assert.equal(probe.pluginVersion, identity.pluginVersion)
    assert.deepEqual(probe.pluginRuntime, identity)
    assert.equal(probe.status, 'DETECTED')
    assert.equal(probe.licenseStatus, 'UNKNOWN')
    assert.equal(probe.readinessVerifiedAt, undefined)
  }
  const unmanaged = new IcepakPluginClient({ acquireRuntime: () => ({ python, pluginRoot: root, module: 'adapter', release() {} }) })
  assert.equal((await unmanaged.probeEnvironment()).pluginRuntime, undefined)
})

test('environment selects a compatible verified revision and real Python calls use it without a client rebuild', async t => {
  const f = await fixture(t)
  const first = await f.install('1.0.0')
  const second = await f.install('2.0.0', { versions: ['2'] })
  let currentEnvironment = environment
  const client = new IcepakPluginClient({ acquireRuntime: managedPythonRuntime(f.store, f.id, 'icepak', python, () => currentEnvironment) })
  const initial = await f.controller.reconcile(f.id, environment, f.policy(), f.validate)
  assert.equal(initial.digest, first.digest)
  assert.equal((await client.health()).pluginVersion, '1.0.0')
  currentEnvironment = { ...environment, versions: { fixture: '2' } }
  await assert.rejects(client.health(), /fixture|environment changed/)
  const adapted = await f.controller.reconcile(f.id, currentEnvironment, f.policy(), f.validate)
  assert.equal(adapted.digest, second.digest)
  assert.equal((await client.health()).pluginVersion, '2.0.0')
  f.store.verify(second.digest) // Importing a Python package did not add __pycache__.
  assert.equal((await f.controller.reconcile(f.id, currentEnvironment, f.policy(), f.validate)).status, 'unchanged')
})

test('failed newest revision is quarantined and automatic selection falls back to a passing one', async t => {
  const f = await fixture(t)
  const first = await f.install('1.0.0')
  const bad = await f.install('1.1.0')
  let failures = 0
  const validator = async lease => {
    if (lease.revision.digest === bad.digest) { failures++; throw new Error('Fixture readback failed') }
    return f.validate(lease)
  }
  const result = await f.controller.reconcile(f.id, environment, f.policy(), validator)
  assert.equal(result.digest, first.digest)
  assert.equal(failures, 1)
  assert.equal((await f.controller.reconcile(f.id, environment, f.policy(), validator)).status, 'unchanged')
  assert.equal(failures, 1)
})

test('repair evidence uses each attempted dependency environment and disappears when a usable revision is found', async t => {
  const f = await fixture(t)
  const first = await f.install('1.0.0'), second = await f.install('2.0.0', { versions: ['2'] })
  const resolveEnvironment = async revision => ({ ...environment, versions: { fixture: revision.digest === second.digest ? '2' : '1' } })
  const fail = async () => [{ name: 'compatibility', passed: false, detail: 'fixture failure' }]
  const result = await f.controller.reconcile(f.id, environment, f.policy(), fail, resolveEnvironment)
  assert.equal(result.status, 'unavailable')
  const expected = await Promise.all([second, first].map(async revision => ({ basePackageDigest: revision.digest,
    environmentDigest: pluginEnvironmentDigest(await resolveEnvironment(revision)) })))
  assert.deepEqual(result.failedCandidates, expected)
  const repeated = await f.controller.reconcile(f.id, environment, f.policy(), () => { throw new Error('must reuse receipts') }, resolveEnvironment)
  assert.deepEqual(repeated.failedCandidates, expected)
  await f.store.validate(first.digest, await resolveEnvironment(first), f.validate)
  const recovered = await f.controller.reconcile(f.id, environment, f.policy(), f.validate, resolveEnvironment)
  assert.equal(recovered.digest, first.digest)
  assert.equal(recovered.failedCandidates, undefined, 'a failed newer version alone does not request repair after fallback succeeds')
})

test('temporary engineering gate deferral is retriable and does not quarantine the package', async t => {
  const f = await fixture(t)
  const revision = await f.install('1.0.0')
  const deferred = await f.controller.reconcile(f.id, environment, f.policy(), async () => {
    throw Object.assign(new Error('shared gate is busy'), { code: 'VALIDATION_DEFERRED' })
  })
  assert.equal(deferred.status, 'busy'); assert.equal(f.store.list().validations.length, 0)
  assert.equal((await f.controller.reconcile(f.id, environment, f.policy(), f.validate)).digest, revision.digest)
})

test('managed clients reject undeclared engineering capabilities before executing plugin code', async t => {
  const f = await fixture(t)
  await f.install('1.0.0'); await f.controller.reconcile(f.id, environment, f.policy(), f.validate)
  const client = new IcepakPluginClient({ acquireRuntime: managedPythonRuntime(f.store, f.id, 'icepak', python, () => environment) })
  await assert.rejects(client.checkChanges({}), /does not declare capability/)
  await assert.rejects(client.prepareModel({}), /does not declare capability/)
  assert.equal(f.store.isBusy(f.id), false)
  assert.equal((await client.probeEnvironment()).pluginVersion, '1.0.0')
})

test('automatic adaptation respects trust, permission growth, prereleases and live Python work', async t => {
  const f = await fixture(t)
  const first = await f.install('1.0.0', { delay: 0.15 })
  await f.controller.reconcile(f.id, environment, f.policy(), f.validate)
  const next = await f.install('1.1.0')
  await f.install('2.0.0', { permissions: ['network'] })
  await f.install('3.0.0-preview')
  const client = new IcepakPluginClient({ acquireRuntime: managedPythonRuntime(f.store, f.id, 'icepak', python, () => environment) })
  const working = client.health()
  assert.equal((await f.controller.reconcile(f.id, environment, f.policy(), f.validate)).status, 'busy')
  assert.equal((await working).pluginVersion, '1.0.0')
  const untrusted = await f.controller.reconcile(f.id, environment, { ...f.policy(), trustedDigests: [first.digest] }, f.validate)
  assert.equal(untrusted.status, 'unchanged')
  const result = await f.controller.reconcile(f.id, environment, f.policy(), f.validate)
  assert.equal(result.digest, next.digest)
})

test('report process uses the same managed revisions and releases its lease after timeout', async t => {
  const f = await fixture(t, 'report')
  await f.install('1.0.0', { delay: 0.3 })
  await f.controller.reconcile(f.id, environment, f.policy(), f.validate)
  const client = new ReportClient({ timeoutMs: 50, acquireRuntime: managedPythonRuntime(f.store, f.id, 'report', python, () => environment) })
  const pending = client.renderTaskReport({})
  assert.equal(f.store.isBusy(f.id), true)
  await assert.rejects(pending, /timed out/)
  assert.equal(f.store.isBusy(f.id), false)
})

test('a workflow pin prevents switching between calls and can restore its recorded old revision', async t => {
  const f = await fixture(t)
  const first = await f.install('1.0.0')
  await f.controller.reconcile(f.id, environment, f.policy(), f.validate)
  const client = new IcepakPluginClient({ acquireRuntime: managedPythonRuntime(f.store, f.id, 'icepak', python, () => environment) })
  const workflow = await client.pinRuntime()
  assert.equal(workflow.identity.packageDigest, first.digest)
  assert.equal((await workflow.port.probeEnvironment()).pluginVersion, '1.0.0')
  const next = await f.install('2.0.0')
  assert.equal((await f.controller.reconcile(f.id, environment, f.policy(), f.validate)).status, 'busy')
  assert.equal((await workflow.port.probeEnvironment()).pluginVersion, '1.0.0')
  workflow.release()
  await assert.rejects(workflow.port.probeEnvironment(), /lease has ended/)
  assert.equal((await f.controller.reconcile(f.id, environment, f.policy(), f.validate)).digest, next.digest)
  const retry = await client.pinRuntime(workflow.identity)
  assert.equal((await retry.port.probeEnvironment()).pluginVersion, '1.0.0')
  retry.release()
  const wrongEnvironment = { ...workflow.identity, environmentDigest: '0'.repeat(64) }
  await assert.rejects(client.pinRuntime(wrongEnvironment), /environment/)
  assert.equal(f.store.isBusy(f.id), false)
})

test('runtime protocol quarantine is durable and scoped to the observed environment', async t => {
  const f = await fixture(t), revision = await f.install('1.0.0', { versions: ['1', '2'] })
  const other = { ...environment, versions: { fixture: '2' } }
  await f.controller.reconcile(f.id, environment, f.policy(), f.validate)
  await f.store.validate(revision.digest, other, f.validate)
  const receipt = f.store.list().validations.find(item => item.environmentDigest === pluginEnvironmentDigest(environment))
  assert.throws(() => f.store.recordProtocolFailure(revision.digest, receipt.environmentDigest, 'health', 'invalid JSON'), /execution lease/)
  const lease = f.store.acquire(f.id, environment)
  try {
    f.store.recordProtocolFailure(revision.digest, receipt.environmentDigest, 'health', 'invalid JSON')
    f.store.recordProtocolFailure(revision.digest, receipt.environmentDigest, 'health', 'duplicate')
    assert.throws(() => f.store.acquire(f.id, environment), /validation required/)
  } finally { lease.release() }
  const reopened = new PluginStore(join(f.root, 'store'))
  assert.equal(reopened.list().events.filter(event => event.action === 'runtime-protocol-failed').length, 1)
  assert.equal((await f.controller.reconcile(f.id, environment, f.policy(), f.validate)).status, 'unavailable')
  assert.equal((await f.controller.reconcile(f.id, other, f.policy(), f.validate)).status, 'unchanged')
})
