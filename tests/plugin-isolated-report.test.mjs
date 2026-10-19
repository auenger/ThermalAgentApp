import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PluginHost } from '../apps/core/dist/plugin-host.js'
import { ReportClient } from '../apps/core/dist/report-client.js'

// Repackage the test runner's installed dependencies as offline wheels. No network or package build hooks.
const wheels = String.raw`import sys,importlib.metadata as m,re,pathlib,zipfile,hashlib,base64,csv,io,json
out=pathlib.Path(sys.argv[1]);out.mkdir();result=[]
for name in ['reportlab','pypdf','pillow','charset-normalizer']:
 d=m.distribution(name);prefix=next(str(f).split('/')[0] for f in d.files if str(f).endswith('.dist-info/METADATA'))
 wheeltext=d.read_text('WHEEL');tag=next(line[5:] for line in wheeltext.splitlines() if line.startswith('Tag: '))
 filename=name.replace('-','_')+'-'+d.version+'-'+tag+'.whl';files={}
 for f in d.files:
  s=str(f)
  if '..' in pathlib.PurePosixPath(s).parts or s.endswith(('.pyc','.pyo')) or '__pycache__' in s or s.endswith('/RECORD'):continue
  p=d.locate_file(f)
  if p.is_file():files[s]=p.read_bytes()
 rows=[[k,'sha256='+base64.urlsafe_b64encode(hashlib.sha256(v).digest()).decode().rstrip('='),str(len(v))] for k,v in files.items()]
 rows.append([prefix+'/RECORD','','']);buf=io.StringIO();csv.writer(buf).writerows(rows);files[prefix+'/RECORD']=buf.getvalue().encode()
 with zipfile.ZipFile(out/filename,'w',compression=zipfile.ZIP_DEFLATED) as z:
  for k,v in files.items():z.writestr(k,v)
 result.append({'name':name,'version':d.version,'path':'wheels/'+filename,'sha256':hashlib.sha256((out/filename).read_bytes()).hexdigest()})
print(json.dumps(result))`

