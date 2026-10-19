import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginStore, pluginEnvironmentDigest } from '../apps/core/dist/plugin-store.js'

const environment = { platform: 'win32', architecture: 'x64', versions: { python: '3.11.9', pyaedt: '0.18.1', aedt: '2025.2' } }
const approved = ['engineering-copy-write', 'aedt-launch']
const pass = async () => [{ name: 'round-trip', passed: true, detail: 'Saved and reopened fixture' }]

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'thermal-plugins-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'store')
  async function source(version, overrides = {}) {
    const path = join(root, `source-${version}`)
    await mkdir(join(path, 'python', 'adapter'), { recursive: true })
    const manifest = { schemaVersion: 1, hostApi: 1, id: 'icepak-pyaedt', version, kind: 'icepak',
      entry: { root: 'python', module: 'adapter' }, capabilities: ['environment_probe', 'parameter_check'], permissions: approved,
      compatibility: { platforms: ['win32'], architectures: ['x64'], versions: { python: ['3.11.9'], pyaedt: ['0.18.1'], aedt: ['2025.2'] } }, ...overrides }
    await writeFile(join(path, 'plugin.json'), JSON.stringify(manifest))
    await writeFile(join(path, 'python', 'adapter', '__main__.py'), `print('${version}')\n`)
    return path
  }
  return { root, home, store: new PluginStore(home), source }
}

test('a verified update switches versions atomically, preserves leased code and survives restart', async t => {
  const f = await fixture(t)
  const first = f.store.install(await f.source('1.0.0'))
  assert.throws(() => f.store.activate(first.digest, environment, approved), /passing validation/)
  await f.store.validate(first.digest, environment, pass)
  f.store.activate(first.digest, environment, approved)
  const lease = f.store.acquire('icepak-pyaedt', environment)
  const second = f.store.install(await f.source('1.1.0'))
  await assert.rejects(f.store.validate(second.digest, environment, pass), /busy/)
  assert.equal(await readFile(join(lease.root, 'adapter', '__main__.py'), 'utf8'), "print('1.0.0')\n")
  lease.release(); lease.release()
  await f.store.validate(second.digest, environment, pass)
  const another = f.store.acquire('icepak-pyaedt', environment)
  assert.throws(() => f.store.activate(second.digest, environment, approved), /busy/)
  another.release()
  f.store.activate(second.digest, environment, approved)
  const restarted = new PluginStore(f.home)
  assert.equal(restarted.list().active['icepak-pyaedt'].current, second.digest)
  restarted.rollback('icepak-pyaedt', environment, approved)
  assert.equal(restarted.list().active['icepak-pyaedt'].current, first.digest)
  assert.equal(new PluginStore(f.home).list().active['icepak-pyaedt'].current, first.digest)
})

test('validation failures and permission growth retain the existing active version', async t => {
  const f = await fixture(t)
  const first = f.store.install(await f.source('1.0.0'))
  await f.store.validate(first.digest, environment, pass)
  f.store.activate(first.digest, environment, approved)
  const second = f.store.install(await f.source('1.1.0', { permissions: [...approved, 'network'] }))
  const failed = await f.store.validate(second.digest, environment, async () => { throw new Error('Readback mismatch') })
  assert.equal(failed.passed, false)
  assert.match(failed.checks[0].detail, /Readback mismatch/)
  assert.throws(() => f.store.activate(second.digest, environment, [...approved, 'network']), /passing validation/)
  await f.store.validate(second.digest, environment, pass)
  assert.throws(() => f.store.activate(second.digest, environment, approved), /additional permissions/)
  assert.equal(f.store.list().active['icepak-pyaedt'].current, first.digest)
})

test('environment changes invalidate evidence, including otherwise compatible new facts', async t => {
  const f = await fixture(t)
  const revision = f.store.install(await f.source('1.0.0'))
  await f.store.validate(revision.digest, environment, pass)
  f.store.activate(revision.digest, environment, approved)
  assert.throws(() => f.store.acquire('icepak-pyaedt', { ...environment, platform: 'darwin' }), /platform/)
  assert.throws(() => f.store.acquire('icepak-pyaedt', { ...environment, versions: { ...environment.versions, pyaedt: '0.20.0' } }), /pyaedt/)
  assert.throws(() => f.store.acquire('icepak-pyaedt', { ...environment, versions: { ...environment.versions, runtimeDigest: 'new-binary' } }), /environment changed/)
  assert.equal(pluginEnvironmentDigest(environment), pluginEnvironmentDigest({ versions: { aedt: '2025.2', python: '3.11.9', pyaedt: '0.18.1' }, architecture: 'x64', platform: 'win32' }))
})

test('package bytes cannot be overwritten, edited after validation or aliased through symlinks', async t => {
  const f = await fixture(t)
  const source = await f.source('1.0.0')
  const revision = f.store.install(source)
  assert.equal(f.store.install(source).digest, revision.digest)
  await writeFile(join(source, 'python', 'adapter', '__main__.py'), "print('replacement')")
  assert.throws(() => f.store.install(source), /increment its version/)
  await f.store.validate(revision.digest, environment, pass)
  await writeFile(join(f.home, 'packages', revision.digest, 'python', 'adapter', '__main__.py'), 'tampered')
  assert.throws(() => f.store.activate(revision.digest, environment, approved), /integrity/)
  const unsafe = await f.source('2.0.0')
  await symlink(join(source, 'plugin.json'), join(unsafe, 'outside.json'))
  assert.throws(() => f.store.install(unsafe), /symlinks/)
})

test('stale staging and an orphan complete package do not change active state', async t => {
  const f = await fixture(t)
  const source = await f.source('1.0.0')
  const revision = f.store.install(source)
  await f.store.validate(revision.digest, environment, pass)
  f.store.activate(revision.digest, environment, approved)
  const saved = await readFile(join(f.home, 'state.json'), 'utf8')
  const nextSource = await f.source('1.1.0')
  const next = f.store.install(nextSource)
  await writeFile(join(f.home, 'state.json'), saved) // Crash after package rename but before state replacement.
  await mkdir(join(f.home, 'staging-incomplete'))
  await writeFile(join(f.home, 'state-interrupted.tmp'), '{')
  const restarted = new PluginStore(f.home)
  assert.equal(restarted.list().active['icepak-pyaedt'].current, revision.digest)
  assert.equal(restarted.install(nextSource).digest, next.digest)
  assert.equal(restarted.list().active['icepak-pyaedt'].current, revision.digest)
})

test('running validation excludes execution and switching; empty checks cannot certify a plugin', async t => {
  const f = await fixture(t)
  const first = f.store.install(await f.source('1.0.0'))
  await f.store.validate(first.digest, environment, pass)
  f.store.activate(first.digest, environment, approved)
  const second = f.store.install(await f.source('1.1.0'))
  let finish
  const validating = f.store.validate(second.digest, environment, () => new Promise(resolve => { finish = resolve }))
  assert.throws(() => f.store.acquire('icepak-pyaedt', environment), /validation/)
  assert.throws(() => f.store.activate(first.digest, environment, approved), /busy/)
  finish([])
  assert.equal((await validating).passed, false)
  const lease = f.store.acquire('icepak-pyaedt', environment)
  lease.release()
})
