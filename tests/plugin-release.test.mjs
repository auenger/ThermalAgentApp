import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdtemp, cp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { verifyPluginRelease, parsePluginPublishers, PluginReleaseInbox } from '../apps/core/dist/plugin-release.js'
import { PluginStore } from '../apps/core/dist/plugin-store.js'
import { PluginHost } from '../apps/core/dist/plugin-host.js'
import { ReportClient } from '../apps/core/dist/report-client.js'
import { createCoreApp } from '../apps/core/dist/server.js'
import { ThermalToolsBridge } from '../apps/core/dist/thermal-tools-bridge.js'

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publisher = { id: 'test-publisher', pluginIds: ['report-reportlab'], publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  return { privateKey, publisher }
}
function envelope(payload, key, publisherId = 'test-publisher') {
  const bytes = Buffer.from(JSON.stringify(payload))
  return Buffer.from(JSON.stringify({ schemaVersion: 1, publisherId, payload: bytes.toString('base64'), signature: sign(null, bytes, key).toString('base64') }))
}
const manifest = { schemaVersion: 1, hostApi: 1, id: 'report-reportlab', version: '1.0.0', kind: 'report', entry: { root: 'python', module: 'adapter' }, capabilities: ['health'], permissions: [], compatibility: { platforms: [process.platform], architectures: [process.arch], versions: {} } }
function payload() { return { schemaVersion: 1, publishedAt: '2026-01-01T00:00:00.000Z', files: { 'plugin.json': Buffer.from(JSON.stringify(manifest)).toString('base64'), 'python/adapter.py': Buffer.from('raise RuntimeError("must not execute during import")').toString('base64') } } }

test('signed releases bind every byte to a scoped Ed25519 publisher before registration', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-release-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const { privateKey, publisher } = keys(), store = new PluginStore(join(home, 'store'))
  let publishers = parsePluginPublishers([publisher])
  const inbox = new PluginReleaseInbox(home, store, () => publishers)
  const bytes = envelope(payload(), privateKey)
  assert.equal(verifyPluginRelease(bytes, publishers).manifest.id, manifest.id)
  const tampered = JSON.parse(bytes.toString())
  tampered.payload = Buffer.from(JSON.stringify({ ...payload(), publishedAt: '2026-02-01' })).toString('base64')
  assert.throws(() => inbox.accept(Buffer.from(JSON.stringify(tampered))), /signature failed/)
  assert.equal(store.list().revisions.length, 0)
  assert.throws(() => verifyPluginRelease(bytes, [{ ...publisher, pluginIds: ['icepak-pyaedt'] }]), /not authorized/)
  assert.throws(() => verifyPluginRelease(bytes, []), /Unknown or revoked/)
  const unsafe = payload(); unsafe.files['../escape'] = 'eA=='
  assert.throws(() => verifyPluginRelease(envelope(unsafe, privateKey), publishers), /Unsafe release path/)
  const installed = inbox.accept(bytes)
  assert.equal(store.list().revisions.length, 1)
  assert.deepEqual(store.list().active, {}, 'import cannot execute or activate code')
  assert.equal(inbox.scan().releases[0].digest, installed.digest)
  publishers = []
  assert.equal(inbox.scan().releases.length, 0)
  assert.match(inbox.scan().errors[0], /revoked/)
})

