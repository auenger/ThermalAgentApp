import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { LocalDatabase, ModelPreparationStore } from '@thermal-agent/sqlite-store'
import { engineeringFileHash, engineeringPolicyBinding, parseEngineeringValidationPolicy, validateEngineeringPlugin } from '../apps/core/dist/plugin-engineering-validation.js'
import { withIcepakOperation, lockIcepakOperations } from '../apps/core/dist/icepak-operation-lock.js'

// Serialized test doubles exercise the host's gate and evidence checks; these are not AEDT validation certificates.
async function fixture(t, fault) {
  const home = await mkdtemp(join(tmpdir(), 'thermal-engineering-validator-'))
  const database = new LocalDatabase(join(home, 'db.sqlite')), store = new ModelPreparationStore(database.path)
  t.after(async () => { store.close(); database.close(); await rm(home, { recursive: true, force: true }) })
  const fixturePath = join(home, 'fixture.aedt'), executable = join(home, 'ansysedt.exe')
  await writeFile(fixturePath, JSON.stringify({ Gap: '2mm', Other: '3mm' })); await writeFile(executable, 'test-double executable identity')
  const policy = parseEngineeringValidationPolicy({ schemaVersion: 1, profile: 'project-parameters-solve-v1', allowValidationSolves: true,
    fixturePath, fixtureSha256: await engineeringFileHash(fixturePath), aedtExecutablePath: executable, aedtExecutableSha256: await engineeringFileHash(executable),
    aedtVersion: '2024.2', design: 'IcepakDesign1', setup: 'Setup1', changes: [{ parameterId: 'variable:Gap', value: '1mm', role: 'design' }],
    cores: 1, timeoutMs: 1000, tmaxRangeC: { minimum: 50, maximum: 70 }, maxDeltaC: 1 })
  const calls = []
  const make = kind => ({
    async probeEnvironment() { return { platform: 'win32', pyaedtAvailable: true, aedtVersions: ['2024.2'] } },
    async inspectProject(input, options) {
      assert.equal(store.operation().operation_id, options.operationId)
      calls.push(`${kind}:inspect`)
      const bytes = await readFile(input.projectPath), data = JSON.parse(bytes)
      return { status: 'ok', mode: 'inspect', inputSha256: createHash('sha256').update(bytes).digest('hex'),
        project: { aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', setups: ['Setup1'], objects: ['Sink'] }, validation: { verified: true, checks: [] },
        parameterCatalog: { schemaVersion: 1, fans: [], editableParameters: Object.entries(data).map(([name, value]) => ({
          id: `variable:${name}`, adapter: 'variable', adapterVersion: '1.0.0', target: name, label: name, unit: 'mm', role: 'design', currentValue: value, fingerprint: value,
          valueSchema: { version: 1, type: 'number', minimum: 0.01, maximum: 10 },
        })) } }
    },
    async checkChanges(input, options) {
      assert.equal(store.operation().operation_id, options.operationId)
      calls.push(`${kind}:edit`)
      await mkdir(input.outputDir, { recursive: true })
      const result = await this.inspectProject(input, options)
      const data = JSON.parse(await readFile(input.projectPath, 'utf8'))
      if (fault !== 'lost-write') data.Gap = input.changes[0].value
      if (fault === 'extra-write') data.Other = '4mm'
      const path = join(input.outputDir, 'edited.aedt')
      await writeFile(path, JSON.stringify(data))
      return { ...result, mode: 'check-changes', verifiedProjectPath: fault === 'path-escape' ? policy.fixturePath : path,
        validation: { verified: true, checks: ['persistedParameters'] } }
    },
    async solveProject(input, options) {
      calls.push(`${kind}:solve`)
      const result = await this.inspectProject(input, options)
      if (kind === 'candidate' && fault === 'fixture-mutation') await writeFile(policy.fixturePath, 'changed fixture')
      return { ...result, mode: 'solve', solve: { attempted: true, succeeded: true, setup: 'Setup1' },
        metrics: { tmaxC: kind === 'candidate' && fault === 'temperature' ? 65 : 60, converged: fault !== 'convergence',
          solverNormalCompletion: true, flowConverged: true, temperatureConverged: true, monitorTemperatureStable: true, reversedFlowDetected: false } }
    },
  })
  const identity = digest => ({ pluginId: 'serialized-test-double', pluginVersion: '1.0.0', packageDigest: digest.repeat(64), environmentDigest: 'e'.repeat(64) })
  const run = () => withIcepakOperation(store, 'plugin-upgrade-validation', options => validateEngineeringPlugin({ home, policy,
    candidate: make('candidate'), reference: make('reference'), candidateIdentity: identity('a'), referenceIdentity: identity('b'), options }))
  return { home, policy, store, calls, run }
}

test('host validation uses a persisted exclusive gate, independent readback and separate solve comparison', async t => {
  const f = await fixture(t)
  const checks = await f.run()
  assert.equal(checks.every(check => check.passed), true, JSON.stringify(checks))
  assert.equal(f.store.operation(), null)
  assert.equal(f.calls.filter(call => call === 'reference:solve').length, 1)
  assert.equal(f.calls.filter(call => call === 'candidate:solve').length, 1)
  assert.equal(await engineeringFileHash(f.policy.fixturePath), f.policy.fixtureSha256)
  const [directory] = await readdir(join(f.home, 'engineering-validations'))
  const bytes = await readFile(join(f.home, 'engineering-validations', directory, 'evidence.json'))
  const evidence = JSON.parse(bytes)
  assert.equal(evidence.candidate.pluginId, 'serialized-test-double')
  assert.equal(evidence.referenceReadback.parameterCatalog.editableParameters[0].currentValue, '1mm')
  assert.ok(checks.at(-1).detail.includes(createHash('sha256').update(bytes).digest('hex')))
})

for (const [fault, message] of [['lost-write', 'readback failed'], ['extra-write', 'Unrequested'], ['path-escape', 'escaped'],
  ['temperature', 'disagrees'], ['convergence', 'convergence evidence'], ['fixture-mutation', 'digest changed']]) {
  test(`host rejects ${fault} despite the candidate claiming validation success`, async t => {
    const f = await fixture(t, fault), checks = await f.run()
    assert.equal(checks.every(check => check.passed), false)
    assert.ok(checks.some(check => !check.passed && check.detail.includes(message)), JSON.stringify(checks))
    assert.equal(f.store.operation(), null)
  })
}

test('fixture, executable, reference revision and policy changes invalidate the engineering binding', async t => {
  const f = await fixture(t), initial = await engineeringPolicyBinding(f.policy, 'a'.repeat(64))
  assert.notEqual(await engineeringPolicyBinding({ ...f.policy, maxDeltaC: 0.5 }, 'a'.repeat(64)), initial)
  assert.notEqual(await engineeringPolicyBinding(f.policy, 'b'.repeat(64)), initial)
  await writeFile(f.policy.aedtExecutablePath, 'changed executable')
  await assert.rejects(engineeringPolicyBinding(f.policy, 'a'.repeat(64)), /digest changed/)
  assert.throws(() => parseEngineeringValidationPolicy({ ...f.policy, allowValidationSolves: false }), /authorization/)
})

test('a multi-step validator excludes normal engineering work until the whole sequence finishes', async t => {
  const f = await fixture(t)
  const normal = lockIcepakOperations({ inspectProject: async () => ({}) }, f.store)
  await withIcepakOperation(f.store, 'plugin-upgrade-validation', async () => {
    await assert.rejects(normal.inspectProject({}), error => error.code === 'ICEPAK_BUSY')
    await assert.rejects(withIcepakOperation(f.store, 'another-validation', async () => {}), error => error.code === 'ICEPAK_BUSY')
    assert.equal(f.store.operation().method, 'plugin-upgrade-validation')
  })
  assert.deepEqual(await normal.inspectProject({}), {})
})