test('signed report with locked wheels activates in a separate interpreter, renders real PDF and rolls back across environments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-isolated-report-'))
  const config = new ReportClient().runtimeConfiguration()
  const source = join(root, 'source'); await cp(config.pluginRoot, source, { recursive: true })
  const lock = JSON.parse(execFileSync(config.python, ['-I', '-B', '-c', wheels, join(source, 'wheels')], { encoding: 'utf8', maxBuffer: 100000 }))
  const manifestPath = join(source, 'plugin.json'), mainPath = join(source, 'thermal_report_plugin', '__main__.py')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')), main = await readFile(mainPath, 'utf8')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'), keyPath = join(root, 'key.pem')
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const publisher = { id: 'report-test', pluginIds: ['report-reportlab'], publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const home = join(root, 'host'), options = { report: config, publishers: () => [publisher] }
  let host = new PluginHost(home, options)
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }) })
  await host.reconcile()
  const baseline = host.status().active['report-reportlab'].current
  const baselineEnvironment = host.status().runtimes.find(r => r.id === 'report-reportlab').environment
  async function release(version, broken = false) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, hostApi: 2, version, pythonRuntime: { schemaVersion: 1, wheels: lock } }))
    await writeFile(mainPath, main.replace('"0.1.0"', JSON.stringify(version)).replace('metadata = render_task_report', broken ? 'raise RuntimeError("broken independent report")\n            metadata = render_task_report' : 'metadata = render_task_report'))
    const path = join(root, `${version}.json`)
    execFileSync(process.execPath, ['scripts/package-plugin-release.mjs', source, publisher.id, keyPath, path], { cwd: resolve('.'), stdio: 'pipe' })
    return host.installRelease(await readFile(path))
  }
  const good = await release('0.1.1')
  await host.reconcile()
  let status = host.status()
  assert.equal(status.active['report-reportlab'].current, good.digest, JSON.stringify(status.runtimes))
  const upgradedEnvironment = status.runtimes.find(r => r.id === 'report-reportlab').environment
  assert.equal(status.runtimes.find(r => r.id === 'report-reportlab').dependencyMode, 'isolated')
  assert.notEqual(status.runtimes.find(r => r.id === 'report-reportlab').pythonExecutable, config.python)
  assert.ok(upgradedEnvironment.versions['host-reference'])
  assert.notEqual(upgradedEnvironment.versions['python-runtime'], baselineEnvironment.versions['python-runtime'])
  const report = await host.report.renderTaskReport({ outputPath: join(root, 'isolated.pdf'), generatedAt: '2026-10-19T00:00:00Z',
    task: { id: 'ISOLATED-RUNTIME', title: '独立依赖报告', executionStatus: 'COMPLETED', approvalStatus: 'APPROVED', thermalVerdict: 'FAIL' }, runs: [], events: [] })
  assert.equal(report.pluginRuntime.packageDigest, good.digest)
  assert.equal((await readFile(report.outputPath)).subarray(0, 4).toString(), '%PDF')
  const oldPython = host.status().runtimes.find(r => r.id === 'report-reportlab').pythonExecutable
  const site = execFileSync(oldPython, ['-I', '-B', '-c', 'import site;print(site.getsitepackages()[0])'], { encoding: 'utf8' }).trim()
  const marker = join(root, 'damaged-runtime-executed')
  const injection = join(site, 'unexpected.pth')
  await writeFile(injection, `import pathlib;pathlib.Path(${JSON.stringify(marker)}).write_text("executed")\n`)
  const held = host.store.acquire('report-reportlab', upgradedEnvironment)
  try {
    await host.reconcile()
    assert.equal(host.status().runtimes.find(r => r.id === 'report-reportlab').pythonExecutable, oldPython, 'held work defers rebuilding')
  } finally { held.release() }
  await host.reconcile()
  status = host.status()
  assert.equal(status.active['report-reportlab'].current, good.digest)
  assert.notEqual(status.runtimes.find(r => r.id === 'report-reportlab').pythonExecutable, oldPython)
  assert.equal(status.runtimeRepairs.find(item => item.packageDigest === good.digest).status, 'prepared')
  assert.equal(status.validations.filter(v => v.packageDigest === good.digest && v.passed).length, 2, 'rebuilt environment must pass fresh PDF validation')
  await assert.rejects(access(marker), error => error.code === 'ENOENT', 'changed .pth must be detected before interpreter startup')
  assert.match(await readFile(injection, 'utf8'), /executed/, 'old environment is not overwritten')
  await host.close(); host = new PluginHost(home, options); await host.reconcile()
  assert.equal(host.status().active['report-reportlab'].current, good.digest)
  assert.equal(host.status().runtimeRepairs.find(item => item.packageDigest === good.digest).status, 'prepared')
  await host.rollback('report-reportlab')
  assert.equal(host.status().active['report-reportlab'].current, baseline)
  assert.deepEqual(host.status().runtimes.find(r => r.id === 'report-reportlab').environment, baselineEnvironment)
  host.resume('report-reportlab'); await host.reconcile()
  assert.equal(host.status().active['report-reportlab'].current, good.digest)
  const bad = await release('0.1.2', true)
  await host.reconcile()
  status = host.status()
  assert.equal(status.active['report-reportlab'].current, good.digest)
  assert.equal(status.validations.find(v => v.packageDigest === bad.digest)?.passed, false)
  // Simulate exhausted local runtime storage while the active environment needs rebuilding.
  for (let i = 0; i < 64; i++) await mkdir(join(home, 'python-environments', `env-quota-fixture-${i}`))
  const activePython = status.runtimes.find(r => r.id === 'report-reportlab').pythonExecutable
  const activeSite = execFileSync(activePython, ['-I', '-B', '-c', 'import site;print(site.getsitepackages()[0])'], { encoding: 'utf8' }).trim()
  await writeFile(join(activeSite, 'broken.pth'), `import pathlib;pathlib.Path(${JSON.stringify(marker)}).write_text("executed")\n`)
  await host.reconcile()
  status = host.status()
  assert.equal(status.active['report-reportlab'].current, baseline, 'failed rebuild selects a still-usable trusted version')
  assert.equal(status.runtimeRepairs.find(item => item.packageDigest === good.digest).status, 'failed')
  assert.match(status.runtimeRepairs.find(item => item.packageDigest === good.digest).error, /storage is full/)
  await assert.rejects(access(marker), error => error.code === 'ENOENT')
})
