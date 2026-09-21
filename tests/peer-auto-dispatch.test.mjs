import assert from 'node:assert/strict'
import { createHash, randomInt } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createCoreApp, createPeerBeacon, NodeIdentity } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'

const readyHeartbeat = { pluginStatus: 'READY', aedtVersions: ['2024.2'], maxConcurrent: 1, activeAttempts: 0 }
const plugin = {
  async probeEnvironment() {
    return { pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', protocolVersion: '1', platform: 'win32',
      status: 'READY', aedtVersions: ['2024.2'], licenseStatus: 'AVAILABLE', capabilities: ['baseline_solve'] }
  },
  async solveProject(input) {
    const data = await readFile(input.projectPath)
    await mkdir(input.outputDir, { recursive: true })
    const projectPath = join(input.outputDir, 'solved.aedt')
    await writeFile(projectPath, Buffer.concat([data, Buffer.from('-solved')]))
    return { status: 'ok', mode: 'solve', inputSha256: createHash('sha256').update(data).digest('hex'),
      validation: { verified: true, checks: [] }, metrics: { tmaxC: 78, converged: true },
      artifacts: { projectPath } }
  },
}

async function listen(app) {
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/lan/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 0 }),
  })
  assert.equal(response.status, 200)
  return { corePort: address.port, lanPort: (await response.json()).lan.port }
}

