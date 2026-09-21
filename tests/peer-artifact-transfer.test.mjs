import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { createCoreApp, NodeIdentity, PeerArtifactError, PeerArtifactTransfer, PeerSecureChannel, PEER_ARTIFACT_CHUNK_BYTES } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'
import { LocalDatabase } from '@thermal-agent/sqlite-store'

test('executor resumes encrypted input transfer only for its current task lease', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-peer-artifact-'))
  const owner = createCoreApp({ home: join(home, 'owner'), startAgentRuntime: false,
    pluginClient: { async probeEnvironment() { return { status: 'DETECTED', aedtVersions: [] } } },
    discoveryOptions: { port: randomInt(49_000, 59_000), group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  const executorIdentity = NodeIdentity.loadOrCreate(join(home, 'executor'))
  const executorDb = new LocalDatabase(join(home, 'executor.db'))
  const executorArtifacts = new ArtifactStore(join(home, 'executor-artifacts'))
  t.after(async () => { executorDb.close(); await owner.close(); await rm(home, { recursive: true, force: true }) })
  owner.database.trustPeer(executorIdentity.publicIdentity, 'Executor')
  executorDb.trustPeer(owner.nodeIdentity.publicIdentity, 'Owner')
  owner.server.listen(0, '127.0.0.1')
  await new Promise(resolve => owner.server.once('listening', resolve))
  const address = owner.server.address()
  assert.ok(address && typeof address !== 'string')
  const start = await fetch(`http://127.0.0.1:${address.port}/api/lan/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 0 }),
  })
  assert.equal(start.status, 200)
  const { lan } = await start.json()
  const data = Buffer.alloc(PEER_ARTIFACT_CHUNK_BYTES * 2 + 17)
  for (let index = 0; index < data.length; index++) data[index] = index % 251
  const artifact = await owner.artifacts.putBytes(data, 'Project1.aedt')
  owner.database.upsertArtifact(artifact)
  const task = owner.database.createTask(createTask({ title: 'Remote baseline', description: '', ownerNodeId: owner.nodeIdentity.nodeId,
    requirementSnapshot: { aedtVersion: '2024.2' } }))
  owner.database.transitionTask(task.id, 'READY', 1)
  const queued = owner.database.transitionTask(task.id, 'QUEUED', 2)
  const { run, attempt } = owner.database.createRunWithAttempt({ taskId: task.id, kind: 'BASELINE', executorNodeId: executorIdentity.nodeId,
    pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', parameters: {}, inputArtifactSha256: artifact.sha256 })
  owner.database.linkAttemptArtifact({ attemptId: attempt.id, sha256: artifact.sha256, role: 'INPUT_PROJECT', createdAt: new Date().toISOString() })
  owner.database.recordPeerHeartbeat(executorIdentity.nodeId,
    { pluginStatus: 'READY', aedtVersions: ['2024.2'], maxConcurrent: 1, activeAttempts: 0 })
  const { lease } = owner.database.claimQueuedTaskLease(task.id, executorIdentity.nodeId, owner.nodeIdentity.nodeId, queued.version, 60_000)
  const reference = { taskId: task.id, attemptId: attempt.id, leaseId: lease.id, epoch: lease.epoch,
    sha256: artifact.sha256, sizeBytes: artifact.sizeBytes, originalName: artifact.originalName }
  const partialRoot = join(executorArtifacts.root, 'tmp', 'peer-downloads')
  await mkdir(partialRoot, { recursive: true })
  await writeFile(join(partialRoot, `${artifact.sha256}.part`), data.subarray(0, 100_000))
  const channel = new PeerSecureChannel(executorIdentity, executorDb)
  const receiver = new PeerArtifactTransfer(executorIdentity.nodeId, executorDb, executorArtifacts)
  const ownerPeer = { identity: owner.nodeIdentity.publicIdentity, address: '127.0.0.1', servicePort: lan.port,
    heartbeat: { pluginStatus: 'DETECTED', aedtVersions: [], maxConcurrent: 0, activeAttempts: 0 },
    lastSeenAt: new Date().toISOString(), trusted: true }
  const received = await receiver.downloadLeasedInput(ownerPeer, reference, channel)
  assert.equal(received.sha256, artifact.sha256)
  assert.equal(received.originalName, 'Project1.aedt')
  assert.deepEqual(await readFile(executorArtifacts.resolveArtifact(received.sha256)), data)
  assert.equal(executorDb.getArtifact(artifact.sha256)?.sha256, artifact.sha256)

  const partialPath = join(partialRoot, `${artifact.sha256}.part`)
  await writeFile(partialPath, Buffer.alloc(artifact.sizeBytes, 0))
  await assert.rejects(receiver.downloadLeasedInput(ownerPeer, reference, channel),
    error => error instanceof PeerArtifactError && error.code === 'HASH_MISMATCH')
  await assert.rejects(stat(partialPath), { code: 'ENOENT' })

  const service = new PeerArtifactTransfer(owner.nodeIdentity.nodeId, owner.database, owner.artifacts)
  await assert.rejects(service.readLeasedInput('node-' + 'a'.repeat(32), { ...reference, offset: 0 }),
    error => error instanceof PeerArtifactError && error.code === 'ARTIFACT_NOT_AUTHORIZED')
  await assert.rejects(service.readLeasedInput(executorIdentity.nodeId, { ...reference, sha256: 'b'.repeat(64), offset: 0 }),
    error => error instanceof PeerArtifactError && error.code === 'ARTIFACT_NOT_AUTHORIZED')
  await assert.rejects(service.readLeasedInput(executorIdentity.nodeId, { ...reference, epoch: reference.epoch + 1, offset: 0 }),
    error => error instanceof PeerArtifactError && error.code === 'ARTIFACT_NOT_AUTHORIZED')
  assert.equal(owner.database.getRun(run.id)?.taskId, task.id)
  owner.database.revokePeer(executorIdentity.nodeId)
  await assert.rejects(service.readLeasedInput(executorIdentity.nodeId, { ...reference, offset: 0 }),
    error => error instanceof PeerArtifactError && error.code === 'ARTIFACT_NOT_AUTHORIZED')
})
