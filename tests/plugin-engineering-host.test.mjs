import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { LocalDatabase, ModelPreparationStore } from '@thermal-agent/sqlite-store'
import { PluginHost } from '../apps/core/dist/plugin-host.js'
import { ENGINEERING_CAPABILITIES } from '../apps/core/dist/plugin-engineering-validation.js'

const python = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

// Real isolated Python subprocesses, signed packages, SQLite gates and immutable store.
// The JSON project and injected Windows environment are TEST DOUBLES, not AEDT evidence.
function program(id, version, fault = '') {
  return `import sys,json,hashlib,pathlib
r=json.loads(sys.stdin.readline()); p=r['params']; method=r['method']
result={'pluginId':'${id}','pluginVersion':'${version}','protocolVersion':'1.0.0','status':'ok'}
if method=='probe_environment':
 result.update(platform='win32',pyaedtAvailable=True,aedtVersions=['2024.2'])
elif method not in ['health']:
 path=pathlib.Path(p['projectPath']); raw=path.read_bytes(); data=json.loads(raw)
 result.update(mode='inspect',inputSha256=hashlib.sha256(raw).hexdigest(),project={'aedtVersion':'2024.2','activeDesign':'Design','setups':['Setup'],'objects':['Sink']},validation={'verified':True,'checks':[]},parameterCatalog={'fans':[],'editableParameters':[{'id':'variable:'+k,'adapter':'variable','adapterVersion':'1.0.0','target':k,'label':k,'unit':'mm','role':'design','currentValue':v,'fingerprint':v,'valueSchema':{'version':1,'type':'number','minimum':0.01,'maximum':10}} for k,v in data.items()]})
 if method=='check_changes':
  if '${fault}'=='cancel':
   (path.parent/'entered').write_text('waiting for host cancellation'); sys.stdin.readline(); raise SystemExit(0)
  if '${fault}'!='lost-write': data['Gap']=p['changes'][0]['value']
  out=pathlib.Path(p['outputDir']); out.mkdir(parents=True,exist_ok=True); saved=out/'edited.aedt'; saved.write_text(json.dumps(data))
  result.update(mode='check-changes',verifiedProjectPath=str(saved),validation={'verified':True,'checks':['persistedParameters']})
 if method=='solve_project':
  result.update(mode='solve',solve={'attempted':True,'succeeded':True,'setup':'Setup'},metrics={'tmaxC':65 if '${fault}'=='temperature' else 60,'converged':True,'solverNormalCompletion':True,'flowConverged':True,'temperatureConverged':True,'monitorTemperatureStable':True,'reversedFlowDetected':False})
print(json.dumps({'id':r['id'],'ok':True,'result':result}))
`
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'thermal-engineering-host-'))
  const home = join(root, 'host'), install = join(root, 'installation')
  await mkdir(home); await mkdir(install)
  const oldRoot = process.env.ANSYSEM_ROOT242
  process.env.ANSYSEM_ROOT242 = install
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publisher = { id: 'test-engineering-publisher', pluginIds: ['icepak-pyaedt'], publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const manifest = (id, version, capabilities = ENGINEERING_CAPABILITIES) => ({ schemaVersion: 1, hostApi: 1, id, version,
    kind: id === 'icepak-pyaedt' ? 'icepak' : 'report', entry: { root: 'python', module: 'adapter' }, capabilities,
    permissions: [], compatibility: { platforms: ['win32'], architectures: [process.arch], versions: {} } })
  async function source(id) {
    const pluginRoot = join(root, id); await mkdir(pluginRoot)
    await writeFile(join(pluginRoot, 'plugin.json'), JSON.stringify(manifest(id, '1.0.0')))
    await writeFile(join(pluginRoot, 'adapter.py'), program(id, '1.0.0'))
    return { python, pluginRoot }
  }
  const fixturePath = join(root, 'fixture.aedt'), aedtExecutablePath = join(install, 'ansysedt.exe')
  const bytes = JSON.stringify({ Gap: '2mm', Other: '3mm' })
  await writeFile(fixturePath, bytes); await writeFile(aedtExecutablePath, 'TEST DOUBLE executable')
  const policy = { schemaVersion: 1, profile: 'project-parameters-solve-v1', allowValidationSolves: true,
    fixturePath, fixtureSha256: sha(bytes), aedtExecutablePath, aedtExecutableSha256: sha('TEST DOUBLE executable'),
    aedtVersion: '2024.2', design: 'Design', setup: 'Setup', changes: [{ parameterId: 'variable:Gap', value: '1mm', role: 'design' }],
    cores: 1, timeoutMs: 10000, tmaxRangeC: { minimum: 50, maximum: 70 }, maxDeltaC: 1 }
  const configure = () => writeFile(join(home, 'engineering-validation.json'), JSON.stringify(policy))
  const database = new LocalDatabase(join(root, 'db.sqlite')), store = new ModelPreparationStore(database.path)
  const options = { icepak: await source('icepak-pyaedt'), report: await source('report-reportlab'), publishers: () => [publisher],
    inspect: async () => ({ executable: python, environment: { platform: 'win32', architecture: process.arch, versions: { python: 'test-double', pyaedt: 'test-double' } } }) }
  let host
  const restart = async () => { await host?.close(); host = new PluginHost(home, options); host.attachEngineeringStore(store); return host }
  const release = (version, fault, capabilities) => {
    const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, publishedAt: '2026-10-19T00:00:00.000Z', files: {
      'plugin.json': Buffer.from(JSON.stringify(manifest('icepak-pyaedt', version, capabilities))).toString('base64'),
      'python/adapter.py': Buffer.from(program('icepak-pyaedt', version, fault)).toString('base64'),
    } }))
    return host.installRelease(Buffer.from(JSON.stringify({ schemaVersion: 1, publisherId: publisher.id, payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') })))
  }
  t.after(async () => {
    await host?.close(); store.close(); database.close()
    if (oldRoot === undefined) delete process.env.ANSYSEM_ROOT242; else process.env.ANSYSEM_ROOT242 = oldRoot
    await rm(root, { recursive: true, force: true })
  })
  return { root, home, policy, configure, store, restart, release }
}

test('engineering signed update reaches independent validation, activation and pinned consumer; failures and changed policy fall back', async t => {
  const f = await fixture(t)
  let host = await f.restart()
  await host.reconcile()
  const builtin = host.status().active['icepak-pyaedt'].current
  const good = f.release('1.0.1')
  await host.reconcile()
  assert.equal(host.status().active['icepak-pyaedt'].current, builtin, 'no solve authorization means staging only')
  assert.equal(host.status().validations.some(v => v.packageDigest === good.digest), false)
  await f.configure()
  assert.equal(f.store.acquireOperation('normal-work', 'inspect-project'), true)
  await host.reconcile()
  assert.equal(host.status().active['icepak-pyaedt'].current, builtin)
  assert.equal(host.status().validations.some(v => v.packageDigest === good.digest), false, 'normal engineering work excludes upgrade validation')
  assert.equal(f.store.completeOperation('normal-work'), true)
  await host.reconcile()
  let status = host.status()
  assert.equal(status.active['icepak-pyaedt'].current, good.digest, JSON.stringify(status.runtimes))
  const receipt = status.validations.find(v => v.packageDigest === good.digest)
  assert.equal(receipt.passed, true)
  assert.equal(receipt.checks.some(c => c.name === 'engineering-solve-comparison' && c.passed), true)
  assert.equal(f.store.operation(), null)
  const pinned = await host.icepak.pinRuntime()
  try {
    assert.equal(pinned.identity.packageDigest, good.digest)
    assert.equal(host.isCurrentIcepakRuntime(pinned.identity), true)
    assert.equal((await pinned.port.probeEnvironment()).pluginVersion, '1.0.1')
    const newer = f.release('1.0.2')
    await host.reconcile()
    assert.equal(host.status().active['icepak-pyaedt'].current, good.digest)
    assert.equal(host.status().validations.some(v => v.packageDigest === newer.digest), false, 'leased work excludes validation')
  } finally { pinned.release() }
  await host.reconcile()
  const stable = host.status().active['icepak-pyaedt'].current
  assert.notEqual(stable, good.digest)
  assert.equal(host.isCurrentIcepakRuntime(pinned.identity), false, 'old heartbeat cache becomes invalid immediately after upgrade')
  const bad = f.release('1.0.3', 'lost-write')
  await host.reconcile()
  status = host.status()
  assert.equal(status.active['icepak-pyaedt'].current, stable)
  assert.equal(status.validations.find(v => v.packageDigest === bad.digest).passed, false)
  const count = status.validations.length
  await host.reconcile()
  assert.equal(host.status().validations.length, count, 'same environment does not repeatedly execute failed releases')
  const unsupported = f.release('1.0.4', '', [...ENGINEERING_CAPABILITIES, 'cad_inspect'])
  await host.reconcile()
  assert.equal(host.status().validations.some(v => v.packageDigest === unsupported.digest), false)
  host = await f.restart(); await host.reconcile()
  assert.equal(host.status().active['icepak-pyaedt'].current, stable)
  f.policy.maxDeltaC = 0.5; await f.configure(); await host.reconcile()
  assert.ok(host.status().validations.filter(v => v.packageDigest === stable).length >= 2, 'policy changes require fresh evidence')
  await writeFile(f.policy.aedtExecutablePath, 'Changed executable')
  await host.reconcile()
  assert.equal(host.status().active['icepak-pyaedt'].current, builtin)
  assert.match(host.status().runtimes.find(r => r.kind === 'icepak').engineeringValidation.diagnostic, /digest changed/)
  assert.equal(await readFile(f.policy.fixturePath, 'utf8'), JSON.stringify({ Gap: '2mm', Other: '3mm' }))
})

test('disabling updates cancels a live candidate worker, releases both gates and does not quarantine a cancelled version', async t => {
  const f = await fixture(t)
  const host = await f.restart()
  await host.reconcile()
  const builtin = host.status().active['icepak-pyaedt'].current
  await f.configure()
  const candidate = f.release('1.0.1', 'cancel')
  const checking = host.reconcile()
  try {
    const deadline = Date.now() + 15000
    let entered = false
    while (Date.now() < deadline && !entered) {
      for (const directory of await readdir(join(f.home, 'engineering-validations')).catch(() => [])) {
        entered = await access(join(f.home, 'engineering-validations', directory, 'entered')).then(() => true, () => false)
        if (entered) break
      }
      if (!entered) await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(entered, true, 'candidate must really be running before cancellation')
    assert.ok(f.store.operation()?.worker_pid)
  } finally {
    host.setAutomaticUpdates(false)
    await checking
  }
  assert.equal(f.store.operation(), null)
  assert.equal(host.store.isBusy('icepak-pyaedt'), false)
  assert.equal(host.status().active['icepak-pyaedt'].current, builtin)
  assert.equal(host.status().validations.some(v => v.packageDigest === candidate.digest), false)
  assert.equal((await host.icepak.probeEnvironment()).pluginVersion, '1.0.0')
})
