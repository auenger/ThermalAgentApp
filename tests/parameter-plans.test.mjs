import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parseParameterPlanRequest, resolveParameterChanges, parseEditableParameters, parameterValueSchema } from '../packages/contracts/dist/index.js'
import { LocalDatabase } from '@thermal-agent/sqlite-store'
import { parameterApp, waitFor, parameters } from './fixtures/parameter-app.mjs'

const requestFor = (context, changes = [{ parameterId: 'variable:FinGap', value: '1.5mm', role: 'design' }]) => ({ sourceAttemptId: context.sourceAttemptId, author: '热设计工程师', reason: '调整鳍片间距，验证热点改善；维持原功耗。', changes })
const extension = { id: 'surface-emissivity:Sink', adapter: 'surface-emissivity', adapterVersion: '1.0.0', adapterLabel: '表面辐射',
  label: '表面发射率', target: 'Sink', currentValue: '0.5', fingerprint: 'fixture-surface', unit: '', role: 'design',
  valueSchema: { version: 1, type: 'number', minimum: 0, maximum: 1, defaultValue: '0.9' } }
async function submit(f, changes) {
  const { response, body } = await f.request(`/api/tasks/${f.task.id}/parameter-plans`, requestFor(f.context, changes))
  assert.equal(response.status, 202, JSON.stringify(body))
  return waitFor(() => { const p = f.app.database.getParameterPlan(body.plan.id); return p.status !== 'CHECKING' && p })
}

test('parameter contract rejects duplicates, wrong units, unknown IDs and condition relabeling', () => {
  assert.throws(() => parseParameterPlanRequest({ ...requestFor({ sourceAttemptId: 'a' }), changes: [] }), /1–50/)
  const parsed = parseParameterPlanRequest(requestFor({ sourceAttemptId: 'a' }))
  assert.equal(resolveParameterChanges(parameters, parsed)[0].parameter.target, 'FinGap')
  for (const changes of [
    [{ parameterId: 'missing', value: '1mm', role: 'design' }],
    [{ parameterId: 'variable:FinGap', value: '1W', role: 'design' }],
    [{ parameterId: 'variable:FinGap', value: '1e999mm', role: 'design' }],
    [{ parameterId: 'boundary-power:CPU', value: '10W', role: 'design' }],
    [{ parameterId: 'material:HeatSink', value: 'unknown', role: 'design' }],
  ]) assert.throws(() => resolveParameterChanges(parameters, parseParameterPlanRequest(requestFor({ sourceAttemptId: 'a' }, changes))))
  assert.throws(() => parseParameterPlanRequest({ ...parsed, changes: [...parsed.changes, ...parsed.changes] }), /重复/)
})

test('plugin-declared parameter schemas extend host validation without adapter-specific branches', () => {
  const catalog = parseEditableParameters([extension])
  assert.equal(parameterValueSchema(catalog[0]).defaultValue, '0.9')
  const request = value => parseParameterPlanRequest(requestFor({ sourceAttemptId: 'a' }, [{ parameterId: extension.id, value, role: 'design' }]))
  assert.equal(resolveParameterChanges(catalog, request('0.9'))[0].parameter.adapterVersion, '1.0.0')
  for (const value of ['1.1', 'NaN', '0.9W', '0.5']) assert.throws(() => resolveParameterChanges(catalog, request(value)))
  assert.throws(() => parseEditableParameters([{ ...extension, valueSchema: undefined }]), /valueSchema/)
  assert.throws(() => parseEditableParameters([{ ...extension, valueSchema: { version: 2, type: 'number' } }]), /Schema/)
  assert.throws(() => parseEditableParameters([{ ...extension, valueSchema: { version: 1, type: 'number', maximum: Infinity } }]), /有限/)
  const choice = { ...extension, valueSchema: { version: 1, type: 'enum', values: ['rough', 'smooth'] }, currentValue: 'rough' }
  assert.equal(resolveParameterChanges([choice], request('smooth'))[0].value, 'smooth')
  assert.throws(() => resolveParameterChanges([choice], request('unknown')), /可选/)
  assert.equal(resolveParameterChanges([{ ...choice, currentValue: '1', valueSchema: { version: 1, type: 'enum', values: ['1', '1.0'] } }], request('1.0'))[0].value, '1.0')
  assert.throws(() => parseEditableParameters([extension, extension]), /标识/)
})