test('authorized automatic Baseline waits durably, resumes after restart, and dispatches the frozen input to an idle peer', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-auto-dispatch-'))
  const ownerHome = join(home, 'owner')
  const ownerDiscoveryPort = randomInt(45_000, 48_000)
  const executorDiscoveryPort = randomInt(48_001, 52_000)
  let owner = createCoreApp({ home: ownerHome, startAgentRuntime: false, pluginClient: plugin,
    discoveryOptions: { port: ownerDiscoveryPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  let executor
  const udp = createSocket('udp4')
  let beaconTimer
  t.after(async () => { if (beaconTimer) clearInterval(beaconTimer); udp.close(); if (executor) await executor.close(); await owner.close(); await rm(home, { recursive: true, force: true }) })
  let ownerService = await listen(owner)
  const source = join(home, 'Project1.aedt')
  const original = Buffer.from('frozen-aedt-input')
  await writeFile(source, original)
  const task = owner.database.createTask(createTask({ title: 'Automatic Baseline', description: '',
    ownerNodeId: owner.nodeIdentity.nodeId, requirementSnapshot: { projectPath: source, aedtVersion: '2024.2', targetTmaxC: 85 } }))
  const ready = owner.database.transitionTask(task.id, 'READY', task.version)
  await delay(100)
  assert.equal(owner.database.listTaskRuns(task.id).length, 0, 'READY alone must not start an expensive run')
  const enqueue = await fetch(`http://127.0.0.1:${ownerService.corePort}/api/tasks/${task.id}/auto-dispatch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: ready.version, projectPath: source, version: '2024.2', cores: 2 }),
  })
  assert.equal(enqueue.status, 202)
  const intent = (await enqueue.json()).request
  assert.equal(intent.status, 'WAITING')
  assert.equal(intent.inputSha256, createHash('sha256').update(original).digest('hex'))
  assert.equal(owner.database.getTask(task.id).executionStatus, 'READY')
  const duplicateSolve = await fetch(`http://127.0.0.1:${ownerService.corePort}/api/tasks/${task.id}/runs/baseline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: source, version: '2024.2' }),
  })
  assert.equal(duplicateSolve.status, 409, 'a waiting automatic request must block a parallel local solve')
  assert.equal(owner.database.listTaskRuns(task.id).length, 0)
  const cancelledTask = owner.database.createTask(createTask({ title: 'Cancelled automatic Baseline', description: '',
    ownerNodeId: owner.nodeIdentity.nodeId, requirementSnapshot: { projectPath: source, aedtVersion: '2024.2' } }))
  const cancelledReady = owner.database.transitionTask(cancelledTask.id, 'READY', cancelledTask.version)
  const cancelledEnqueue = await fetch(`http://127.0.0.1:${ownerService.corePort}/api/tasks/${cancelledTask.id}/auto-dispatch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: cancelledReady.version, projectPath: source, version: '2024.2' }),
  })
  assert.equal(cancelledEnqueue.status, 202)
  const cancelled = await fetch(`http://127.0.0.1:${ownerService.corePort}/api/tasks/${cancelledTask.id}/auto-dispatch`,
    { method: 'DELETE' })
  assert.equal(cancelled.status, 200)
  assert.equal((await cancelled.json()).request.status, 'CANCELLED')
  await writeFile(source, Buffer.from('changed-source-after-authorization'))
  await owner.close()
  owner = createCoreApp({ home: ownerHome, startAgentRuntime: false, pluginClient: plugin,
    discoveryOptions: { port: ownerDiscoveryPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  assert.equal(owner.database.getAutoDispatch(task.id)?.status, 'WAITING')
  ownerService = await listen(owner)

  executor = createCoreApp({ home: join(home, 'executor'), startAgentRuntime: false, pluginClient: plugin,
    discoveryOptions: { port: executorDiscoveryPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  owner.database.trustPeer(executor.nodeIdentity.publicIdentity, 'Executor')
  executor.database.trustPeer(owner.nodeIdentity.publicIdentity, 'Owner')
  const executorService = await listen(executor)
  const enabled = await fetch(`http://127.0.0.1:${executorService.corePort}/api/nodes/remote-execution`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  })
  assert.equal(enabled.status, 200)
  let executorDiskBytes = 1
  const announce = () => {
    udp.send(Buffer.from(JSON.stringify(createPeerBeacon(executor.nodeIdentity,
      { ...readyHeartbeat, freeDiskBytes: executorDiskBytes }, executorService.lanPort))),
      ownerDiscoveryPort, '127.0.0.1')
    udp.send(Buffer.from(JSON.stringify(createPeerBeacon(owner.nodeIdentity, readyHeartbeat, ownerService.lanPort))),
      executorDiscoveryPort, '127.0.0.1')
  }
  announce()
  beaconTimer = setInterval(announce, 2_000)
  beaconTimer.unref()
  for (let index = 0; index < 100 && owner.database.getPeer(executor.nodeIdentity.nodeId)?.freeDiskBytes !== 1; index++) {
    await delay(20)
  }
  assert.equal(owner.database.getPeer(executor.nodeIdentity.nodeId)?.freeDiskBytes, 1)
  await delay(5_500)
  assert.equal(owner.database.listTaskRuns(task.id).length, 0, 'insufficient disk must not consume a Run or lease')
  executorDiskBytes = Number.MAX_SAFE_INTEGER
  announce()
  let completed = false
  for (let index = 0; index < 300; index++) {
    completed = owner.database.getTask(task.id)?.executionStatus === 'WAITING_FOR_APPROVAL' &&
      owner.database.getAutoDispatch(task.id)?.status === 'DELIVERED'
    if (completed) break
    await delay(50)
  }
  assert.equal(completed, true, JSON.stringify({ task: owner.database.getTask(task.id), intent: owner.database.getAutoDispatch(task.id) }))
  assert.equal(owner.database.listTaskRuns(task.id).length, 1)
  assert.equal(owner.database.listTaskRuns(cancelledTask.id).length, 0)
  const run = owner.database.listTaskRuns(task.id)[0]
  const attempt = owner.database.getAttempt(run.selectedAttemptId)
  assert.equal(attempt.inputArtifactSha256, intent.inputSha256)
  assert.deepEqual(await readFile(executor.artifacts.resolveArtifact(intent.inputSha256)), original)
})

test('queued automatic Baseline reassigns to another idle trusted node after the first lease is revoked', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-auto-reassign-'))
  const ownerPort = randomInt(45_000, 48_000)
  const firstPort = randomInt(48_001, 52_000)
  const secondPort = randomInt(52_001, 56_000)
  const owner = createCoreApp({ home: join(home, 'owner'), startAgentRuntime: false, pluginClient: plugin,
    discoveryOptions: { port: ownerPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  const first = createCoreApp({ home: join(home, 'first'), startAgentRuntime: false, pluginClient: plugin,
    discoveryOptions: { port: firstPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  let second
  const udp = createSocket('udp4')
  let beaconTimer
  t.after(async () => { if (beaconTimer) clearInterval(beaconTimer); udp.close(); if (second) await second.close(); await first.close(); await owner.close(); await rm(home, { recursive: true, force: true }) })
  owner.database.trustPeer(first.nodeIdentity.publicIdentity, 'First')
  first.database.trustPeer(owner.nodeIdentity.publicIdentity, 'Owner')
  const ownerService = await listen(owner)
  const firstService = await listen(first)
  const source = join(home, 'Project1.aedt')
  await writeFile(source, 'immutable-input')
  const task = owner.database.createTask(createTask({ title: 'Automatic reassign', description: '',
    ownerNodeId: owner.nodeIdentity.nodeId, requirementSnapshot: { projectPath: source, aedtVersion: '2024.2' } }))
  const ready = owner.database.transitionTask(task.id, 'READY', task.version)
  const queued = await fetch(`http://127.0.0.1:${ownerService.corePort}/api/tasks/${task.id}/auto-dispatch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: ready.version, projectPath: source, version: '2024.2' }),
  })
  assert.equal(queued.status, 202)
  udp.send(Buffer.from(JSON.stringify(createPeerBeacon(first.nodeIdentity, readyHeartbeat, firstService.lanPort))),
    ownerPort, '127.0.0.1')
  let rejected = false
  for (let index = 0; index < 300; index++) {
    const intent = owner.database.getAutoDispatch(task.id)
    rejected = owner.database.getTask(task.id)?.executionStatus === 'LEASED' &&
      intent?.status === 'WAITING' && intent.selectedPeerNodeId === first.nodeIdentity.nodeId
    if (rejected) break
    await delay(50)
  }
  assert.equal(rejected, true, JSON.stringify(owner.database.getAutoDispatch(task.id)))
  owner.database.revokePeer(first.nodeIdentity.nodeId)
  assert.equal(owner.database.getTask(task.id).executionStatus, 'QUEUED')
  second = createCoreApp({ home: join(home, 'second'), startAgentRuntime: false, pluginClient: plugin,
    discoveryOptions: { port: secondPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  owner.database.trustPeer(second.nodeIdentity.publicIdentity, 'Second')
  second.database.trustPeer(owner.nodeIdentity.publicIdentity, 'Owner')
  const secondService = await listen(second)
  const enabled = await fetch(`http://127.0.0.1:${secondService.corePort}/api/nodes/remote-execution`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  })
  assert.equal(enabled.status, 200)
  const announceSecond = () => {
    udp.send(Buffer.from(JSON.stringify(createPeerBeacon(second.nodeIdentity, readyHeartbeat, secondService.lanPort))),
      ownerPort, '127.0.0.1')
    udp.send(Buffer.from(JSON.stringify(createPeerBeacon(owner.nodeIdentity, readyHeartbeat, ownerService.lanPort))),
      secondPort, '127.0.0.1')
  }
  announceSecond()
  beaconTimer = setInterval(announceSecond, 2_000)
  beaconTimer.unref()
  let finished = false
  for (let index = 0; index < 300; index++) {
    finished = owner.database.getTask(task.id)?.executionStatus === 'WAITING_FOR_APPROVAL' &&
      owner.database.getAutoDispatch(task.id)?.status === 'DELIVERED'
    if (finished) break
    await delay(50)
  }
  assert.equal(finished, true, JSON.stringify({ intent: owner.database.getAutoDispatch(task.id),
    task: owner.database.getTask(task.id), remoteJobs: second.database.listRemoteJobs(),
    discovered: (await (await fetch(`http://127.0.0.1:${secondService.corePort}/api/nodes/discovery`)).json()).discovery }))
  const run = owner.database.listTaskRuns(task.id)[0]
  const attempts = owner.database.listRunAttempts(run.id)
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].status, 'CANCELLED')
  assert.equal(attempts[1].status, 'SUCCEEDED')
  assert.equal(attempts[1].executorNodeId, second.nodeIdentity.nodeId)
})

test('automatic reassignments stop after three Attempts and escalate the Task', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-auto-limit-'))
  const owner = createCoreApp({ home: join(home, 'owner'), startAgentRuntime: false, pluginClient: plugin,
    discoveryOptions: { port: randomInt(56_001, 59_000), group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  t.after(async () => { await owner.close(); await rm(home, { recursive: true, force: true }) })
  const peers = ['first', 'second', 'third'].map(name => NodeIdentity.loadOrCreate(join(home, name)))
  for (const peer of peers) {
    owner.database.trustPeer(peer.publicIdentity, peer.nodeId)
    owner.database.recordPeerHeartbeat(peer.nodeId, readyHeartbeat)
  }
  const input = await owner.artifacts.putBytes(Buffer.from('queued-input'), 'Project1.aedt')
  owner.database.upsertArtifact(input)
  const task = owner.database.createTask(createTask({ title: 'Reassignment limit', description: '',
    ownerNodeId: owner.nodeIdentity.nodeId, requirementSnapshot: { aedtVersion: '2024.2' } }))
  const ready = owner.database.transitionTask(task.id, 'READY', task.version)
  owner.database.enqueueAutoDispatch(task.id, owner.nodeIdentity.nodeId, ready.version, input.sha256,
    { version: '2024.2', nonGraphical: true })
  const prepared = owner.database.prepareRemoteBaseline(task.id, owner.nodeIdentity.nodeId, peers[0].nodeId,
    ready.version, input.sha256, { version: '2024.2', nonGraphical: true }, '0.2.0')
  let current = { task: prepared.task, run: prepared.run, attempt: prepared.attempt }
  for (let index = 0; index < peers.length; index++) {
    const claimed = owner.database.claimQueuedTaskLease(task.id, peers[index].nodeId,
      owner.nodeIdentity.nodeId, current.task.version, 60_000)
    owner.database.revokePeer(peers[index].nodeId)
    assert.equal(owner.database.getLease(claimed.lease.id).status, 'REVOKED')
    if (index + 1 < peers.length) {
      current = owner.database.reassignQueuedRemoteBaseline(task.id, owner.nodeIdentity.nodeId,
        peers[index + 1].nodeId, owner.database.getTask(task.id).version, input.sha256)
    }
  }
  const exhausted = owner.database.exhaustQueuedAutoDispatch(task.id, owner.nodeIdentity.nodeId)
  assert.equal(exhausted.status, 'FAILED')
  assert.equal(exhausted.errorCode, 'AUTO_REASSIGN_LIMIT')
  assert.equal(owner.database.getTask(task.id).executionStatus, 'ESCALATED')
  assert.equal(owner.database.getRun(prepared.run.id).status, 'FAILED')
  const attempts = owner.database.listRunAttempts(prepared.run.id)
  assert.equal(attempts.length, 3)
  assert.ok(attempts.every(item => item.status === 'CANCELLED'))
})
