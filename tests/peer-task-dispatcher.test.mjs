import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createCoreApp, createPeerBeacon } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'

const plugin = { async probeEnvironment() {
  return { pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', protocolVersion: '1', status: 'READY',
    platform: 'win32', aedtVersions: ['2024.2'], selectedVersion: '2024.2', pyaedtAvailable: true,
    licenseStatus: 'AVAILABLE', capabilities: ['baseline_solve'], diagnostics: [] }
} }

async function listen(app) {
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

async function startLan(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/lan/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 0 }),
  })
  assert.equal(response.status, 200)
  return (await response.json()).lan
}

test('Owner snapshots and dispatches one remote Baseline; rejected offer retries without duplicate Run', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-dispatch-'))
  const discoveryPort = randomInt(45_000, 48_000)
  const executorDiscoveryPort = randomInt(48_001, 52_000)
  const executorHome = join(home, 'executor')
  const owner = createCoreApp({ home: join(home, 'owner'), startAgentRuntime: false, startRemoteSolve: false, pluginClient: plugin,
    discoveryOptions: { port: discoveryPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  let executor = createCoreApp({ home: executorHome, startAgentRuntime: false, startRemoteSolve: false, pluginClient: plugin,
    discoveryOptions: { port: executorDiscoveryPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  const udp = createSocket('udp4')
  t.after(async () => { udp.close(); await executor.close(); await owner.close(); await rm(home, { recursive: true, force: true }) })
  owner.database.trustPeer(executor.nodeIdentity.publicIdentity, 'Executor')
  executor.database.trustPeer(owner.nodeIdentity.publicIdentity, 'Owner')
  const ownerPort = await listen(owner)
  let executorPort = await listen(executor)
  const ownerLan = await startLan(ownerPort)
  const executorLan = await startLan(executorPort)
  const heartbeat = { pluginStatus: 'READY', aedtVersions: ['2024.2'], maxConcurrent: 1, activeAttempts: 0 }
  udp.send(Buffer.from(JSON.stringify(createPeerBeacon(executor.nodeIdentity, heartbeat, executorLan.port))),
    discoveryPort, '127.0.0.1')
  let discovered = false
  for (let index = 0; index < 30; index++) {
    const response = await fetch(`http://127.0.0.1:${ownerPort}/api/nodes/discovery`)
    const body = await response.json()
    discovered = body.discovery.discovered.some(peer => peer.identity.nodeId === executor.nodeIdentity.nodeId && peer.trusted)
    if (discovered) break
    await delay(50)
  }
  assert.equal(discovered, true)

  const source = join(home, 'Project1.aedt')
  const bytes = Buffer.from('immutable-aedt-input')
  await writeFile(source, bytes)
  const task = owner.database.createTask(createTask({ title: 'Remote baseline', description: '',
    ownerNodeId: owner.nodeIdentity.nodeId, requirementSnapshot: { projectPath: source, aedtVersion: '2024.2' } }))
  const ready = owner.database.transitionTask(task.id, 'READY', task.version)
  const alternate = join(home, 'Other.aedt')
  await writeFile(alternate, Buffer.from('different-project'))
  const mismatched = await fetch(`http://127.0.0.1:${ownerPort}/api/tasks/${task.id}/runs/remote-baseline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerNodeId: executor.nodeIdentity.nodeId, expectedVersion: ready.version,
      projectPath: alternate, version: '2024.2', cores: 4 }),
  })
  assert.equal(mismatched.status, 409)
  assert.equal((await mismatched.json()).error.code, 'INPUT_NOT_CONFIRMED')
  assert.equal(owner.database.listTaskRuns(task.id).length, 0)
  const dispatch = await fetch(`http://127.0.0.1:${ownerPort}/api/tasks/${task.id}/runs/remote-baseline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerNodeId: executor.nodeIdentity.nodeId, expectedVersion: ready.version,
      projectPath: source, version: '2024.2', cores: 4 }),
  })
  assert.equal(dispatch.status, 202)
  const first = await dispatch.json()
  assert.equal(first.delivered, false)
  assert.equal(first.task.executionStatus, 'LEASED')
  assert.equal(owner.database.listTaskRuns(task.id).length, 1)
  assert.equal(executor.database.listRemoteJobs().length, 0)
  const input = owner.database.getArtifact(first.attempt.inputArtifactSha256)
  assert.ok(input)
  assert.deepEqual(await readFile(owner.artifacts.resolveArtifact(input.sha256)), bytes)

  const enabled = await fetch(`http://127.0.0.1:${executorPort}/api/nodes/remote-execution`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  })
  assert.equal(enabled.status, 200)
  const retryUrl = `http://127.0.0.1:${ownerPort}/api/tasks/${task.id}/runs/remote-baseline/retry-offer`
  const retry = await fetch(retryUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerNodeId: executor.nodeIdentity.nodeId, expectedVersion: first.task.version }) })
  assert.equal(retry.status, 202)
  const second = await retry.json()
  assert.equal(second.delivered, true)
  assert.equal(second.attempt.id, first.attempt.id)
  assert.equal(owner.database.listTaskRuns(task.id).length, 1)
  assert.equal(executor.database.getRemoteJob(first.attempt.id)?.leaseId, first.lease.id)

  owner.database.reconcileLeases(new Date(Date.now() + 61_000))
  const requeued = owner.database.getTask(task.id)
  assert.equal(requeued.executionStatus, 'QUEUED')
  const thirdResponse = await fetch(retryUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerNodeId: executor.nodeIdentity.nodeId, expectedVersion: requeued.version }) })
  assert.equal(thirdResponse.status, 202)
  const third = await thirdResponse.json()
  assert.equal(third.delivered, true)
  assert.equal(third.lease.epoch, first.lease.epoch + 1)
  assert.equal(executor.database.getRemoteJob(first.attempt.id)?.leaseId, third.lease.id)
  assert.equal(executor.database.listRemoteJobs().length, 1)

  await executor.close()
  executor = createCoreApp({ home: executorHome, startAgentRuntime: false, startRemoteSolve: false, pluginClient: plugin,
    discoveryOptions: { port: executorDiscoveryPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  assert.equal(executor.nodeIdentity.nodeId, first.attempt.executorNodeId)
  assert.equal(executor.database.getRemoteJob(first.attempt.id)?.status, 'OFFERED')
  executorPort = await listen(executor)
  const restartedLan = await startLan(executorPort)
  udp.send(Buffer.from(JSON.stringify(createPeerBeacon(executor.nodeIdentity, heartbeat, restartedLan.port))),
    discoveryPort, '127.0.0.1')
  udp.send(Buffer.from(JSON.stringify(createPeerBeacon(owner.nodeIdentity, heartbeat, ownerLan.port))),
    executorDiscoveryPort, '127.0.0.1')
  let ownerDiscovered = false
  for (let index = 0; index < 30; index++) {
    const response = await fetch(`http://127.0.0.1:${executorPort}/api/nodes/discovery`)
    const body = await response.json()
    ownerDiscovered = body.discovery.discovered.some(peer => peer.identity.nodeId === owner.nodeIdentity.nodeId && peer.trusted)
    if (ownerDiscovered) break
    await delay(50)
  }
  assert.equal(ownerDiscovered, true)
  let inputReady = false
  for (let index = 0; index < 200; index++) {
    inputReady = executor.database.getRemoteJob(first.attempt.id)?.status === 'INPUT_READY'
    if (inputReady) break
    await delay(50)
  }
  assert.equal(inputReady, true)
  assert.deepEqual(await readFile(executor.artifacts.resolveArtifact(input.sha256)), bytes)

  owner.database.reconcileLeases(new Date(Date.now() + 61_000))
  const queuedAgain = owner.database.getTask(task.id)
  assert.equal(queuedAgain.executionStatus, 'QUEUED')
  const redispatchResponse = await fetch(retryUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerNodeId: executor.nodeIdentity.nodeId, expectedVersion: queuedAgain.version }) })
  assert.equal(redispatchResponse.status, 202)
  const redispatched = await redispatchResponse.json()
  assert.equal(redispatched.delivered, true, JSON.stringify(redispatched))
  assert.equal(redispatched.lease.epoch, third.lease.epoch + 1)
  let readyAgain = false
  for (let index = 0; index < 100; index++) {
    const job = executor.database.getRemoteJob(first.attempt.id)
    readyAgain = job?.status === 'INPUT_READY' && job.epoch === redispatched.lease.epoch
    if (readyAgain) break
    await delay(50)
  }
  assert.equal(readyAgain, true)
})
