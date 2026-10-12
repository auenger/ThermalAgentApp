import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parseAcceptanceArgs, runCadAcceptance } from '../scripts/accept-cad-model.mjs'
import { confirmSpec, modelApp } from './fixtures/model-preparation-app.mjs'

test('acceptance entry accepts only loopback App addresses and requires reviewed config before solve', () => {
  for (const base of ['https://127.0.0.1', 'http://example.com', 'http://user:password@127.0.0.1', 'http://127.0.0.1/api']) {
    assert.throws(() => parseAcceptanceArgs(['--base', base, '--cad', 'case.step']))
  }
  assert.throws(() => parseAcceptanceArgs(['--cad', 'case.step', '--solve']), /reviewed/)
  assert.throws(() => parseAcceptanceArgs(['--task', randomUUID(), '--cad', 'case.step']), /mutually exclusive/)
  assert.equal(parseAcceptanceArgs(['--cad', 'case.step']).solve, false)
  assert.throws(() => parseAcceptanceArgs(['--task', randomUUID(), '--observe-job', randomUUID(), '--spec', 'reviewed.json']), /cannot import/)
})

test('two-stage acceptance collects SHA-checked model and baseline artifacts and never certifies a test double', async t => {
  const f = await modelApp(); t.after(() => f.close())
  const output = join(f.home, 'acceptance')
  const imported = await runCadAcceptance({ base: f.base, taskId: undefined, cad: resolve('assets/cad/reference-natural-convection.step'), version: '2024.2', output, timeoutMinutes: 1 }, { pollMs: 10, log() {} })
  assert.equal(imported.stage, 'CAD_IMPORTED_REVIEW_REQUIRED')
  assert.equal(imported.evidenceKind, 'TEST_DOUBLE_OR_UNVERIFIED')
  assert.equal(f.controls.calls.filter(c => c.method === 'prepare').length, 0)
  const reviewedFile = join(output, 'reviewed.json')
  const spec = confirmSpec(JSON.parse(await readFile(join(output, imported.specFile), 'utf8')))
  await writeFile(reviewedFile, JSON.stringify(spec))
  const result = await runCadAcceptance({ base: f.base, taskId: imported.taskId, spec: reviewedFile, solve: true, output, timeoutMinutes: 1 }, { pollMs: 10, log() {} })
  assert.equal(result.stage, 'BASELINE_SOLVED_ENGINEERING_REVIEW_REQUIRED')
  assert.equal(result.engineeringAcceptance, 'PENDING')
  assert.equal(result.installerAcceptance, 'PENDING')
  assert.equal(result.baselineConverged, true)
  for (const role of ['GENERATED_PROJECT', 'VALIDATION_EVIDENCE', 'MESH_STATS', 'SOLVED_PROJECT', 'SOLVER_RESULT']) assert.ok(result.artifacts.some(a => a.role === role), role)
  for (const artifact of result.artifacts) assert.equal(createHash('sha256').update(await readFile(join(output, artifact.file))).digest('hex'), artifact.sha256)
  const task = f.app.database.getTask(imported.taskId)
  assert.equal(task.executionStatus, 'WAITING_FOR_APPROVAL')
  assert.equal(task.approvalStatus, 'PENDING')
  const input = result.artifacts.find(a => a.role === 'INPUT_PROJECT')
  const wrongTask = await fetch(`${f.base}${f.path}/runs/${result.runIdBaseline}/attempts/${result.attemptId}/artifacts/${input.sha256}`)
  assert.equal(wrongTask.status, 404)
  assert.ok((await readdir(output)).filter(n => n.startsWith('acceptance-')).length === 2)
})

test('observation timeout preserves a live job identity and does not cancel or automatically restart it', async t => {
  const f = await modelApp(); t.after(() => f.close())
  f.controls.delay = 1000
  const cad = join(f.home, 'case.step'); await writeFile(cad, 'test-double CAD')
  const output = join(f.home, 'observation-timeout'); await mkdir(output)
  await assert.rejects(runCadAcceptance({ base: f.base, cad, version: '2024.2', output, timeoutMinutes: 0.00001 }, { pollMs: 10, log() {} }), /may still be running/)
  const path = join(output, (await readdir(output)).find(n => n.startsWith('acceptance-')))
  const record = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(record.stage, 'OBSERVATION_TIMEOUT')
  assert.equal(record.liveJobId, record.importJobId)
  const context = await (await fetch(`${f.base}/api/tasks/${record.taskId}/model-preparations`)).json()
  assert.equal(context.jobs.length, 1)
  assert.ok(['RUNNING', 'QUEUED'].includes(context.jobs[0].status))
  const observed = await runCadAcceptance({ base: f.base, taskId: record.taskId, observeJob: record.liveJobId, output, timeoutMinutes: 1 }, { pollMs: 10, log() {} })
  assert.equal(observed.stage, 'JOB_SUCCEEDED_ENGINEERING_REVIEW_REQUIRED')
  assert.equal(f.controls.calls.filter(c => c.method === 'inspect').length, 1)
})
