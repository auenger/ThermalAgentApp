import assert from 'node:assert/strict'
import test from 'node:test'
import { aedtModelAssessment, cadModelAssessment } from '../apps/core/dist/model-capabilities.js'

function inspected(components) {
  return { status: 'ok', mode: 'inspect', sourceProject: 'Model.aedt', workingProject: 'copy.aedt', inputSha256: 'a'.repeat(64),
    project: { name: 'Model', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: [], setups: ['Setup1'], boundaries: [],
      nativeComponents: components, monitors: [], objects: [] }, validation: { verified: true, checks: [] } }
}

function fan(name, type = 'Curve') {
  return { name, properties: { NativeComponentDefinitionProvider: { Type: 'Fan', FlowType: type, X: ['1'], Y: ['2'] } } }
}

test('model capability gate distinguishes CAD, fixed-flow fans, and verified curve-fan targets', () => {
  const sha = 'a'.repeat(64)
  const cad = cadModelAssessment(sha)
  assert.equal(cad.status, 'NEEDS_MODEL_PREPARATION')
  assert.ok(cad.items.every(item => item.status !== 'EXECUTABLE'))

  const fixed = aedtModelAssessment(sha, '2024.2', inspected([fan('FixedFan', 'Fixed')]), null, null)
  assert.equal(fixed.status, 'READY_FOR_BASELINE')
  assert.equal(fixed.items.find(item => item.skillKey === 'optimization-04-fan-selection').status, 'UNAVAILABLE')

  const curveProject = inspected([fan('FanA'), fan('FanB')])
  curveProject.parameterCatalog = { schemaVersion: 1, variables: [], materials: [], boundaries: [],
    fans: [{ name: 'FanA', flowType: 'Curve', properties: {}, actionStatus: 'DISCOVERED' },
      { name: 'FanB', flowType: 'Curve', properties: {}, actionStatus: 'DISCOVERED' }], setups: ['Setup1'], diagnostics: [] }
  const failed = aedtModelAssessment(sha, '2024.2', curveProject, null, 'write-back failed')
  const failedFan = failed.items.find(item => item.skillKey === 'optimization-04-fan-selection')
  assert.equal(failedFan.status, 'UNAVAILABLE')
  assert.deepEqual(failedFan.targetNames, ['FanA', 'FanB'])

  const checked = { ...curveProject, fanAction: { verified: true, fans: [{ name: 'FanA' }, { name: 'FanB' }] } }
  const available = aedtModelAssessment(sha, '2024.2', curveProject, checked, null)
  const availableFan = available.items.find(item => item.skillKey === 'optimization-04-fan-selection')
  assert.equal(availableFan.status, 'EXECUTABLE')
  assert.deepEqual(availableFan.targetNames, ['FanA', 'FanB'])
  assert.deepEqual(available.parameterCatalog.fans.map(item => item.actionStatus), ['VERIFIED', 'VERIFIED'])

  const mismatched = aedtModelAssessment(sha, '2024.2', curveProject, { ...checked, fanAction: { verified: true, fans: [{ name: 'FanA' }, { name: 'Other' }] } }, null)
  assert.equal(mismatched.items.find(item => item.skillKey === 'optimization-04-fan-selection').status, 'UNAVAILABLE')
})
