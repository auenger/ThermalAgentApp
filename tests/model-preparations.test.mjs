import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { createTask } from '@thermal-agent/domain'
import { createThermalModelSpec, parseThermalModelSpec, validateThermalModelSpec } from '../packages/contracts/dist/index.js'
import { ModelPreparationStore } from '@thermal-agent/sqlite-store'
import { modelApp, waitModel, confirmSpec } from './fixtures/model-preparation-app.mjs'

async function imported(f) {
  const result = await f.request('/cad-inspections', { requestId: randomUUID(), version: '2024.2', healing: false })
  assert.equal(result.response.status, 202, JSON.stringify(result.body))
  const completed = await waitModel(f, result.body.job.id)
  assert.equal(completed.job.status, 'SUCCEEDED', JSON.stringify(completed.job))
  return completed.context.inspections.at(-1)
}
async function generated(f) {
  const inspection = await imported(f)
  const spec = confirmSpec(createThermalModelSpec(inspection))
  const saved = await f.request('/model-spec', { spec, expectedVersion: 0 }, 'PUT')
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body))
  const result = await f.request('/model-preparations', { requestId: randomUUID(), draftVersion: saved.body.draft.version })
  assert.equal(result.response.status, 202, JSON.stringify(result.body))
  const finished = await waitModel(f, result.body.job.id)
  assert.equal(finished.job.status, 'SUCCEEDED', JSON.stringify(finished.job))
  return finished.context.preparations.at(-1)
}

test('CAD App workflow without Agent creates verified engineering input and runs baseline with lineage', async t => {
  const f = await modelApp(); t.after(() => f.close())
  const preparation = await generated(f)
  const validation = await f.request(`/model-preparations/${preparation.id}/validate`, { requestId: randomUUID() })
  assert.equal(validation.response.status, 202, JSON.stringify(validation.body))
  const completed = await waitModel(f, validation.body.job.id)
  assert.equal(completed.context.preparations.at(-1).status, 'VERIFIED', JSON.stringify(completed.job))
  const download = await fetch(f.base + f.path + '/model-artifacts/' + preparation.projectSha256)
  assert.equal(download.status, 200)
  assert.ok((await download.text()).includes('generated'))
  const activate = await f.request(`/model-preparations/${preparation.id}/activate`, { expectedVersion: f.task.version })
  assert.equal(activate.response.status, 200, JSON.stringify(activate.body))
  const task = activate.body.task
  assert.equal(task.requirementSnapshot.sourceModel.sha256, f.task.requirementSnapshot.modelSha256)
  assert.equal(task.requirementSnapshot.modelSha256, preparation.projectSha256)
  const ready = await f.request('/transitions', { expectedVersion: task.version, status: 'READY' })
  assert.equal(ready.response.status, 200, JSON.stringify(ready.body))
  const wrong = await f.request('/runs/baseline', { projectPath: task.requirementSnapshot.projectPath, setup: 'WrongSetup' })
  assert.equal(wrong.response.status, 400)
  const run = await f.request('/runs/baseline', { projectPath: task.requirementSnapshot.projectPath })
  assert.equal(run.response.status, 202, JSON.stringify(run.body))
  const deadline = Date.now() + 5000
  while (f.app.database.getTask(task.id).executionStatus === 'RUNNING' && Date.now() < deadline) await new Promise(done => setTimeout(done, 15))
  assert.equal(f.app.database.getTask(task.id).executionStatus, 'WAITING_FOR_APPROVAL')
  const attempt = f.app.database.listRunAttempts(run.body.run.id)[0]
  assert.equal(attempt.parameters.modelPreparationId, preparation.id)
  assert.equal(attempt.parameters.modelSpecSha256, preparation.specSha256)
  assert.equal(attempt.inputArtifactSha256, preparation.projectSha256)
  const runtimeEvidence = completed.job.artifacts.find(artifact => artifact.role === 'PLUGIN_RUNTIME')
  assert.ok(runtimeEvidence, 'model validation retains the host-recorded plugin identity')
  const recordedIdentity = JSON.parse(await readFile(f.app.artifacts.resolveArtifact(runtimeEvidence.sha256), 'utf8'))
  assert.equal(recordedIdentity.pluginVersion, attempt.pluginVersion)
  assert.equal(f.controls.calls.at(-1).input.setup, 'ThermalBaseline')
  const files = (await f.request('/model-files', undefined, 'GET')).body.files
  assert.ok(files.some(file => file.sha256 === task.requirementSnapshot.sourceModel.sha256 && file.labels.includes('原始模型')))
  assert.ok(files.some(file => file.sha256 === preparation.projectSha256 && file.labels.includes('当前求解输入')))
  assert.ok(files.some(file => file.labels.some(label => label.includes('几何工程'))))
  const solved = files.find(file => file.labels.some(label => label.includes('求解工程')))
  assert.ok(solved)
  assert.equal(await (await fetch(f.base + solved.downloadUrl)).text(), 'solved-project')
})

