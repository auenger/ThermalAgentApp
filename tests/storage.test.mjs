import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { createTask } from '@thermal-agent/domain'
import { LocalDatabase, VersionConflictError } from '@thermal-agent/sqlite-store'

test('SQLite persists task transitions and immutable event history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-agent-sqlite-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'thermal.db')
  const task = createTask({ title: 'Baseline', description: '', ownerNodeId: 'node-a', requirementSnapshot: {} })

  const first = new LocalDatabase(path)
  first.createTask(task)
  const ready = first.transitionTask(task.id, 'READY', 1, '需求已确认')
  first.close()

  const reopened = new LocalDatabase(path)
  t.after(() => reopened.close())
  assert.equal(reopened.getTask(task.id)?.executionStatus, 'READY')
  assert.equal(reopened.listTaskEvents(task.id).length, 2)
  assert.equal(reopened.listTaskEvents(task.id)[1].reason, '需求已确认')
  assert.throws(() => reopened.transitionTask(task.id, 'QUEUED', ready.version - 1), VersionConflictError)
})

test('Artifact Store deduplicates bytes by SHA-256 without storing blobs in SQLite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-agent-artifacts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ArtifactStore(root)
  const first = await store.putBytes(Buffer.from('same-aedt-content'), 'Project1.aedt')
  const second = await store.putBytes(Buffer.from('same-aedt-content'), 'Copy.aedt')

  assert.equal(first.sha256, second.sha256)
  assert.equal(first.relativePath, second.relativePath)
  assert.match(store.resolveArtifact(first.sha256), new RegExp(`${first.sha256}$`, 'u'))
  assert.throws(() => store.resolveArtifact('../escape'), /invalid/u)
})

test('Run and Attempt records preserve execution identity, heartbeat, and selected result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-agent-attempts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'thermal.db')
  const database = new LocalDatabase(path)
  const task = database.createTask(createTask({
    title: 'Project1 baseline', description: '', ownerNodeId: 'node-owner', requirementSnapshot: {},
  }))
  const created = database.createRunWithAttempt({
    taskId: task.id,
    kind: 'BASELINE',
    executorNodeId: 'node-owner',
    pluginId: 'icepak-pyaedt',
    pluginVersion: '0.2.0',
    parameters: { projectPath: 'C:\\models\\Project1.aedt', cores: 4 },
    inputArtifactSha256: 'a'.repeat(64),
  })
  assert.equal(created.run.sequence, 1)
  assert.equal(created.run.status, 'PLANNED')
  assert.equal(created.attempt.status, 'QUEUED')

  database.transitionAttempt(created.attempt.id, 'STARTING', { progressStage: 'aedt_starting' })
  database.transitionAttempt(created.attempt.id, 'RUNNING', { progressStage: 'solving' })
  const heartbeat = database.heartbeatAttempt(created.attempt.id, 'solving')
  assert.ok(heartbeat.startedAt)
  assert.ok(heartbeat.heartbeatAt)
  const finished = database.transitionAttempt(created.attempt.id, 'SUCCEEDED', {
    progressStage: 'result_collected', outputArtifactSha256: 'b'.repeat(64),
  })
  assert.equal(finished.status, 'SUCCEEDED')
  assert.equal(finished.outputArtifactSha256, 'b'.repeat(64))
  assert.ok(finished.finishedAt)
  assert.equal(database.getRun(created.run.id)?.status, 'COMPLETED')
  assert.equal(database.getRun(created.run.id)?.selectedAttemptId, created.attempt.id)
  assert.throws(() => database.transitionAttempt(created.attempt.id, 'RUNNING'), /attempt transition/u)
  assert.deepEqual(
    database.listTaskEvents(task.id).map(event => event.eventType),
    ['task.created', 'run.created', 'attempt.status_changed', 'attempt.status_changed', 'attempt.status_changed'],
  )
  database.close()

  const reopened = new LocalDatabase(path)
  t.after(() => reopened.close())
  assert.equal(reopened.listTaskRuns(task.id)[0].kind, 'BASELINE')
  assert.equal(reopened.listRunAttempts(created.run.id)[0].parameters.cores, 4)
})
