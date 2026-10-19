import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { PluginHost } from '../apps/core/dist/plugin-host.js'
import { createCoreApp } from '../apps/core/dist/server.js'

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