test('automatic report discovery uses real PDF readback, survives offline restart, and falls back on bad output or revoked publisher', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-release-host-'))
  const { privateKey, publisher } = keys()
  const keyPath = join(root, 'test-signing.pem')
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const config = new ReportClient().runtimeConfiguration()
  const source = join(root, 'source')
  await cp(config.pluginRoot, source, { recursive: true })
  const mainPath = join(source, 'thermal_report_plugin', '__main__.py')
  const originalMain = await readFile(mainPath, 'utf8')
  const sourceManifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'))
  async function release(version, broken = false) {
    await writeFile(join(source, 'plugin.json'), JSON.stringify({ ...sourceManifest, version }))
    await writeFile(mainPath, originalMain.replace('"0.1.0"', JSON.stringify(version)).replace('metadata = render_task_report', broken ? 'raise RuntimeError("broken release")\n            metadata = render_task_report' : 'metadata = render_task_report'))
    const path = join(root, `${version}.json`)
    execFileSync(process.execPath, ['scripts/package-plugin-release.mjs', source, publisher.id, keyPath, path], { cwd: resolve('.'), stdio: 'pipe' })
    return readFile(path)
  }
  let publishers = [publisher]
  let remoteBytes, offline = false, downloads = 0
  const home = join(root, 'host'), options = { report: config, publishers: () => publishers,
    updateSources: () => [{ id: 'company', url: 'https://updates.test/index.json' }],
    fetchUpdates: async url => {
      if (offline) throw new TypeError('fetch failed')
      if (url.endsWith('index.json')) return Response.json({ schemaVersion: 1, releases: remoteBytes ? [{ url: 'release.json', sha256: createHash('sha256').update(remoteBytes).digest('hex') }] : [] })
      downloads++; return new Response(remoteBytes)
    } }
  let host = new PluginHost(home, options)
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }) })
  await host.reconcile()
  const initial = host.status().active['report-reportlab'].current
  remoteBytes = await release('0.1.1')
  host.setAutomaticUpdates(false)
  await host.reconcile()
  assert.equal(downloads, 0)
  assert.equal(host.status().active['report-reportlab'].current, initial)
  host.setAutomaticUpdates(true)
  await host.reconcile()
  let status = host.status()
  const good = status.revisions.find(revision => revision.manifest.id === 'report-reportlab' && revision.manifest.version === '0.1.1')
  assert.ok(good, JSON.stringify(status.updates))
  assert.equal(downloads, 1); assert.equal(status.updates.downloaded, 1)
  assert.equal(status.active['report-reportlab'].current, good.digest, JSON.stringify(status.validations))
  assert.equal(status.validations.find(item => item.packageDigest === good.digest).checks.some(check => check.name === 'report-fixture-readback' && check.passed), true)
  const report = await host.report.renderTaskReport({ outputPath: join(root, 'upgraded.pdf'), generatedAt: '2026-01-01T00:00:00.000Z',
    task: { id: 'UPGRADE-CONSUMER', title: '升级后报告', executionStatus: 'COMPLETED', approvalStatus: 'APPROVED', thermalVerdict: 'FAIL' }, runs: [], events: [] })
  assert.equal(report.pluginRuntime.packageDigest, good.digest)
  assert.equal(report.pluginRuntime.pluginVersion, '0.1.1')
  assert.equal((await readFile(report.outputPath)).subarray(0, 4).toString(), '%PDF')
  await host.close(); offline = true; host = new PluginHost(home, options)
  await host.reconcile()
  assert.equal(host.status().active['report-reportlab'].current, good.digest)
  assert.equal(host.status().updates.phase, 'error')
  assert.equal(downloads, 1)
  const bad = host.installRelease(await release('0.1.2', true))
  await host.reconcile()
  status = host.status()
  assert.equal(status.active['report-reportlab'].current, good.digest)
  assert.equal(status.validations.find(item => item.packageDigest === bad.digest).passed, false)
  assert.match(JSON.stringify(status.validations.find(item => item.packageDigest === bad.digest).checks), /broken release/)
  publishers = []
  await host.reconcile()
  assert.equal(host.status().active['report-reportlab'].current, initial)
  assert.match(host.status().releases.errors.join(' '), /revoked/)
})

test('local API and authenticated DSH bridge import signed files without adding keys or executing candidates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-release-api-'))
  const { privateKey, publisher } = keys(), home = join(root, 'app')
  await mkdir(join(home, 'plugins'), { recursive: true })
  await writeFile(join(home, 'plugins', 'publishers.json'), JSON.stringify([publisher]))
  const app = createCoreApp({ home, startAgentRuntime: false })
  const bridge = new ThermalToolsBridge(home, app.database, app.plugins.icepak, app.nodeIdentity.nodeId, app.plugins)
  t.after(async () => { await bridge.stop(); await app.close(); await rm(root, { recursive: true, force: true }) })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = await bridge.start(), bytes = envelope(payload(), privateKey)
  const outside = join(root, 'release.json'), inside = join(home, 'workspace', 'release.json')
  await writeFile(outside, bytes); await writeFile(inside, bytes)
  const post = (url, value, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) })
  const api = `http://127.0.0.1:${app.server.address().port}/api/plugin-runtime/install`
  assert.equal((await post(api, JSON.parse(bytes), { Origin: 'https://foreign.example' })).status, 403)
  const request = path => post(`${address.url}/v1/plugins/install`, { path }, { Authorization: `Bearer ${address.token}` })
  assert.equal((await post(`${address.url}/v1/plugins/install`, { path: inside })).status, 401)
  assert.equal((await request(outside)).status, 409)
  if (process.platform !== 'win32') {
    const escape = join(home, 'workspace', 'escape.json')
    await symlink(outside, escape)
    assert.equal((await request(escape)).status, 409)
  }
  assert.equal((await request(inside)).status, 200)
  assert.equal((await post(api, JSON.parse(bytes))).status, 200)
  assert.deepEqual(app.plugins.status().active, {})
  assert.equal(app.plugins.status().releases.releases.length, 1)
  assert.equal(app.plugins.status().validations.length, 0)
})
