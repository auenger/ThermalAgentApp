import assert from 'node:assert/strict'
import { createHash, randomInt } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createCoreApp, createPeerBeacon } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'

const heartbeat = { pluginStatus: 'READY', aedtVersions: ['2024.2'], maxConcurrent: 1, activeAttempts: 0 }
const plugin = {
  async probeEnvironment() {
    return { pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', protocolVersion: '1', status: 'READY',
      platform: 'win32', aedtVersions: ['2024.2'], licenseStatus: 'AVAILABLE', capabilities: ['baseline_solve'] }
  },
  async solveProject(input) {
    const bytes = await readFile(input.projectPath)
    await mkdir(input.outputDir, { recursive: true })
    const projectPath = join(input.outputDir, 'solved.aedt')
    const convergencePath = join(input.outputDir, 'convergence.json')
    await writeFile(projectPath, Buffer.concat([bytes, Buffer.from('-solved')]))
    await writeFile(convergencePath, JSON.stringify({ converged: true }))
    return { status: 'ok', mode: 'solve', inputSha256: createHash('sha256').update(bytes).digest('hex'),
      validation: { verified: true, checks: [] }, metrics: { tmaxC: 80, converged: true, solverNormalCompletion: true },
      artifacts: { projectPath, convergencePath } }
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
  return { corePort: address.port, lan: (await response.json()).lan }
}

test('two Apps execute and verify one remote Icepak Baseline end to end', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-peer-solve-'))
  const ownerDiscoveryPort = randomInt(45_000, 48_000)
  const executorDiscoveryPort = randomInt(48_001, 52_000)
  const owner = createCoreApp({ home: join(home, 'owner'), startAgentRuntime: false, pluginClient: plugin,
    discoveryOptions: { port: ownerDiscoveryPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  const executor = createCoreApp({ home: join(home, 'executor'), startAgentRuntime: false, pluginClient: plugin,
    discoveryOptions: { port: executorDiscoveryPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  const udp = createSocket('udp4')
  t.after(async () => { udp.close(); await executor.close(); await owner.close(); await rm(home, { recursive: true, force: true }) })
  owner.database.trustPeer(executor.nodeIdentity.publicIdentity, 'Executor')
  executor.database.trustPeer(owner.nodeIdentity.publicIdentity, 'Owner')
  const ownerService = await listen(owner)
  const executorService = await listen(executor)
  const enabled = await fetch(`http://127.0.0.1:${executorService.corePort}/api/nodes/remote-execution`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  })
  assert.equal(enabled.status, 200)
  udp.send(Buffer.from(JSON.stringify(createPeerBeacon(executor.nodeIdentity, heartbeat, executorService.lan.port))),
    ownerDiscoveryPort, '127.0.0.1')
  udp.send(Buffer.from(JSON.stringify(createPeerBeacon(owner.nodeIdentity, heartbeat, ownerService.lan.port))),
    executorDiscoveryPort, '127.0.0.1')
  let bothDiscovered = false
  for (let index = 0; index < 50; index++) {
    const one = await (await fetch(`http://127.0.0.1:${ownerService.corePort}/api/nodes/discovery`)).json()
    const two = await (await fetch(`http://127.0.0.1:${executorService.corePort}/api/nodes/discovery`)).json()
    bothDiscovered = one.discovery.discovered.some(peer => peer.identity.nodeId === executor.nodeIdentity.nodeId && peer.trusted) &&
      two.discovery.discovered.some(peer => peer.identity.nodeId === owner.nodeIdentity.nodeId && peer.trusted)
    if (bothDiscovered) break
    await delay(50)
  }
  assert.equal(bothDiscovered, true)
  const projectPath = join(home, 'Project1.aedt')
  await writeFile(projectPath, 'remote-input')
  const task = owner.database.createTask(createTask({ title: 'Remote Baseline', description: '',
    ownerNodeId: owner.nodeIdentity.nodeId,
    requirementSnapshot: { projectPath, aedtVersion: '2024.2', targetTmaxC: 85 } }))
  const ready = owner.database.transitionTask(task.id, 'READY', task.version)
  const dispatched = await fetch(`http://127.0.0.1:${ownerService.corePort}/api/tasks/${task.id}/runs/remote-baseline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerNodeId: executor.nodeIdentity.nodeId, expectedVersion: ready.version,
      projectPath, version: '2024.2' }),
  })
  assert.equal(dispatched.status, 202)
  const offer = await dispatched.json()
  assert.equal(offer.delivered, true)
  let finished = false
  for (let index = 0; index < 200; index++) {
    finished = executor.database.getRemoteJob(offer.attempt.id)?.status === 'COMPLETED'
    if (finished) break
    await delay(50)
  }
  assert.equal(finished, true, JSON.stringify(executor.database.getRemoteJob(offer.attempt.id)))
  const finalTask = owner.database.getTask(task.id)
  assert.equal(finalTask.executionStatus, 'WAITING_FOR_APPROVAL')
  assert.equal(finalTask.thermalVerdict, 'PASS')
  assert.equal(finalTask.approvalStatus, 'PENDING')
  assert.equal(owner.database.getAttempt(offer.attempt.id).status, 'SUCCEEDED')
  assert.equal(owner.database.getLease(offer.lease.id).status, 'RELEASED')
  const roles = new Set(owner.database.listAttemptArtifacts(offer.attempt.id).map(item => item.role))
  assert.deepEqual(roles, new Set(['INPUT_PROJECT', 'SOLVED_PROJECT', 'SOLVER_RESULT', 'CONVERGENCE_EVIDENCE']))

  plugin.solveProject = async () => { throw new Error('mock Icepak process failed') }
  const failedTask = owner.database.createTask(createTask({ title: 'Failing remote Baseline', description: '',
    ownerNodeId: owner.nodeIdentity.nodeId,
    requirementSnapshot: { projectPath, aedtVersion: '2024.2', targetTmaxC: 85 } }))
  const failedReady = owner.database.transitionTask(failedTask.id, 'READY', failedTask.version)
  const failedDispatch = await fetch(`http://127.0.0.1:${ownerService.corePort}/api/tasks/${failedTask.id}/runs/remote-baseline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerNodeId: executor.nodeIdentity.nodeId, expectedVersion: failedReady.version,
      projectPath, version: '2024.2' }),
  })
  assert.equal(failedDispatch.status, 202)
  const failedOffer = await failedDispatch.json()
  assert.equal(failedOffer.delivered, true)
  let failed = false
  for (let index = 0; index < 200; index++) {
    failed = owner.database.getTask(failedTask.id)?.executionStatus === 'FAILED' &&
      executor.database.getRemoteJob(failedOffer.attempt.id)?.status === 'FAILED'
    if (failed) break
    await delay(50)
  }
  assert.equal(failed, true, JSON.stringify(executor.database.getRemoteJob(failedOffer.attempt.id)))
  assert.equal(owner.database.getAttempt(failedOffer.attempt.id).status, 'FAILED')
  assert.equal(owner.database.getLease(failedOffer.lease.id).status, 'RELEASED')
})