test('task model files recover named copies without overwriting edits and reject unrelated artifacts', async t => {
  const f = await modelApp(); t.after(() => f.close())
  const sha = f.task.requirementSnapshot.modelSha256
  const listing = await f.request('/model-files', undefined, 'GET')
  assert.equal(listing.response.status, 200)
  assert.equal(listing.body.files[0].name, 'sample.step')
  const located = await f.request(`/model-files/${sha}/location`, {})
  assert.equal(located.response.status, 200)
  assert.equal(await readFile(located.body.path, 'utf8'), 'STEP TEST DOUBLE')
  await writeFile(located.body.path, 'manual edits')
  await f.request(`/model-files/${sha}/location`, {})
  assert.equal(await readFile(located.body.path, 'utf8'), 'manual edits')
  assert.equal(await (await fetch(f.base + listing.body.files[0].downloadUrl)).text(), 'STEP TEST DOUBLE')
  await rm(located.body.path)
  await f.request(`/model-files/${sha}/location`, {})
  assert.equal(await readFile(located.body.path, 'utf8'), 'STEP TEST DOUBLE')
  const directory = await f.request('/model-files/location', {})
  assert.equal(directory.body.kind, 'directory')
  assert.equal(directory.body.path, listing.body.workspacePath)
  const unrelated = f.app.database.createTask(createTask({ title: 'Unrelated', description: '', ownerNodeId: f.app.nodeIdentity.nodeId, requirementSnapshot: {} }))
  assert.equal((await fetch(`${f.base}/api/tasks/${unrelated.id}/model-files/${sha}`)).status, 404)
  assert.equal((await fetch(`${f.base}/api/tasks/${unrelated.id}/model-files/${sha}/location`, { method: 'POST' })).status, 404)
  const denied = await fetch(`${f.base}${f.path}/model-files/${sha}/location`, { method: 'POST', headers: { Origin: 'http://unrelated.example' } })
  assert.equal(denied.status, 403)
})

test('missing confirmations, stale objects, duplicate fields and unsupported inputs are rejected', async t => {
  const f = await modelApp(); t.after(() => f.close())
  const inspection = await imported(f)
  const draft = createThermalModelSpec(inspection)
  assert.ok(validateThermalModelSpec(draft, inspection).length > 5)
  const spec = confirmSpec(draft)
  assert.equal(validateThermalModelSpec(parseThermalModelSpec(spec), inspection).length, 0)
  assert.throws(() => parseThermalModelSpec({ ...spec, objects: [...spec.objects, spec.objects[0]] }), /重复/)
  assert.throws(() => parseThermalModelSpec({ ...spec, meshLevel: { ...spec.meshLevel, value: Infinity } }))
  const stale = structuredClone(spec); stale.objects[0].objectKey = 'stale'
  assert.ok(validateThermalModelSpec(stale, inspection).some(i => i.includes('实体映射')))
  assert.equal((await f.request('/cad-inspections', { requestId: randomUUID(), version: '2024.2', healing: 'yes' })).response.status, 400)
})

test('incomplete engineering drafts can be saved but cannot generate a model', async t => {
  const f = await modelApp(); t.after(() => f.close())
  const inspection = await imported(f)
  const spec = createThermalModelSpec(inspection)
  const saved = await f.request('/model-spec', { spec, expectedVersion: 0 }, 'PUT')
  assert.equal(saved.response.status, 200)
  assert.equal(saved.body.draft.spec.author, '')
  const generated = await f.request('/model-preparations', { requestId: randomUUID(), draftVersion: 1 })
  assert.equal(generated.response.status, 400)
  assert.match(generated.body.error.message, /记录人和建模依据/)
  assert.equal(f.controls.calls.filter(c => c.method === 'prepare').length, 0)
})

test('task cancellation aborts its active model job and never leaves a successful cancelled model', async t => {
  const f = await modelApp(); t.after(() => f.close())
  f.controls.delay = 1000
  const operation = await f.request('/cad-inspections', { requestId: randomUUID(), version: '2024.2', healing: false })
  const cancelled = await f.request('/transitions', { status: 'CANCELLED', expectedVersion: f.task.version })
  assert.equal(cancelled.response.status, 200)
  assert.equal((await waitModel(f, operation.body.job.id)).job.status, 'CANCELLED')
  assert.equal(f.app.database.getTask(f.task.id).executionStatus, 'CANCELLED')
  assert.equal((await f.request(`/model-preparation-jobs/${operation.body.job.id}/cancel`, {})).response.status, 200)
})

test('confirmation cannot change a task to READY while it has an active model job', async t => {
  const f = await modelApp(); t.after(() => f.close())
  f.controls.delay = 1000
  const operation = await f.request('/cad-inspections', { requestId: randomUUID(), version: '2024.2', healing: false })
  const ready = await f.request('/transitions', { status: 'READY', expectedVersion: f.task.version })
  assert.equal(ready.response.status, 409)
  assert.equal(ready.body.error.code, 'MODEL_PREPARATION_ACTIVE')
  assert.equal(f.app.database.getTask(f.task.id).executionStatus, 'DRAFT')
  await f.request(`/model-preparation-jobs/${operation.body.job.id}/cancel`, {})
})

