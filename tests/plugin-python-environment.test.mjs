import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectPythonRuntime } from '../apps/core/dist/python-environment.js'
import { PluginPythonEnvironments } from '../apps/core/dist/plugin-python-environment.js'
import { parseManagedPluginManifest } from '../packages/contracts/dist/index.js'

const python = process.platform === 'win32' ? 'python' : 'python3'
const buildWheel = String.raw`import sys,zipfile,hashlib,base64,csv,io,json
p,version,dependency=sys.argv[1:]
prefix='thermal_runtime_fixture-'+version+'.dist-info/'
files={'thermal_runtime_fixture/__init__.py':('VALUE='+json.dumps(version)+'\n').encode(),prefix+'METADATA':('Metadata-Version: 2.1\nName: thermal-runtime-fixture\nVersion: '+version+'\n'+('Requires-Dist: '+dependency+'\n' if dependency else '')).encode(),prefix+'WHEEL':b'Wheel-Version: 1.0\nGenerator: thermal-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n'}
rows=[[k,'sha256='+base64.urlsafe_b64encode(hashlib.sha256(v).digest()).decode().rstrip('='),str(len(v))] for k,v in files.items()]
rows.append([prefix+'RECORD','','']); out=io.StringIO();csv.writer(out).writerows(rows);files[prefix+'RECORD']=out.getvalue().encode()
with zipfile.ZipFile(p,'w') as z:
 for k,v in files.items():z.writestr(k,v)
`

test('locked offline wheels create independent verified runtimes without modifying the base interpreter', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal python runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const environments = join(root, 'environments'), manager = new PluginPythonEnvironments(environments)
  const originalPip = { PIP_TARGET: process.env.PIP_TARGET, PIP_CONFIG_FILE: process.env.PIP_CONFIG_FILE }
  t.after(() => { for (const [key, value] of Object.entries(originalPip)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const outside = join(root, 'unwanted-install'), pipConfig = join(root, 'hostile-pip.ini')
  await writeFile(pipConfig, `[global]\ntarget = ${outside}\n`)
  process.env.PIP_TARGET = outside; process.env.PIP_CONFIG_FILE = pipConfig
  const base = await inspectPythonRuntime(python, [])
  const query = executable => execFileSync(executable, ['-I', '-B', '-c', 'import thermal_runtime_fixture;print(thermal_runtime_fixture.VALUE)'], { encoding: 'utf8', stdio: 'pipe' }).trim()
  assert.throws(() => query(base.executable), /No module named/)
  async function input(version, dependency = '') {
    const source = join(root, version); await mkdir(join(source, 'wheels'), { recursive: true })
    const path = `wheels/thermal_runtime_fixture-${version}-py3-none-any.whl`
    execFileSync(base.executable, ['-I', '-B', '-c', buildWheel, join(source, path), version, dependency])
    const digest = createHash('sha256').update(await readFile(join(source, path))).digest('hex')
    const manifest = parseManagedPluginManifest({ schemaVersion: 1, hostApi: 2, id: 'report-reportlab', version: `${version}.0`, kind: 'report',
      entry: { root: 'python', module: 'adapter' }, capabilities: ['health'], permissions: [],
      compatibility: { platforms: [process.platform], architectures: [process.arch], versions: {} },
      pythonRuntime: { schemaVersion: 1, wheels: [{ name: 'thermal-runtime-fixture', version, path, sha256: digest }] } })
    return { digest, root: source, manifest, base, distributions: [] }
  }
  const first = await input('1.0'), second = await input('2.0')
  assert.throws(() => parseManagedPluginManifest({ ...first.manifest, hostApi: 1 }), /host API 2/)
  const one = await manager.prepare(first), two = await manager.prepare(second)
  assert.equal(query(one.executable), '1.0'); assert.equal(query(two.executable), '2.0')
  assert.notEqual(one.executable, two.executable)
  assert.equal((await manager.prepare(first)).executable, one.executable, 'completed environments retain their fixed path after restart/reuse')
  assert.equal((await new PluginPythonEnvironments(environments).prepare(second)).executable, two.executable)
  assert.throws(() => query(base.executable), /No module named/)
  const bad = await input('3.0', 'thermal-missing-dependency==1.0')
  await assert.rejects(access(outside), error => error.code === 'ENOENT', 'user pip configuration cannot redirect installation')
  await assert.rejects(manager.prepare(bad), /requires thermal-missing-dependency/)
  await assert.rejects(manager.prepare(bad), /retry deferred/)
  assert.equal((await readdir(environments)).filter(name => name.startsWith('env-')).length, 2, 'failed preparations leave no executable partial environment')
  const mismatch = await input('4.0'); mismatch.manifest.pythonRuntime.wheels[0].sha256 = '0'.repeat(64)
  await assert.rejects(manager.prepare(mismatch), /SHA-256 mismatch/)
  const cancelled = await input('5.0')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(manager.prepare({ ...cancelled, signal: controller.signal }), error => error.code === 'VALIDATION_DEFERRED')
  const live = await input('6.0'), liveController = new AbortController()
  const before = new Set(await readdir(environments))
  let completed = false
  const preparing = manager.prepare({ ...live, signal: liveController.signal }).then(value => { completed = true; return value })
  const rejected = assert.rejects(preparing, error => error.code === 'VALIDATION_DEFERRED')
  try {
    let started = false
    const deadline = Date.now() + 15000
    while (!started && Date.now() < deadline) {
      for (const name of await readdir(environments)) {
        if (name.startsWith('env-') && !before.has(name)) started = await access(join(environments, name, 'pyvenv.cfg')).then(() => true, () => false)
      }
      if (!started) await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(started, true); assert.equal(completed, false)
  } finally { liveController.abort(); await rejected }
  assert.equal((await readdir(environments)).filter(name => name.startsWith('env-')).length, 2)
  const module = execFileSync(one.executable, ['-I', '-B', '-c', 'import thermal_runtime_fixture;print(thermal_runtime_fixture.__file__)'], { encoding: 'utf8' }).trim()
  await writeFile(module, 'VALUE="tampered"\n')
  await assert.rejects(manager.prepare(first), /contents changed/)
  assert.equal(query(two.executable), '2.0', 'another plugin runtime remains intact')
  for (const mutation of [wheel => { wheel.path = 'https://example.com/a.whl' }, wheel => { wheel.version = '1.0\n--index-url https://example.com' }]) {
    const manifest = structuredClone(second.manifest); mutation(manifest.pythonRuntime.wheels[0])
    assert.throws(() => parseManagedPluginManifest(manifest), /locked Python wheel/)
  }
})
