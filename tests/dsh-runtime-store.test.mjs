import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DshRuntimeStore, validateDshRelease } from '../apps/core/dist/dsh-runtime-store.js'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'DSH runtime with spaces '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'), home = join(root, 'home')
  const files = { 'node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }),
    'node_modules/@deepseek-ai/dsh/lib/bin.js': '// cli', 'node/bin/node': 'test node', 'plugins/thermal/index.js': '// plugin' }
  for (const [file, body] of Object.entries(files)) {
    await mkdir(join(source, file, '..'), { recursive: true })
    await writeFile(join(source, file), body)
  }
  const manifest = { schema: 1, version: '0.2.1-rc.2', platform: process.platform, arch: process.arch, bridgeProtocol: 1,
    cli: 'node_modules/@deepseek-ai/dsh/lib/bin.js', node: 'node/bin/node', plugin: 'plugins/thermal/index.js',
    files: Object.fromEntries(Object.entries(files).map(([file, body]) => [file, createHash('sha256').update(body).digest('hex')])) }
  const save = () => writeFile(join(source, 'runtime.json'), JSON.stringify(manifest))
  await save()
  return { source, home, manifest, save, store: new DshRuntimeStore(home) }
}
test('staging is independent of current engine; prepare copies profile and commit/rollback preserve both histories', async t => {
  const { source, home, store } = await fixture(t)
  await mkdir(join(home, 'dsh'), { recursive: true })
  await writeFile(join(home, 'dsh', 'history'), 'old history')
  const id = await store.stage(source)
  assert.equal((await store.status()).active, 'bundled')
  assert.equal((await store.status()).pending.release, id)
  const { current, candidate } = await store.prepare()
  assert.equal(await readFile(join(store.profile(candidate), 'history'), 'utf8'), 'old history')
  await writeFile(join(store.profile(candidate), 'history'), 'migrated history')
  assert.equal(await readFile(join(home, 'dsh', 'history'), 'utf8'), 'old history')
  await store.commit(current, candidate)
  assert.equal((await store.status()).active, id)
  await store.scheduleRollback()
  const rollback = await store.prepare()
  assert.deepEqual(rollback.candidate, current)
  await store.commit(rollback.current, rollback.candidate)
  assert.equal((await store.status()).active, 'bundled')
  assert.equal(await readFile(join(store.profile(candidate), 'history'), 'utf8'), 'migrated history')
})
test('failed/crashed candidate never changes active engine and is not retried on next startup', async t => {
  const { store, source } = await fixture(t)
  await store.stage(source)
  const first = await store.prepare()
  assert.ok(first.candidate)
  const restarted = new DshRuntimeStore(store.root.replace(/[/\\]dsh-runtimes$/u, ''))
  assert.equal((await restarted.prepare()).candidate, undefined)
  assert.equal((await restarted.status()).active, 'bundled')
  await restarted.failed(new Error('startup failed'))
  assert.equal((await restarted.status()).error, 'startup failed')
})
test('integrity rejects altered and extra files, incompatible platform and traversal', async t => {
  const { source, manifest, save } = await fixture(t)
  await validateDshRelease(source)
  await writeFile(join(source, 'extra'), 'untracked')
  await assert.rejects(validateDshRelease(source), /inventory/)
  await rm(join(source, 'extra'))
  const platform = manifest.platform; manifest.platform = 'unsupported'; await save()
  await assert.rejects(validateDshRelease(source), /incompatible/)
  manifest.platform = platform; manifest.cli = '../escape'; await save()
  await assert.rejects(validateDshRelease(source), /missing cli/)
  manifest.cli = 'node_modules/@deepseek-ai/dsh/lib/bin.js'; await save()
  await writeFile(join(source, manifest.cli), '// tampered')
  await assert.rejects(validateDshRelease(source), /integrity/)
})
test('symlink releases and symlink files are rejected', async t => {
  const { source } = await fixture(t)
  await symlink(source, `${source}-link`, 'dir')
  await assert.rejects(validateDshRelease(`${source}-link`), /real directory/)
  await symlink(join(source, 'node/bin/node'), join(source, 'link'))
  await assert.rejects(validateDshRelease(source), /unsafe path/)
})
test('stored packages are rechecked before execution', async t => {
  const { source, store } = await fixture(t)
  const id = await store.stage(source)
  await writeFile(join(store.root, id, 'node/bin/node'), 'tampered')
  await assert.rejects(store.prepare(), /integrity/)
  assert.equal((await store.status()).active, 'bundled')
})

test('a candidate that cannot execute restores the live bundled Host and preserves its profile', async t => {
  const { source, home, store } = await fixture(t)
  await mkdir(join(home, 'dsh'), { recursive: true })
  await writeFile(join(home, 'dsh', 'retained-marker'), 'original data')
  await store.stage(source)
  const { createCoreApp } = await import('../apps/core/dist/server.js')
  const app = createCoreApp({ home, startRemoteSolve: false, pluginClient: {
    probeEnvironment: async () => ({ status: 'NOT_INSTALLED', platform: process.platform, aedtVersions: [], capabilities: [], diagnostics: [] }),
  } })
  t.after(() => app.close())
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${app.server.address().port}`
  let status
  const deadline = Date.now() + 30_000
  do {
    status = (await (await fetch(`${origin}/api/agent/status`)).json()).agent
    if (status.phase === 'ready') break
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.equal(status.phase, 'ready', status.detail)
  assert.equal((await store.status()).active, 'bundled')
  assert.match((await store.status()).error, /EACCES|ENOEXEC|exited|spawn/u)
  assert.equal(await readFile(join(home, 'dsh', 'retained-marker'), 'utf8'), 'original data')
  assert.equal((await fetch(`${origin}/api/agent/runtime/stage`, { method: 'POST', headers: { Origin: 'https://untrusted.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: source }) })).status, 403)
})

test('bundled upgrades back up existing data once per version before migration', async t => {
  const { home, store } = await fixture(t)
  await mkdir(join(home, 'dsh'), { recursive: true })
  await writeFile(join(home, 'dsh', 'history'), 'before upgrade')
  await store.backupBundledProfile('0.2.1-rc.2')
  const first = (await store.status()).backup
  assert.equal(await readFile(join(store.root, first, 'history'), 'utf8'), 'before upgrade')
  await writeFile(join(home, 'dsh', 'history'), 'after migration')
  await store.backupBundledProfile('0.2.1-rc.2')
  assert.equal((await store.status()).backup, first)
  assert.equal(await readFile(join(store.root, first, 'history'), 'utf8'), 'before upgrade')
})
