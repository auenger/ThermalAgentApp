import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginRuntimeStorage } from '../apps/core/dist/plugin-runtime-storage.js'

const later = Date.now() + 8 * 24 * 60 * 60_000
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'thermal-runtime-gc-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const storage = new PluginRuntimeStorage(home)
  let id = 0
  const make = async (owned = true, complete = true) => {
    const directory = join(home, `env-${randomUUID()}`), key = (++id).toString(16).padStart(64, '0')
    await mkdir(directory); await writeFile(join(directory, 'dependency.py'), 'value = 1\n')
    if (owned) storage.own(directory, key, key, complete ? key : undefined)
    if (complete) await writeFile(join(home, `${key}.json`), JSON.stringify({ key, directory: directory.split(/[\\/]/u).at(-1) }))
    return { directory, key, name: directory.split(/[\\/]/u).at(-1) }
  }
  const collect = overrides => storage.collect({ packages: new Set(), environments: new Set(), directories: new Set(),
    allowed: () => true, onRemove() {}, now: later, ...overrides })
  return { home, storage, make, collect }
}

test('collection preserves active/rollback and historical references, and removes only aged owned environments', async t => {
  const f = await fixture(t)
  const current = await f.make(), workflow = await f.make(), obsolete = await f.make(), incomplete = await f.make(true, false), legacy = await f.make(false)
  const recent = await f.make()
  const recordPath = join(f.home, 'managed-environments', `${recent.name}.json`)
  const record = JSON.parse(await readFile(recordPath, 'utf8')); record.createdAt = new Date(later).toISOString()
  await writeFile(recordPath, JSON.stringify(record))
  const outside = await mkdtemp(join(tmpdir(), 'thermal-gc-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'keep'), 'outside')
  if (process.platform !== 'win32') await symlink(outside, join(obsolete.directory, 'external'))
  const removed = []
  const result = await f.collect({ packages: new Set([current.key]), environments: new Set([workflow.key]), onRemove: path => removed.push(path) })
  assert.equal(result.error, undefined)
  assert.deepEqual(new Set(result.removed), new Set([obsolete.name, incomplete.name]))
  assert.deepEqual(new Set(removed), new Set([obsolete.directory, incomplete.directory]))
  await assert.rejects(access(join(f.home, `${obsolete.key}.json`)), { code: 'ENOENT' })
  for (const item of [current, workflow, recent, legacy]) await access(join(item.directory, 'dependency.py'))
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'outside')
  assert.match(result.retained.find(item => item.directory === legacy.name).reason, /legacy/)
})

test('ambiguous launches and corrupt control metadata retain environments without guessing', async t => {
  const f = await fixture(t), pending = await f.make(), unused = await f.make()
  await mkdir(join(f.home, 'runtime-uses'))
  const ticket = join(f.home, 'runtime-uses', `${randomUUID()}.json`)
  await writeFile(ticket, JSON.stringify({ schemaVersion: 1, directory: pending.name, ownerPid: 99999999 }))
  const retained = await f.collect()
  assert.equal(retained.retained.find(item => item.directory === pending.name).reason, 'live or unresolved Python process')
  assert.deepEqual(retained.removed, [unused.name])
  const next = await f.make()
  await writeFile(ticket, '{broken')
  const corrupt = await f.collect()
  assert.ok(corrupt.error)
  assert.deepEqual(corrupt.removed, [])
  await access(next.directory)
  await rm(ticket)
  await writeFile(join(f.home, `${next.key}.json`), JSON.stringify({ key: next.key, directory: '../outside' }))
  assert.match((await f.collect()).error, /Invalid runtime index/)
  await access(next.directory)
  assert.deepEqual((await f.collect({ allowed: () => false })).removed, [])
})

test('retired copies of a current package and failed launches do not consume storage forever', async t => {
  const f = await fixture(t), current = await f.make(), retired = await f.make(true, false)
  f.storage.own(retired.directory, current.key, current.key, retired.key)
  const child = f.storage.forDirectory(retired.directory)(join(f.home, 'missing-python'), [], {})
  child.once('error', () => {})
  await new Promise(resolve => child.once('close', resolve))
  assert.deepEqual(await readdir(join(f.home, 'runtime-uses')), [])
  const result = await f.collect({ packages: new Set([current.key]) })
  assert.deepEqual(result.removed, [retired.name])
  await access(current.directory)
})

test('a Python worker surviving its Core process keeps its environment after storage manager restart', { timeout: 20000 }, async t => {
  const f = await fixture(t), runtime = await f.make()
  const moduleUrl = new URL('../apps/core/dist/plugin-runtime-storage.js', import.meta.url).href
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const script = `import { PluginRuntimeStorage } from ${JSON.stringify(moduleUrl)};
const storage = new PluginRuntimeStorage(process.argv[1]);
const child = storage.forDirectory(process.argv[2])(process.argv[3], ['-I', '-B', '-c', 'import time;time.sleep(60)'], { detached: true });
child.stdin.end(); console.log(String(child.pid)); setInterval(() => {}, 1000);`
  const owner = spawn(process.execPath, ['--input-type=module', '-e', script, f.home, runtime.directory, python], { stdio: ['ignore', 'pipe', 'pipe'] })
  const ownerExited = once(owner, 'exit')
  let pid
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
    await ownerExited
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
  })
  const [chunk] = await once(owner.stdout, 'data'); pid = Number(chunk.toString().trim())
  assert.ok(Number.isInteger(pid) && pid > 0)
  owner.kill('SIGKILL'); await ownerExited
  process.kill(pid, 0)
  const restarted = new PluginRuntimeStorage(f.home)
  const input = { packages: new Set(), environments: new Set(), directories: new Set(), allowed: () => true, onRemove() {}, now: later }
  const result = await restarted.collect(input)
  assert.deepEqual(result.removed, [])
  assert.equal(result.retained[0].reason, 'live or unresolved Python process')
  await access(runtime.directory)
  process.kill(pid, 'SIGKILL')
  // A dead PID becomes collectable; a platform retaining a zombie remains conservatively fenced.
  let dead = false
  for (let index = 0; index < 100 && !dead; index++) {
    try { process.kill(pid, 0) } catch (error) { dead = error.code === 'ESRCH' }
    if (!dead) await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (dead) {
    assert.deepEqual((await restarted.collect(input)).removed, [runtime.name])
    assert.deepEqual(await readdir(join(f.home, 'runtime-uses')), [])
  } else assert.deepEqual((await restarted.collect(input)).removed, [])
})