test('a new plugin parameter travels through Core catalog, immutable plan and saved validation evidence', async t => {
  const f = await parameterApp({ parameters: [extension] }); t.after(() => f.close())
  assert.deepEqual(f.context.parameters, [extension])
  const plan = await submit(f, [{ parameterId: extension.id, value: '0.9', role: 'design' }])
  assert.equal(plan.status, 'VERIFIED')
  assert.deepEqual(plan.changes[0].parameter, extension)
  assert.deepEqual(f.calls.find(call => call.kind === 'check').input.changes[0].parameter.valueSchema, extension.valueSchema)
  const evidence = JSON.parse(await readFile(f.app.artifacts.resolveArtifact(plan.evidenceSha256), 'utf8'))
  assert.equal(evidence.actionResults[0].parameterId, extension.id)
  assert.equal(evidence.actionResults[0].verifiedAfter, '0.9')
})

test('Core rejects a plugin receipt whose claimed persisted value contradicts the requested edit', async t => {
  const f = await parameterApp({ parameters: [extension] }); t.after(() => f.close())
  const check = f.plugin.checkChanges.bind(f.plugin)
  f.plugin.checkChanges = async input => {
    const result = await check(input)
    return { ...result, actionResults: result.actionResults.map(action => ({ ...action, verifiedAfter: '0.5' })) }
  }
  const plan = await submit(f, [{ parameterId: extension.id, value: '0.9', role: 'design' }])
  assert.equal(plan.status, 'FAILED')
  assert.match(plan.error, /验证证据不完整/)
  assert.equal(plan.verifiedProjectSha256, null)
})

test('verified immutable revision executes precisely its saved artifact and preserves baseline lineage', async t => {
  const f = await parameterApp(); t.after(() => f.close())
  const plan = await submit(f)
  assert.equal(plan.status, 'VERIFIED')
  assert.equal(plan.revision, 1)
  assert.equal(plan.sourceSha256, f.context.sourceSha256)
  assert.ok(plan.evidenceSha256)
  const before = JSON.stringify(plan.changes)
  const version = f.app.database.getTask(f.task.id).version
  const result = await f.request(`/api/tasks/${f.task.id}/parameter-plans/${plan.id}/execute`, { expectedVersion: version })
  assert.equal(result.response.status, 202, JSON.stringify(result.body))
  await waitFor(() => f.app.database.getTask(f.task.id).executionStatus === 'WAITING_FOR_APPROVAL')
  const updated = f.app.database.getParameterPlan(plan.id)
  assert.equal(updated.status, 'EXECUTED')
  assert.equal(updated.executionTaskId, f.task.id)
  assert.equal(JSON.stringify(updated.changes), before)
  const candidate = f.calls.filter(c => c.kind === 'solve').at(-1)
  assert.ok(candidate.bytes.includes('1.5mm'))
  assert.equal(candidate.input.baselineMetrics.tmaxC, 95)
  assert.equal(candidate.input.design, 'IcepakDesign1')
  assert.equal(f.calls.filter(c => c.kind === 'check').length, 1)
  assert.equal(await readFile(f.source, 'utf8'), 'baseline-input')
  const context = (await f.request(`/api/tasks/${f.task.id}/parameters`)).body
  assert.equal(context.executions[plan.id].deltaC, -17)
  assert.equal(context.executions[plan.id].tmaxC, 78)
  assert.equal(context.executions[plan.id].converged, true)
  assert.notEqual((await f.request(`/api/tasks/${f.task.id}/parameter-plans/${plan.id}/execute`, { expectedVersion: f.app.database.getTask(f.task.id).version })).response.status, 202)
})

