import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { SkillPublisher } from '@thermal-agent/core'
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

test('completed evidence creates a review-only skill draft that publishes only after approval', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-agent-skills-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const database = new LocalDatabase(join(root, 'thermal.db'))
  t.after(() => database.close())
  const incomplete = database.createTask(createTask({
    title: '未完成任务', description: '', ownerNodeId: 'local-node', requirementSnapshot: {},
  }))
  assert.throws(() => database.createSkillDraftFromTask(incomplete.id), /only a COMPLETED task/u)

  const task = database.createTask(createTask({
    title: '机箱 Baseline', description: '', ownerNodeId: 'local-node', requirementSnapshot: {},
  }))
  const { run, attempt } = database.createRunWithAttempt({
    taskId: task.id, kind: 'BASELINE', executorNodeId: 'local-node', pluginId: 'icepak-pyaedt',
    pluginVersion: '0.2.0', parameters: {}, inputArtifactSha256: 'a'.repeat(64),
  })
  for (const [sha256, role] of [
    ['a'.repeat(64), 'INPUT_PROJECT'], ['b'.repeat(64), 'SOLVED_PROJECT'], ['c'.repeat(64), 'SOLVER_RESULT'],
  ]) {
    database.upsertArtifact({ sha256, sizeBytes: 1, mediaType: 'application/octet-stream', originalName: role, relativePath: sha256, createdAt: new Date().toISOString() })
    database.linkAttemptArtifact({ attemptId: attempt.id, sha256, role, createdAt: new Date().toISOString() })
  }
  database.transitionAttempt(attempt.id, 'STARTING')
  database.transitionAttempt(attempt.id, 'RUNNING')
  database.transitionAttempt(attempt.id, 'SUCCEEDED', { outputArtifactSha256: 'b'.repeat(64) })
  database.transitionTask(task.id, 'READY', 1)
  database.transitionTask(task.id, 'QUEUED', 2)
  database.transitionTask(task.id, 'RUNNING', 3)
  database.transitionTask(task.id, 'COMPLETED', 4)

  const draft = database.createSkillDraftFromTask(task.id)
  assert.equal(draft.status, 'DRAFT')
  assert.equal(draft.version.version, 1)
  assert.deepEqual(draft.sources[0].evidence.artifactRoles, ['INPUT_PROJECT', 'SOLVED_PROJECT', 'SOLVER_RESULT'])
  assert.equal(database.createSkillDraftFromTask(task.id).id, draft.id)
  assert.equal(database.getRun(run.id)?.selectedAttemptId, attempt.id)

  const publisher = new SkillPublisher(join(root, 'workspace'))
  const publishedPath = publisher.publish(draft)
  const markdown = await readFile(publishedPath, 'utf8')
  assert.match(markdown, /人工审核/u)
  assert.match(markdown, /不得自动确认需求、启动 Baseline/u)
  const enabled = database.reviewSkill(draft.id, 'ENABLED', 'local-user', draft.updatedAt, publishedPath)
  assert.equal(enabled.status, 'ENABLED')
  assert.equal(enabled.publishedPath, publishedPath)
  publisher.unpublish(publishedPath)
  const disabled = database.reviewSkill(enabled.id, 'DISABLED', 'local-user', enabled.updatedAt, null)
  assert.equal(disabled.status, 'DISABLED')
  await assert.rejects(access(publishedPath))
  const republishedPath = publisher.publish(disabled)
  const reenabled = database.reviewSkill(disabled.id, 'ENABLED', 'local-user', disabled.updatedAt, republishedPath)

  for (let index = 0; index < 3; index += 1) {
    const skillTask = createTask({
      title: `Skill failure ${index + 1}`, description: '', ownerNodeId: 'local-node',
      requirementSnapshot: { projectPath: 'C:\\models\\Project1.aedt', skillId: reenabled.id },
    })
    const createdRun = database.createTaskFromSkill(reenabled.id, skillTask, { projectPath: 'C:\\models\\Project1.aedt' }, {
      probe: { status: 'READY' }, inspect: { verified: true },
    })
    assert.equal(createdRun.run.steps.find(step => step.stepId === 'probe').status, 'COMPLETED')
    database.updateSkillRunStep(skillTask.id, 'confirm', 'COMPLETED', { taskVersion: 2 })
    database.updateSkillRunStep(skillTask.id, 'solve', 'COMPLETED', { attemptId: `attempt-${index}` })
    database.updateSkillRunStep(skillTask.id, 'judge', 'FAILED', {}, { code: 'USER_REJECTED_RESULT', message: '人工拒绝' })
    const finishedRun = database.finishSkillRunForTask(skillTask.id, false, '人工拒绝结果')
    assert.equal(finishedRun.run.status, 'FAILED')
  }
  const needsRepair = database.getSkill(reenabled.id)
  assert.equal(needsRepair.status, 'NEEDS_REPAIR')
  assert.equal(needsRepair.runCount, 3)
  assert.equal(needsRepair.consecutiveFailures, 3)
  publisher.unpublish(needsRepair.publishedPath)
  database.clearSkillPublishedPath(needsRepair.id)
  await assert.rejects(access(republishedPath))
})