test('idempotent requests, immutable revisions and optimistic draft updates', async t => {
  const f = await modelApp(); t.after(() => f.close())
  const id = randomUUID()
  const first = await f.request('/cad-inspections', { requestId: id, version: '2024.2', healing: false })
  const second = await f.request('/cad-inspections', { requestId: id, version: '2024.2', healing: false })
  assert.equal(first.body.job.id, second.body.job.id)
  assert.equal((await f.request('/cad-inspections', { requestId: id, version: '2024.2', healing: true })).response.status, 409)
  const done = await waitModel(f, first.body.job.id)
  const spec = confirmSpec(createThermalModelSpec(done.context.inspections[0]))
  assert.equal((await f.request('/model-spec', { spec, expectedVersion: 0 }, 'PUT')).response.status, 200)
  assert.equal((await f.request('/model-spec', { spec, expectedVersion: 0 }, 'PUT')).response.status, 409)
  const requestId = randomUUID()
  const created = await f.request('/model-preparations', { requestId, draftVersion: 1 })
  const completed = await waitModel(f, created.body.job.id)
  const original = completed.context.preparations[0]
  spec.objects[0].powerW.value = 15
  assert.equal((await f.request('/model-spec', { spec, expectedVersion: 1 }, 'PUT')).response.status, 200)
  assert.equal((await f.request('/model-preparations', { requestId, draftVersion: 1 })).body.job.id, created.body.job.id)
  const current = (await f.request('/model-preparations')).body
  assert.equal(current.preparations[0].spec.objects[0].powerW.value, 10)
  assert.equal(current.preparations[0].specSha256, original.specSha256)
})

test('readback failure stays nonactivatable and retry preserves failed job evidence', async t => {
  const f = await modelApp(); t.after(() => f.close())
  const prep = await generated(f)
  f.controls.failedValidation = true
  const attempt = await f.request(`/model-preparations/${prep.id}/validate`, { requestId: randomUUID() })
  const failed = await waitModel(f, attempt.body.job.id)
  assert.equal(failed.job.status, 'FAILED')
  assert.equal((await f.request(`/model-preparations/${prep.id}/activate`, { expectedVersion: f.task.version })).response.status, 409)
  f.controls.failedValidation = false
  const retry = await f.request(`/model-preparations/${prep.id}/validate`, { requestId: randomUUID() })
  const success = await waitModel(f, retry.body.job.id)
  assert.equal(success.job.status, 'SUCCEEDED')
  assert.equal(success.context.jobs.find(j => j.id === failed.job.id).status, 'FAILED')
})

test('shared Icepak gate, cancellation and artifact containment', async t => {
  const f = await modelApp(); t.after(() => f.close())
  f.controls.delay = 1000
  const attempt = await f.request('/cad-inspections', { requestId: randomUUID(), version: '2024.2', healing: false })
  assert.equal((await f.request('/cad-inspections', { requestId: randomUUID(), version: '2024.2', healing: false })).response.status, 409)
  await f.request(`/model-preparation-jobs/${attempt.body.job.id}/cancel`, {})
  assert.equal((await waitModel(f, attempt.body.job.id)).job.status, 'CANCELLED')
  f.controls.delay = 0; f.controls.badPath = true
  const bad = await f.request('/cad-inspections', { requestId: randomUUID(), version: '2024.2', healing: false })
  const failed = await waitModel(f, bad.body.job.id)
  assert.equal(failed.job.error.code, 'INVALID_ARTIFACT_PATH')
})

test('restart recovers persisted running model jobs as interrupted without executing them', async t => {
  const f = await modelApp()
  const inspection = await imported(f)
  const home = f.home
  await f.close(false)
  const store = new ModelPreparationStore(joinPath(home, 'data', 'thermal.db'))
  const now = new Date().toISOString()
  const jobId = randomUUID()
  store.createJob({ id: jobId, taskId: f.task.id, kind: 'INSPECT', inspectionId: inspection.id, preparationId: null, requestId: randomUUID(), requestSha256: 'a'.repeat(64),
    status: 'RUNNING', stage: 'cad_importing', input: {}, artifacts: [], error: null, createdAt: now, updatedAt: now })
  store.close()
  // A genuinely exited process owns the stale lock; a second live Core must not clear it.
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { ModelPreparationStore } from '@thermal-agent/sqlite-store'; const s = new ModelPreparationStore(${JSON.stringify(joinPath(home, 'data', 'thermal.db'))}); s.acquireOperation(${JSON.stringify(randomUUID())}, 'inspectCad'); s.close();`], { cwd: process.cwd(), stdio: 'pipe' })
  const restarted = await modelApp(home); t.after(() => restarted.close())
  const context = (await restarted.request('/model-preparations')).body
  assert.equal(context.jobs.find(j => j.id === jobId).status, 'INTERRUPTED')
  assert.equal(restarted.controls.calls.length, 0)
})

import { join as joinPath } from 'node:path'
