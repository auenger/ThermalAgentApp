import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCoreApp, PeerSecureChannel, PeerTaskInbox } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'
import { LocalDatabase } from '@thermal-agent/sqlite-store'

const readyPlugin = {
  async probeEnvironment() {
    return { pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', protocolVersion: '1', status: 'READY',
      platform: 'win32', aedtVersions: ['2024.2'], selectedVersion: '2024.2', pyaedtAvailable: true,
      licenseStatus: 'AVAILABLE', capabilities: ['baseline_solve'], diagnostics: [] }
  },
}

test('trusted Owner can offer a baseline only after Executor locally opts in; inbox is durable and idempotent', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-peer-offer-'))
  const owner = createCoreApp({ home: join(home, 'owner'), startAgentRuntime: false, pluginClient: readyPlugin,
    discoveryOptions: { port: randomInt(48_000, 55_000), group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  const executorHome = join(home, 'executor')
  let executorReady = false
  const executorPlugin = { async probeEnvironment() {
    return { ...await readyPlugin.probeEnvironment(), status: executorReady ? 'READY' : 'DETECTED' }
  } }
  const executor = createCoreApp({ home: executorHome, startAgentRuntime: false, pluginClient: executorPlugin,
    discoveryOptions: { port: randomInt(55_001, 60_000), group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  t.after(async () => { await executor.close(); await owner.close(); await rm(home, { recursive: true, force: true }) })
  owner.database.trustPeer(executor.nodeIdentity.publicIdentity, 'Executor')
  executor.database.trustPeer(owner.nodeIdentity.publicIdentity, 'Owner')
  executor.server.listen(0, '127.0.0.1')
  await new Promise(resolve => executor.server.once('listening', resolve))
  const address = executor.server.address()
  assert.ok(address && typeof address !== 'string')
  const start = await fetch(`http://127.0.0.1:${address.port}/api/lan/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 0 }),
  })
  assert.equal(start.status, 200)
  const { lan } = await start.json()
  const peer = { identity: executor.nodeIdentity.publicIdentity, address: '127.0.0.1', servicePort: lan.port,
    heartbeat: { pluginStatus: 'READY', aedtVersions: ['2024.2'], maxConcurrent: 1, activeAttempts: 0 },
    lastSeenAt: new Date().toISOString(), trusted: true }
  const task = owner.database.createTask(createTask({ title: 'Remote baseline', description: '',
    ownerNodeId: owner.nodeIdentity.nodeId, requirementSnapshot: { aedtVersion: '2024.2' } }))
  owner.database.transitionTask(task.id, 'READY', task.version)
  const queued = owner.database.transitionTask(task.id, 'QUEUED', task.version + 1)
  const input = await owner.artifacts.putBytes(Buffer.from('test-aedt'), 'Project1.aedt')
  owner.database.upsertArtifact(input)
  const { run, attempt } = owner.database.createRunWithAttempt({ taskId: task.id, kind: 'BASELINE',
    executorNodeId: executor.nodeIdentity.nodeId, pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0',
    parameters: { version: '2024.2', cores: 4 }, inputArtifactSha256: input.sha256 })
  owner.database.linkAttemptArtifact({ attemptId: attempt.id, sha256: input.sha256, role: 'INPUT_PROJECT', createdAt: new Date().toISOString() })
  owner.database.recordPeerHeartbeat(executor.nodeIdentity.nodeId, peer.heartbeat)
  const { lease } = owner.database.claimQueuedTaskLease(task.id, executor.nodeIdentity.nodeId, owner.nodeIdentity.nodeId, queued.version, 60_000)
  const offer = { operation: 'task.baseline.offer', taskId: task.id, runId: run.id, attemptId: attempt.id,
    ownerNodeId: owner.nodeIdentity.nodeId, executorNodeId: executor.nodeIdentity.nodeId,
    leaseId: lease.id, epoch: lease.epoch, leaseExpiresAt: lease.expiresAt,
    inputSha256: input.sha256, inputSizeBytes: input.sizeBytes, inputOriginalName: input.originalName,
    parameters: { version: '2024.2', cores: 4, nonGraphical: true } }
  const channel = new PeerSecureChannel(owner.nodeIdentity, owner.database)
  await assert.rejects(PeerTaskInbox.send(channel, peer, offer), error => error.code === 'PEER_REJECTED')
  assert.equal(executor.database.listRemoteJobs().length, 0)
  const enabled = await fetch(`http://127.0.0.1:${address.port}/api/nodes/remote-execution`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  })
  assert.equal(enabled.status, 200)
  await assert.rejects(PeerTaskInbox.send(channel, peer, offer), error => error.code === 'PEER_REJECTED')
  assert.equal(executor.database.listRemoteJobs().length, 0)
  executorReady = true
  await PeerTaskInbox.send(channel, peer, offer)
  await PeerTaskInbox.send(channel, peer, offer)
  assert.equal(executor.database.listRemoteJobs().length, 1)
  assert.equal(executor.database.getRemoteJob(attempt.id)?.status, 'OFFERED')
  assert.equal(executor.database.getRemoteJob(attempt.id)?.inputSha256, input.sha256)
  await assert.rejects(PeerTaskInbox.send(channel, peer, { ...offer, inputSha256: 'a'.repeat(64) }),
    error => error.code === 'PEER_REJECTED')
  await assert.rejects(PeerTaskInbox.send(channel, peer, { ...offer, attemptId: randomUUID() }),
    error => error.code === 'PEER_REJECTED')
  const reopened = new LocalDatabase(join(executorHome, 'data', 'thermal.db'))
  assert.equal(reopened.remoteExecutionEnabled(), true)
  assert.equal(reopened.getRemoteJob(attempt.id)?.leaseId, lease.id)
  reopened.close()
})
