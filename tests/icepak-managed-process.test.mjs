import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { LocalDatabase, ModelPreparationStore } from '@thermal-agent/sqlite-store'
import { IcepakPluginClient, lockIcepakOperations } from '@thermal-agent/core'

test('a managed one-shot protocol request exits normally with its cancellation pipe left open', async t => {
  const python = process.env.THERMAL_MANAGED_TEST_PYTHON ?? (process.platform === 'win32' ? resolve('packaging/windows-runtime/python/python.exe') : resolve('plugins/report-reportlab/.venv/bin/python'))
  try { execFileSync(python, ['-I', '-c', 'import psutil'], { stdio: 'pipe' }) }
  catch { t.skip('An isolated Python runtime with psutil is required for this real process test'); return }
  const root = await mkdtemp(join(tmpdir(), 'thermal-managed-health-'))
  const database = new LocalDatabase(join(root, 'db.sqlite'))
  const store = new ModelPreparationStore(database.path)
  t.after(async () => { store.close(); database.close(); await rm(root, { recursive: true, force: true }) })
  const id = 'managed-health'
  store.acquireOperation(id, 'health')
  const client = new IcepakPluginClient({ python, pluginRoot: resolve('plugins/icepak-pyaedt/python') })
  const result = await client.call('health', {}, { operationId: id, timeoutMs: 5000, onProcessStarted(pid) { store.registerOperationWorker(id, pid) } })
  assert.equal(result.pluginId, 'icepak-pyaedt')
  assert.equal(result.status, 'ok')
  assert.equal(store.completeOperation(id), true)
})

test('cooperative cancellation stops a real managed worker and its registered child before releasing the fence', async t => {
  const python = process.env.THERMAL_MANAGED_TEST_PYTHON ?? (process.platform === 'win32' ? resolve('packaging/windows-runtime/python/python.exe') : resolve('plugins/report-reportlab/.venv/bin/python'))
  try { execFileSync(python, ['-I', '-c', 'import psutil'], { stdio: 'pipe' }) }
  catch { t.skip('An isolated Python runtime with psutil is required for this real process test'); return }
  const root = await mkdtemp(join(tmpdir(), 'thermal-managed-process-'))
  const pluginRoot = join(root, 'plugin')
  const packageRoot = join(pluginRoot, 'thermal_icepak_plugin')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, '__init__.py'), '')
  for (const file of ['managed.py', 'windows_job.py']) await cp(resolve('plugins/icepak-pyaedt/python/thermal_icepak_plugin', file), join(packageRoot, file))
  await writeFile(join(packageRoot, '__main__.py'), `import json,os,subprocess,sys,time
from .managed import read_managed_request,start_managed
raw,controls=read_managed_request(sys.stdin)
request=json.loads(raw)
guard=start_managed(int(os.environ['THERMAL_ICEPAK_PARENT_PID']),lambda pid,birth: print(json.dumps({'id':request['id'],'event':'managed_process','pid':pid,'creationTime':birth}),flush=True),controls)
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
guard.track(child.pid)
print(json.dumps({'id':request['id'],'event':'progress','stage':'child_started'}),flush=True)
while True: time.sleep(0.1)
`)
  const database = new LocalDatabase(join(root, 'db.sqlite'))
  const store = new ModelPreparationStore(database.path)
  const controller = new AbortController()
  t.after(async () => { controller.abort(); store.close(); database.close(); await rm(root, { recursive: true, force: true }) })
  const client = lockIcepakOperations(new IcepakPluginClient({ python, pluginRoot }), store)
  let ready
  const started = new Promise(done => { ready = done })
  const operation = client.inspectProject({ projectPath: 'unused', outputDir: 'unused' }, { signal: controller.signal, timeoutMs: 20000,
    onProgress(stage) { if (stage === 'child_started') ready() } })
  const rejection = assert.rejects(operation)
  await Promise.race([started, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('managed worker failed to start')), 10000); timer.unref() })])
  const record = store.operation()
  assert.ok(record.worker_pid > 0)
  const resource = JSON.parse(record.resources_json)[0]
  assert.ok(resource.pid > 0 && resource.creationTime > 0)
  const cancelledAt = Date.now()
  controller.abort()
  await rejection
  assert.ok(Date.now() - cancelledAt < 5000, 'cooperative cleanup should precede the 10-second force fallback')
  const deadline = Date.now() + 3000
  while (store.reconcileRecoveredOperation() && Date.now() < deadline) await new Promise(done => setTimeout(done, 20))
  assert.equal(store.operation(), null)
  assert.throws(() => process.kill(record.worker_pid, 0))
  assert.throws(() => process.kill(resource.pid, 0))
})
