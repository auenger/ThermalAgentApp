import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { NodeIdentity, PeerRemoteSolveProcessor } from '@thermal-agent/core'
import { LocalDatabase } from '@thermal-agent/sqlite-store'

test('Executor restart durably notifies Owner of interrupted solve even when new offers are disabled', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-remote-failure-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const executor = NodeIdentity.loadOrCreate(join(home, 'executor'))
  const owner = NodeIdentity.loadOrCreate(join(home, 'owner'))
  const path = join(home, 'executor.db')
  let database = new LocalDatabase(path)
  database.bindLocalIdentity(executor.publicIdentity)
  database.trustPeer(owner.publicIdentity, 'Owner')
  const input = { attemptId: randomUUID(), taskId: randomUUID(), runId: randomUUID(),
    ownerNodeId: owner.nodeId, executorNodeId: executor.nodeId, leaseId: randomUUID(), epoch: 1,
    inputSha256: 'a'.repeat(64), inputSizeBytes: 1, inputOriginalName: 'Project1.aedt',
    parameters: { version: '2024.2', nonGraphical: true } }
  database.acceptRemoteJob(input)
  database.transitionRemoteJob(input.attemptId, input.leaseId, 1, 'OFFERED', 'TRANSFERRING')
  database.transitionRemoteJob(input.attemptId, input.leaseId, 1, 'TRANSFERRING', 'INPUT_READY')
  database.transitionRemoteJob(input.attemptId, input.leaseId, 1, 'INPUT_READY', 'RUNNING')
  database.close()
  database = new LocalDatabase(path)
  t.after(() => database.close())
  const peer = { trusted: true, identity: owner.publicIdentity, address: '127.0.0.1', servicePort: 43111 }
  const discovery = { status: () => ({ discovered: [peer] }) }
  const artifacts = new ArtifactStore(join(home, 'artifacts'))
  const requestMessages = []
  const channel = { async connect() { return { sessionId: 'test' } }, async request(_peer, _session, message) {
    requestMessages.push(message)
    if (requestMessages.length === 1) throw new Error('response lost')
    return { operation: 'task.baseline.failed', attemptId: input.attemptId }
  } }
  const makeProcessor = () => new PeerRemoteSolveProcessor(home, database, artifacts, {}, discovery, channel, {})
  const first = makeProcessor()
  first.start()
  for (let i = 0; i < 50 && requestMessages.length < 1; i++) await delay(10)
  assert.equal(requestMessages.length, 1)
  assert.equal(database.getRemoteJob(input.attemptId).status, 'FAILED')
  assert.equal(database.getRemoteJob(input.attemptId).errorCode, 'EXECUTOR_RESTARTED')
  assert.equal(database.getRemoteJob(input.attemptId).failureNotificationStatus, 'PENDING')
  await first.close()

  const second = makeProcessor()
  second.start()
  for (let i = 0; i < 50 && database.getRemoteJob(input.attemptId).failureNotificationStatus !== 'ACKED'; i++) await delay(10)
  assert.equal(database.getRemoteJob(input.attemptId).failureNotificationStatus, 'ACKED')
  assert.equal(requestMessages[1].code, 'EXECUTOR_RESTARTED')
  assert.equal(requestMessages[1].leaseId, input.leaseId)
  assert.equal(database.remoteExecutionEnabled(), false)
  assert.throws(() => database.markRemoteFailureNotification(input.attemptId, randomUUID(), 1, 'ACKED'))
  await second.close()
})