test('power change creates a linked new baseline without comparing it as cooling improvement', async t => {
  const f = await parameterApp(); t.after(() => f.close())
  const plan = await submit(f, [{ parameterId: 'boundary-power:CPU', value: '15W', role: 'operating-condition' }])
  const oldVersion = f.app.database.getTask(f.task.id).version
  const { response, body } = await f.request(`/api/tasks/${f.task.id}/parameter-plans/${plan.id}/execute`, { expectedVersion: oldVersion })
  assert.equal(response.status, 202, JSON.stringify(body))
  const childId = body.plan.executionTaskId
  assert.notEqual(childId, f.task.id)
  await waitFor(() => f.app.database.getTask(childId).executionStatus === 'WAITING_FOR_APPROVAL')
  const child = f.app.database.getTask(childId)
  assert.equal(child.requirementSnapshot.parentTaskId, f.task.id)
  assert.equal(child.requirementSnapshot.parameterPlanId, plan.id)
  assert.equal(f.app.database.listTaskRuns(childId)[0].kind, 'BASELINE')
  const call = f.calls.filter(c => c.kind === 'solve').at(-1)
  assert.equal(call.input.baselineMetrics, undefined)
  assert.ok(call.bytes.includes('15W'))
  assert.equal(f.app.database.listTaskRuns(f.task.id).length, 1)
  assert.equal(f.app.database.getTask(f.task.id).version, oldVersion)
})

test('failed verification remains auditable, copy gets a new version and cannot execute unverified bytes', async t => {
  const f = await parameterApp(); t.after(() => f.close())
  f.plugin.failCheck = true
  const failed = await submit(f)
  assert.equal(failed.status, 'FAILED'); assert.match(failed.error, /verification failed/)
  assert.equal(failed.verifiedProjectSha256, null)
  assert.notEqual((await f.request(`/api/tasks/${f.task.id}/parameter-plans/${failed.id}/execute`, { expectedVersion: f.app.database.getTask(f.task.id).version })).response.status, 202)
  f.plugin.failCheck = false
  const copied = await submit(f)
  assert.equal(copied.revision, 2); assert.equal(copied.status, 'VERIFIED')
  assert.equal(f.app.database.getParameterPlan(failed.id).status, 'FAILED')
  const events = f.app.database.listTaskEvents(f.task.id)
  assert.ok(events.some(e => e.eventType === 'parameters.failed' && e.payload.planId === failed.id))
})

test('stale baseline, stale task version and concurrent verification requests are rejected', async t => {
  const f = await parameterApp(); t.after(() => f.close())
  const bad = await f.request(`/api/tasks/${f.task.id}/parameter-plans`, { ...requestFor(f.context), sourceAttemptId: 'old' })
  assert.notEqual(bad.response.status, 202)
  f.plugin.checkDelay = 150
  const results = await Promise.all([1, 2].map(() => f.request(`/api/tasks/${f.task.id}/parameter-plans`, requestFor(f.context))))
  assert.equal(results.filter(r => r.response.status === 202).length, 1)
  const plan = await waitFor(() => { const p = f.app.database.listParameterPlans(f.task.id)[0]; return p.status === 'VERIFIED' && p })
  assert.notEqual((await f.request(`/api/tasks/${f.task.id}/parameter-plans/${plan.id}/execute`, { expectedVersion: 1 })).response.status, 202)
  assert.equal(f.app.database.getParameterPlan(plan.id).status, 'VERIFIED')
})

test('failed solve retains verified before/after evidence and retry reuses modified project', async t => {
  const f = await parameterApp(); t.after(() => f.close())
  const plan = await submit(f)
  f.plugin.failSolve = true
  await f.request(`/api/tasks/${f.task.id}/parameter-plans/${plan.id}/execute`, { expectedVersion: f.app.database.getTask(f.task.id).version })
  await waitFor(() => f.app.database.getTask(f.task.id).executionStatus === 'FAILED')
  const context = (await f.request(`/api/tasks/${f.task.id}/parameters`)).body
  assert.equal(context.plans[0].actionResults[0].verified, true)
  assert.match(context.executions[plan.id].error, /test solver failed/)
  f.plugin.failSolve = false
  const retry = await f.request(`/api/tasks/${f.task.id}/runs/retry`, { expectedVersion: f.app.database.getTask(f.task.id).version })
  assert.equal(retry.response.status, 202, JSON.stringify(retry.body))
  await waitFor(() => f.app.database.getTask(f.task.id).executionStatus === 'WAITING_FOR_APPROVAL')
  assert.ok(f.calls.filter(c => c.kind === 'solve').at(-1).bytes.includes('1.5mm'))
  assert.equal(f.calls.filter(c => c.kind === 'check').length, 1)
})

