import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { createCoreApp, IcepakExecutionManager, NodeIdentity, PeerArtifactTransfer, PeerSecureChannel } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'
import { LocalDatabase } from '@thermal-agent/sqlite-store'

test('Owner finalizes only current leased Baseline after verified remote evidence and requests human approval', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-remote-complete-'))
  const owner = createCoreApp({ home: join(home, 'owner'), startAgentRuntime: false,
    pluginClient: { async probeEnvironment() { return { status: 'DETECTED', aedtVersions: [] } } },
    discoveryOptions: { port: randomInt(49_000, 59_000), group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  const identity = NodeIdentity.loadOrCreate(join(home, 'executor'))
  const db = new LocalDatabase(join(home, 'executor.db'))
  const artifacts = new ArtifactStore(join(home, 'executor-artifacts'))
  t.after(async () => { db.close(); await owner.close(); await rm(home, { recursive: true, force: true }) })
  owner.database.trustPeer(identity.publicIdentity, 'Executor')
  db.trustPeer(owner.nodeIdentity.publicIdentity, 'Owner')
  owner.server.listen(0, '127.0.0.1')
  await new Promise(resolve => owner.server.once('listening', resolve))
  const address = owner.server.address()
  assert.ok(address && typeof address !== 'string')
  const started = await fetch(`http://127.0.0.1:${address.port}/api/lan/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 0 }),
  })
  assert.equal(started.status, 200)
  const { lan } = await started.json()
  const ownerPeer = { identity: owner.nodeIdentity.publicIdentity, address: '127.0.0.1', servicePort: lan.port,
    heartbeat: { pluginStatus: 'DETECTED', aedtVersions: [], maxConcurrent: 0, activeAttempts: 0 },
    lastSeenAt: new Date().toISOString(), trusted: true }
  const channel = new PeerSecureChannel(identity, db)
  const transfer = new PeerArtifactTransfer(identity.nodeId, db, artifacts)
  const input = await owner.artifacts.putBytes(Buffer.from('input-project'), 'Project1.aedt')
  owner.database.upsertArtifact(input)
  const task = owner.database.createTask(createTask({ title: 'Remote', description: '', ownerNodeId: owner.nodeIdentity.nodeId,
    requirementSnapshot: { targetTmaxC: 85 } }))
  owner.database.transitionTask(task.id, 'READY', task.version)
  const queued = owner.database.transitionTask(task.id, 'QUEUED', task.version + 1)
  const { run, attempt } = owner.database.createRunWithAttempt({ taskId: task.id, kind: 'BASELINE',
    executorNodeId: identity.nodeId, pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', parameters: {},
    inputArtifactSha256: input.sha256 })
  owner.database.linkAttemptArtifact({ attemptId: attempt.id, sha256: input.sha256, role: 'INPUT_PROJECT', createdAt: new Date().toISOString() })
  owner.database.recordPeerHeartbeat(identity.nodeId,
    { pluginStatus: 'READY', aedtVersions: ['2024.2'], maxConcurrent: 1, activeAttempts: 0 })
  const { lease } = owner.database.claimQueuedTaskLease(task.id, identity.nodeId, owner.nodeIdentity.nodeId, queued.version, 60_000)
  const reference = { taskId: task.id, attemptId: attempt.id, leaseId: lease.id, epoch: lease.epoch }
  const { sessionId } = await channel.connect(ownerPeer)
  await assert.rejects(channel.request(ownerPeer, sessionId, { operation: 'task.baseline.start', ...reference, epoch: lease.epoch + 1 }),
    error => error.code === 'PEER_REJECTED')
  const start = await channel.request(ownerPeer, sessionId, { operation: 'task.baseline.start', ...reference })
  assert.equal(start.operation, 'task.baseline.started')
  assert.equal(owner.database.getTask(task.id).executionStatus, 'RUNNING')
  assert.equal(owner.database.getAttempt(attempt.id).status, 'RUNNING')
  new IcepakExecutionManager(join(home, 'owner'), owner.database, owner.artifacts, {})
  assert.equal(owner.database.getAttempt(attempt.id).status, 'RUNNING', 'Owner restart must not interrupt a remote executor')
  assert.equal((await channel.request(ownerPeer, sessionId, { operation: 'task.baseline.start', ...reference })).attemptId, attempt.id)

  const solved = await artifacts.putBytes(Buffer.from('solved-project'), 'solved.aedt')
  const result = await artifacts.putBytes(Buffer.from(JSON.stringify({ status: 'ok', mode: 'solve', inputSha256: input.sha256,
    validation: { verified: true, checks: [] }, metrics: { tmaxC: 80, converged: true, solverNormalCompletion: true } })),
  'result.json', 'application/json')
  db.upsertArtifact(solved)
  db.upsertArtifact(result)
  await assert.rejects(channel.request(ownerPeer, sessionId, { operation: 'task.baseline.complete', ...reference,
    solvedSha256: solved.sha256, resultSha256: result.sha256 }), error => error.code === 'PEER_REJECTED')
  for (const [record, role] of [[solved, 'SOLVED_PROJECT'], [result, 'SOLVER_RESULT']]) {
    await transfer.uploadLeasedResult(ownerPeer, { ...reference, sha256: record.sha256, sizeBytes: record.sizeBytes,
      originalName: record.originalName, mediaType: record.mediaType }, role, channel)
  }
  await writeFile(owner.artifacts.resolveArtifact(solved.sha256), Buffer.alloc(solved.sizeBytes, 0))
  await assert.rejects(channel.request(ownerPeer, sessionId, { operation: 'task.baseline.complete', ...reference,
    solvedSha256: solved.sha256, resultSha256: result.sha256 }), error => error.code === 'PEER_REJECTED')
  assert.equal(owner.database.getAttempt(attempt.id).status, 'RUNNING')
  await writeFile(owner.artifacts.resolveArtifact(solved.sha256), Buffer.from('solved-project'))
  const completed = await channel.request(ownerPeer, sessionId, { operation: 'task.baseline.complete', ...reference,
    solvedSha256: solved.sha256, resultSha256: result.sha256 })
  assert.equal(completed.verdict, 'PASS')
  assert.equal(owner.database.getTask(task.id).executionStatus, 'WAITING_FOR_APPROVAL')
  assert.equal(owner.database.getTask(task.id).approvalStatus, 'PENDING')
  assert.equal(owner.database.getAttempt(attempt.id).status, 'SUCCEEDED')
  assert.equal(owner.database.getRun(run.id).selectedAttemptId, attempt.id)
  assert.equal(owner.database.getLease(lease.id).status, 'RELEASED')
  assert.equal((await channel.request(ownerPeer, sessionId, { operation: 'task.baseline.complete', ...reference,
    solvedSha256: solved.sha256, resultSha256: result.sha256 })).verdict, 'PASS')
  await assert.rejects(transfer.uploadLeasedResult(ownerPeer, { ...reference, sha256: solved.sha256, sizeBytes: solved.sizeBytes },
    'LOG', channel), error => error.code === 'PEER_REJECTED')

  const failedTask = owner.database.createTask(createTask({ title: 'Failing remote run', description: '',
    ownerNodeId: owner.nodeIdentity.nodeId, requirementSnapshot: {} }))
  owner.database.transitionTask(failedTask.id, 'READY', failedTask.version)
  const failedQueued = owner.database.transitionTask(failedTask.id, 'QUEUED', failedTask.version + 1)
  const failedRun = owner.database.createRunWithAttempt({ taskId: failedTask.id, kind: 'BASELINE',
    executorNodeId: identity.nodeId, pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', parameters: {},
    inputArtifactSha256: input.sha256 })
  const failedLease = owner.database.claimQueuedTaskLease(failedTask.id, identity.nodeId,
    owner.nodeIdentity.nodeId, failedQueued.version, 60_000).lease
  const failedReference = { taskId: failedTask.id, attemptId: failedRun.attempt.id,
    leaseId: failedLease.id, epoch: failedLease.epoch }
  await channel.request(ownerPeer, sessionId, { operation: 'task.baseline.start', ...failedReference })
  const failure = await channel.request(ownerPeer, sessionId, { operation: 'task.baseline.fail', ...failedReference,
    code: 'ICEPAK_SOLVE_FAILED', message: 'mock solver failure' })
  assert.equal(failure.operation, 'task.baseline.failed')
  assert.equal(owner.database.getTask(failedTask.id).executionStatus, 'FAILED')
  assert.equal(owner.database.getAttempt(failedRun.attempt.id).errorCode, 'ICEPAK_SOLVE_FAILED')
  assert.equal(owner.database.getLease(failedLease.id).status, 'RELEASED')
  assert.equal((await channel.request(ownerPeer, sessionId, { operation: 'task.baseline.fail', ...failedReference,
    code: 'ICEPAK_SOLVE_FAILED', message: 'mock solver failure' })).operation, 'task.baseline.failed')
  await assert.rejects(channel.request(ownerPeer, sessionId, { operation: 'task.baseline.fail', ...failedReference,
    code: 'OTHER_FAILURE', message: 'late conflicting failure' }), error => error.code === 'PEER_REJECTED')
  await assert.rejects(channel.request(ownerPeer, sessionId, { operation: 'task.baseline.fail', ...failedReference,
    code: 'ICEPAK_SOLVE_FAILED', message: 'late conflicting details' }), error => error.code === 'PEER_REJECTED')

  const expiredTask = owner.database.createTask(createTask({ title: 'Expired remote run', description: '',
    ownerNodeId: owner.nodeIdentity.nodeId, requirementSnapshot: {} }))
  owner.database.transitionTask(expiredTask.id, 'READY', expiredTask.version)
  const expiredQueued = owner.database.transitionTask(expiredTask.id, 'QUEUED', expiredTask.version + 1)
  const expiredRun = owner.database.createRunWithAttempt({ taskId: expiredTask.id, kind: 'BASELINE',
    executorNodeId: identity.nodeId, pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', parameters: {},
    inputArtifactSha256: input.sha256 })
  const expiredLease = owner.database.claimQueuedTaskLease(expiredTask.id, identity.nodeId,
    owner.nodeIdentity.nodeId, expiredQueued.version, 60_000).lease
  await channel.request(ownerPeer, sessionId, { operation: 'task.baseline.start', taskId: expiredTask.id,
    attemptId: expiredRun.attempt.id, leaseId: expiredLease.id, epoch: expiredLease.epoch })
  owner.database.reconcileLeases(new Date(Date.now() + 61_000))
  assert.equal(owner.database.getTask(expiredTask.id).executionStatus, 'ESCALATED')
  assert.equal(owner.database.getAttempt(expiredRun.attempt.id).status, 'INTERRUPTED')
  assert.equal(owner.database.getRun(expiredRun.run.id).status, 'FAILED')
})
