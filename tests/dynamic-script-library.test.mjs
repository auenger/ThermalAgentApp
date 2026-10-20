import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DynamicScriptLibrary, resolveScriptParameters } from '@thermal-agent/core'
const runtime = { pluginId: 'icepak-pyaedt', pluginVersion: '0.3.0', packageDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) }
const definition = { name: 'Heat source', version: '1', description: 'Adjust object heating', source: 'def apply(ipk, parameters): pass\n',
  parameters: { powerW: { type: 'number', description: 'Power', unit: 'W', required: true, minimum: 0, maximum: 100 } },
  applicability: { aedtVersions: ['2024.2'], requiredObjects: ['Chip1'] }, tags: ['heat'] }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'Thermal scripts '))
  const path = join(root, 'library.sqlite')
  let library = new DynamicScriptLibrary(path)
  t.after(async () => { library.close(); await rm(root, { recursive: true, force: true }) })
  return { get library() { return library }, restart() { library.close(); library = new DynamicScriptLibrary(path) } }
}
function begin(library, scriptId, extra = {}) { return library.beginRun({ scriptId, taskId: 'task', parameters: { powerW: 10 }, projectSha256: 'c'.repeat(64), aedtVersion: '2024.2', runtime, ...extra }) }
const evidence = kind => ({ kind, level: 'script-reported-readback', projectSha256: 'd'.repeat(64), artifactSha256: 'e'.repeat(64) })
test('scripts persist, deduplicate and retain previous versions without treating drafts as reusable', async t => {
  const f = await fixture(t), first = f.library.stage(definition)
  assert.equal(f.library.stage(structuredClone(definition)).id, first.id)
  const second = f.library.stage({ ...definition, version: '2', source: definition.source + '# change\n' })
  assert.notEqual(first.id, second.id)
  f.restart()
  assert.equal(f.library.get(first.id).source, definition.source)
  assert.equal(f.library.list('heat').length, 2)
  assert.equal(f.library.reusableEvidence(first.id, runtime, '2024.2').length, 0)
})
test('parameters are strict, bounded and defaulted without mutating the caller', async t => {
  const f = await fixture(t), script = f.library.stage(definition)
  for (const value of [{}, { powerW: 101 }, { powerW: '10' }, { powerW: NaN }, { powerW: 10, unrelated: true }]) assert.throws(() => resolveScriptParameters(script, value))
  const withDefault = f.library.stage({ ...definition, parameters: { powerW: { ...definition.parameters.powerW, default: 20 } } })
  assert.equal(resolveScriptParameters(withDefault, {}).powerW, 20)
  assert.throws(() => f.library.stage({ ...definition, parameters: { x: { type: 'number', description: 'bad', minimum: 5, maximum: 1 } } }), /range/)
})
test('reuse evidence is scoped to the exact environment and excludes simulated success', async t => {
  const f = await fixture(t), script = f.library.stage(definition)
  const fake = begin(f.library, script.id)
  f.library.finish(fake.id, { status: 'SUCCEEDED', evidence: evidence('test-double') })
  assert.deepEqual(f.library.reusableEvidence(script.id, runtime, '2024.2'), [])
  const actual = begin(f.library, script.id)
  f.library.finish(actual.id, { status: 'SUCCEEDED', evidence: evidence('native-aedt') }) // synthetic receipt tests filtering only
  f.restart()
  assert.equal(f.library.reusableEvidence(script.id, runtime, '2024.2').length, 1)
  assert.equal(f.library.reusableEvidence(script.id, { ...runtime, environmentDigest: 'f'.repeat(64) }, '2024.2').length, 0)
  assert.equal(f.library.reusableEvidence(script.id, runtime, '2025.1').length, 0)
  f.library.disable(script.id, true)
  assert.deepEqual(f.library.reusableEvidence(script.id, runtime, '2024.2'), [])
  assert.throws(() => begin(f.library, script.id), /disabled/)
})
test('run receipts are terminal and recovery does not invent success', async t => {
  const f = await fixture(t), script = f.library.stage(definition)
  const run = begin(f.library, script.id)
  f.restart()
  assert.equal(f.library.recoverInterrupted(), 1)
  assert.equal(f.library.getRun(run.id).status, 'INTERRUPTED')
  assert.equal(f.library.recoverInterrupted(), 0)
  assert.throws(() => f.library.finish(run.id, { status: 'SUCCEEDED', evidence: evidence('native-aedt') }), /terminal/)
  assert.throws(() => begin(f.library, script.id, { aedtVersion: '2025.1' }), /AEDT version/)
})
