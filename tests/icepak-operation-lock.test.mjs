import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { LocalDatabase, ModelPreparationStore } from '@thermal-agent/sqlite-store'
import { IcepakPluginClient, lockIcepakOperations } from '@thermal-agent/core'

test('one persisted gate covers CAD, existing project inspection, parameter edits and solver operations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'icepak-lock-test-'))
  const database = new LocalDatabase(join(root, 'db.sqlite'))
  const store = new ModelPreparationStore(database.path)
  t.after(async () => { store.close(); database.close(); await rm(root, { recursive: true, force: true }) })
  let finish
  const port = lockIcepakOperations({ inspectCad: () => new Promise(resolve => { finish = resolve }),
    executeScript: async () => ({ ok: true }), inspectProject: async () => ({ ok: true }), checkChanges: async () => ({ ok: true }), solveProject: async () => ({ ok: true }),
    probeEnvironment: async () => ({ status: 'DETECTED' }), fanCheck: async () => ({}), fanSolve: async () => ({}) }, store)
  const active = port.inspectCad({})
  assert.equal(store.operation().method, 'inspectCad')
  for (const method of ['executeScript', 'inspectProject', 'checkChanges', 'solveProject', 'fanCheck', 'fanSolve']) await assert.rejects(port[method]({}), error => error.code === 'ICEPAK_BUSY')
  assert.equal((await port.probeEnvironment()).status, 'DETECTED')
  finish({ status: 'ok' }); await active
  assert.equal(store.operation(), null)
  assert.deepEqual(await port.solveProject({}), { ok: true })
})

test('plugin timeout terminates managed process before the shared gate is released', async t => {
  const root = await mkdtemp(join(tmpdir(), 'icepak-timeout-test-'))
  const packagePath = join(root, 'plugin', 'thermal_icepak_plugin')
  await mkdir(packagePath, { recursive: true })
  await writeFile(join(packagePath, '__init__.py'), '')
  await writeFile(join(packagePath, '__main__.py'), 'import sys, time\nsys.stdin.readline()\ntime.sleep(30)\n')
  const database = new LocalDatabase(join(root, 'db.sqlite'))
  const store = new ModelPreparationStore(database.path)
  t.after(async () => { store.close(); database.close(); await rm(root, { recursive: true, force: true }) })
  const port = lockIcepakOperations(new IcepakPluginClient({ python: process.platform === 'win32' ? 'python' : 'python3', pluginRoot: join(root, 'plugin') }), store)
  const started = Date.now()
  await assert.rejects(port.inspectProject({ projectPath: 'ignored', outputDir: 'ignored' }, { timeoutMs: 100 }), error => error.code === 'PLUGIN_TIMEOUT')
  assert.ok(Date.now() - started < 15000)
  assert.equal(store.operation(), null)
})

test('pinning a runtime retains the shared AEDT operation gate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'icepak-pin-lock-'))
  const database = new LocalDatabase(join(root, 'db.sqlite'))
  const store = new ModelPreparationStore(database.path)
  t.after(async () => { store.close(); database.close(); await rm(root, { recursive: true, force: true }) })
  let finish
  const client = { solveProject: () => new Promise(resolve => { finish = resolve }) }
  const port = lockIcepakOperations({ ...client, async pinRuntime() {
    return { identity: { pluginId: 'test', pluginVersion: '1.0.0' }, port: client, release() {} }
  } }, store)
  const pin = await port.pinRuntime()
  const active = pin.port.solveProject({})
  assert.equal(store.operation().method, 'solveProject')
  await assert.rejects(port.solveProject({}), error => error.code === 'ICEPAK_BUSY')
  finish({ status: 'ok' }); await active
  pin.release()
  assert.equal(store.operation(), null)
})

test('a live owner cannot be displaced by startup recovery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'icepak-owner-test-'))
  const database = new LocalDatabase(join(root, 'db.sqlite'))
  const store = new ModelPreparationStore(database.path)
  t.after(async () => { store.close(); database.close(); await rm(root, { recursive: true, force: true }) })
  store.acquireOperation('live-owner', 'inspectCad')
  assert.throws(() => store.recover(), /活跃 Core/)
  assert.equal(store.operation().operation_id, 'live-owner')
  store.releaseOperation('live-owner')
})

test('a reused owner PID with a different birth identity is not mistaken for the original Core', async t => {
  const root = await mkdtemp(join(tmpdir(), 'icepak-owner-birth-'))
  const database = new LocalDatabase(join(root, 'db.sqlite'))
  const store = new ModelPreparationStore(database.path)
  t.after(async () => { store.close(); database.close(); await rm(root, { recursive: true, force: true }) })
  store.acquireOperation('old-birth', 'inspectCad')
  assert.ok(store.operation().owner_birth)
  const connection = new DatabaseSync(database.path)
  connection.prepare("UPDATE icepak_operation_lock SET owner_birth = 'previous-process-birth'").run()
  connection.close()
  store.recover()
  assert.equal(store.operation(), null)
  assert.doesNotThrow(() => process.kill(process.pid, 0))
})

test('an orphan worker remains fenced after its original owner exits and recovery never kills it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'icepak-orphan-test-'))
  const database = new LocalDatabase(join(root, 'db.sqlite'))
  const store = new ModelPreparationStore(database.path)
  let workerPid
  t.after(async () => {
    if (workerPid) { try { process.kill(workerPid, 'SIGKILL') } catch {} }
    store.close(); database.close(); await rm(root, { recursive: true, force: true })
  })
  const script = `import { spawn } from 'node:child_process'; import { ModelPreparationStore } from '@thermal-agent/sqlite-store'; const s = new ModelPreparationStore(${JSON.stringify(database.path)}); s.acquireOperation('orphan', 'inspectCad'); const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' }); s.registerOperationWorker('orphan', worker.pid); worker.unref(); s.close(); console.log(JSON.stringify({ pid: worker.pid }));`
  workerPid = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })).pid
  store.recover()
  assert.equal(store.operation().recovery_required, 1)
  assert.equal(store.acquireOperation('new', 'solveProject'), false)
  assert.doesNotThrow(() => process.kill(workerPid, 0))
  assert.equal(store.reconcileRecoveredOperation().worker_pid, workerPid)
})

test('unconfirmed AEDT resource exit keeps the execution fence even after the plugin response', async t => {
  const root = await mkdtemp(join(tmpdir(), 'icepak-resource-test-'))
  const database = new LocalDatabase(join(root, 'db.sqlite'))
  const store = new ModelPreparationStore(database.path)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore' })
  const closed = new Promise(done => child.once('exit', done))
  t.after(async () => { child.kill('SIGKILL'); await closed; store.close(); database.close(); await rm(root, { recursive: true, force: true }) })
  const port = lockIcepakOperations({ async inspectCad(input, options) { options.onManagedResource(child.pid, Date.now() / 1000); return { status: 'ok' } } }, store)
  await assert.rejects(port.inspectCad({}), error => error.code === 'ICEPAK_CLEANUP_PENDING')
  assert.equal(store.operation().recovery_required, 1)
  assert.equal(store.acquireOperation('next', 'solveProject'), false)
  child.kill('SIGKILL'); await closed
  assert.equal(store.reconcileRecoveredOperation(), null)
})