test('parameter revisions survive DB reopen and interrupted checks are marked explicitly', async t => {
  const f = await parameterApp(); t.after(() => f.close())
  const plan = await submit(f)
  const { id, revision, createdAt, updatedAt, ...input } = plan
  const checking = f.app.database.createParameterPlan({ ...input, status: 'CHECKING', verifiedProjectSha256: null })
  const reopened = new LocalDatabase(f.app.database.path)
  try {
    assert.equal(reopened.getParameterPlan(plan.id).status, 'VERIFIED')
    reopened.recoverParameterPlans()
    assert.equal(reopened.getParameterPlan(checking.id).status, 'FAILED')
    assert.match(reopened.getParameterPlan(checking.id).error, /重启/)
    assert.equal(reopened.getParameterPlan(plan.id).verifiedProjectSha256, plan.verifiedProjectSha256)
  } finally { reopened.close() }
})

test('catalog refresh is bound to baseline and downloads are scoped to the owning task and exact evidence', async t => {
  const f = await parameterApp(); t.after(() => f.close())
  const refreshed = await f.request(`/api/tasks/${f.task.id}/parameters/refresh`, {})
  assert.equal(refreshed.response.status, 200)
  assert.equal(refreshed.body.sourceSha256, f.context.sourceSha256)
  assert.ok(f.app.database.listAttemptArtifacts(f.context.sourceAttemptId).some(link => link.role === 'LOG'))
  const plan = await submit(f)
  const evidence = await fetch(`${f.base}/api/tasks/${f.task.id}/parameter-plans/${plan.id}/evidence`)
  assert.equal(evidence.status, 200)
  assert.match(evidence.headers.get('content-disposition'), /parameters-v1.json/)
  assert.equal((await evidence.json()).actionResults[0].after, '1.5mm')
  const project = await fetch(`${f.base}/api/tasks/${f.task.id}/parameter-plans/${plan.id}/project`)
  assert.equal(project.status, 200)
  assert.match(await project.text(), /1.5mm/)
  const wrongTask = await fetch(`${f.base}/api/tasks/00000000-0000-0000-0000-000000000000/parameter-plans/${plan.id}/project`)
  assert.equal(wrongTask.status, 404)
})

test('a check receipt from a different input cannot be marked verified', async t => {
  const f = await parameterApp(); t.after(() => f.close())
  const check = f.plugin.checkChanges
  f.plugin.checkChanges = async input => ({ ...await check(input), inputSha256: '0'.repeat(64) })
  const plan = await submit(f)
  assert.equal(plan.status, 'FAILED')
  assert.equal(plan.verifiedProjectSha256, null)
})

test('startup recovery reconnects a run created before its plan acknowledgment was persisted', async t => {
  const f = await parameterApp(); t.after(() => f.close())
  const plan = await submit(f)
  f.app.database.updateParameterPlan(plan.id, 'VERIFIED', { status: 'STARTING' })
  const run = f.app.database.createRunWithAttempt({ taskId: f.task.id, kind: 'CANDIDATE', executorNodeId: f.task.ownerNodeId,
    pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', parameters: { parameterPlanId: plan.id }, inputArtifactSha256: plan.verifiedProjectSha256 })
  f.app.database.recoverParameterPlans()
  const recovered = f.app.database.getParameterPlan(plan.id)
  assert.equal(recovered.status, 'EXECUTED')
  assert.equal(recovered.runId, run.run.id)
  assert.equal(recovered.executionTaskId, f.task.id)
})
