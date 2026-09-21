import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCoreApp, NodeIdentity } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'
import { LeaseConflictError, LocalDatabase, PeerConflictError, VersionConflictError } from '@thermal-agent/sqlite-store'

test('node identity persists, signs messages, and rejects tampered storage', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-node-id-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const first = NodeIdentity.loadOrCreate(home)
  const second = NodeIdentity.loadOrCreate(home)
  assert.equal(first.nodeId, second.nodeId)
  assert.match(first.nodeId, /^node-[a-f0-9]{32}$/u)
  const message = Buffer.from('lease-offer:task-1:epoch-1')
  const signature = first.sign(message)
  assert.equal(NodeIdentity.verify(second.publicIdentity, message, signature), true)
  assert.equal(NodeIdentity.verify(second.publicIdentity, Buffer.from('different'), signature), false)
  const identityPath = join(home, 'identity', 'node-key.json')
  const stored = JSON.parse(await readFile(identityPath, 'utf8'))
  stored.nodeId = 'node-' + '0'.repeat(32)
  await writeFile(identityPath, JSON.stringify(stored))
  assert.throws(() => NodeIdentity.loadOrCreate(home), /does not match/u)
  if (process.platform !== 'win32') {
    await chmod(identityPath, 0o644)
    assert.throws(() => NodeIdentity.loadOrCreate(home), /readable by other users/u)
  }
})

test('Core owns new tasks even when an API caller submits a forged owner node ID', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-owner-'))
  const app = createCoreApp({ home, startAgentRuntime: false })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }) })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const publicResponse = await fetch(`${base}/api/nodes/local`)
  assert.equal(publicResponse.status, 200)
  const { node } = await publicResponse.json()
  assert.equal(node.nodeId, app.nodeIdentity.nodeId)
  assert.equal('privateKey' in node, false)
  const createdResponse = await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Owner binding', ownerNodeId: 'attacker-node', requirementSnapshot: {} }),
  })
  assert.equal(createdResponse.status, 201)
  assert.equal((await createdResponse.json()).task.ownerNodeId, node.nodeId)

  const otherHome = await mkdtemp(join(tmpdir(), 'thermal-peer-other-'))
  t.after(() => rm(otherHome, { recursive: true, force: true }))
  const other = NodeIdentity.loadOrCreate(otherHome)
  const pairResponse = await fetch(`${base}/api/nodes/peers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...other.publicIdentity, displayName: 'Other Windows App' }),
  })
  assert.equal(pairResponse.status, 201)
  assert.equal((await pairResponse.json()).peer.trustStatus, 'TRUSTED')
  const peersResponse = await fetch(`${base}/api/nodes/peers`)
  assert.equal((await peersResponse.json()).peers.length, 1)
  const revokeResponse = await fetch(`${base}/api/nodes/peers/${other.nodeId}/revoke`, { method: 'POST' })
  assert.equal(revokeResponse.status, 200)
  assert.equal((await revokeResponse.json()).peer.trustStatus, 'REVOKED')
  const invalid = await fetch(`${base}/api/nodes/peers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...other.publicIdentity, nodeId: 'node-' + '0'.repeat(32), displayName: 'Spoof' }),
  })
  assert.equal(invalid.status, 409)
  const crossOrigin = await fetch(`${base}/api/nodes/peers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ ...other.publicIdentity, displayName: 'Spoof' }),
  })
  assert.equal(crossOrigin.status, 403)
  const foreignTask = app.database.createTask(createTask({ title: 'Not ours', description: '', ownerNodeId: other.nodeId, requirementSnapshot: {} }))
  app.database.transitionTask(foreignTask.id, 'READY', 1)
  const startForeign = await fetch(`${base}/api/tasks/${foreignTask.id}/runs/baseline`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: 'C:\\missing.aedt' }),
  })
  assert.equal(startForeign.status, 403)
})

test('Core startup migrates legacy local-node ownership without rewriting unrelated owners', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-owner-migration-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const database = new LocalDatabase(join(home, 'data', 'thermal.db'))
  const legacy = database.createTask(createTask({ title: 'Legacy', description: '', ownerNodeId: 'local-node', requirementSnapshot: {} }))
  const unrelated = database.createTask(createTask({ title: 'Other', description: '', ownerNodeId: 'node-external', requirementSnapshot: {} }))
  database.close()
  const app = createCoreApp({ home, startAgentRuntime: false })
  t.after(() => app.close())
  assert.equal(app.database.getTask(legacy.id)?.ownerNodeId, app.nodeIdentity.nodeId)
  assert.equal(app.database.getTask(legacy.id)?.version, 2)
  assert.equal(app.database.listTaskEvents(legacy.id).at(-1)?.eventType, 'task.owner_identity_migrated')
  assert.equal(app.database.getTask(unrelated.id)?.ownerNodeId, 'node-external')
})

test('Core refuses to replace a lost node key for an existing owned database', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-identity-loss-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const first = createCoreApp({ home, startAgentRuntime: false })
  const original = first.nodeIdentity.nodeId
  assert.equal(first.database.getLocalIdentity()?.nodeId, original)
  await first.close()
  await rm(join(home, 'identity', 'node-key.json'))
  assert.throws(() => createCoreApp({ home, startAgentRuntime: false }), /restore it before opening/u)
})

test('trusted ready peer can claim one fenced lease; stale and late leases never win', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-leases-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const owner = NodeIdentity.loadOrCreate(join(home, 'owner'))
  const executor = NodeIdentity.loadOrCreate(join(home, 'executor'))
  const database = new LocalDatabase(join(home, 'thermal.db'))
  t.after(() => database.close())
  const clock = new Date('2026-09-21T09:00:00.000Z')
  const task = database.createTask(createTask({ title: 'Remote solve', description: '', ownerNodeId: owner.nodeId, requirementSnapshot: { aedtVersion: '2024.2' } }))
  database.transitionTask(task.id, 'READY', 1)
  const queued = database.transitionTask(task.id, 'QUEUED', 2)

  assert.throws(() => database.claimQueuedTaskLease(task.id, executor.nodeId, owner.nodeId, queued.version, 60_000, clock), LeaseConflictError)
  database.trustPeer(executor.publicIdentity, 'Windows Icepak 2', clock)
  database.recordPeerHeartbeat(executor.nodeId, { pluginStatus: 'READY', aedtVersions: ['2023.2'], maxConcurrent: 1, activeAttempts: 0 }, clock)
  assert.throws(() => database.claimQueuedTaskLease(task.id, executor.nodeId, owner.nodeId, queued.version, 60_000, clock), LeaseConflictError)
  database.recordPeerHeartbeat(executor.nodeId, { pluginStatus: 'READY', aedtVersions: ['2024.2'], maxConcurrent: 1, activeAttempts: 0 }, clock)
  assert.equal(database.listAvailablePeers('2024.2', clock)[0].nodeId, executor.nodeId)
  assert.deepEqual(database.listAvailablePeers('2023.2', clock), [])
  const { task: leased, lease } = database.claimQueuedTaskLease(task.id, executor.nodeId, owner.nodeId, queued.version, 60_000, clock)
  assert.equal(leased.executionStatus, 'LEASED')
  assert.equal(leased.executorNodeId, executor.nodeId)
  assert.equal(lease.epoch, 1)
  assert.deepEqual(database.listAvailablePeers('2024.2', clock), [])
  assert.throws(() => database.claimQueuedTaskLease(task.id, executor.nodeId, owner.nodeId, queued.version, 60_000, clock), VersionConflictError)
  assert.equal(database.isCurrentLease(lease.id, task.id, executor.nodeId, 1, new Date('2026-09-21T09:00:30Z')), true)
  assert.equal(database.isCurrentLease(lease.id, task.id, executor.nodeId, 2, clock), false)
  database.renewLease(lease.id, executor.nodeId, 1, 60_000, new Date('2026-09-21T09:00:30Z'))
  assert.deepEqual(database.reconcileLeases(new Date('2026-09-21T09:01:00Z')), [])
  assert.equal(database.reconcileLeases(new Date('2026-09-21T09:01:31Z')).length, 1)
  assert.equal(database.getTask(task.id)?.executionStatus, 'QUEUED')
  assert.equal(database.getTask(task.id)?.executorNodeId, null)
  assert.equal(database.isCurrentLease(lease.id, task.id, executor.nodeId, 1, new Date('2026-09-21T09:01:31Z')), false)
  assert.throws(() => database.renewLease(lease.id, executor.nodeId, 1, 60_000, new Date('2026-09-21T09:01:31Z')), LeaseConflictError)

  database.recordPeerHeartbeat(executor.nodeId, { pluginStatus: 'READY', aedtVersions: ['2024.2'], maxConcurrent: 1, activeAttempts: 0 }, new Date('2026-09-21T09:01:32Z'))
  const second = database.claimQueuedTaskLease(task.id, executor.nodeId, owner.nodeId, 5, 60_000, new Date('2026-09-21T09:01:32Z'))
  assert.equal(second.lease.epoch, 2)
  assert.equal(database.isCurrentLease(lease.id, task.id, executor.nodeId, 1, new Date('2026-09-21T09:01:32Z')), false)
  database.revokePeer(executor.nodeId, new Date('2026-09-21T09:01:40Z'))
  assert.equal(database.getLease(second.lease.id)?.status, 'REVOKED')
  assert.equal(database.getTask(task.id)?.executionStatus, 'QUEUED')
  assert.throws(() => database.recordPeerHeartbeat(executor.nodeId, { pluginStatus: 'READY', aedtVersions: [], maxConcurrent: 1, activeAttempts: 0 }), PeerConflictError)
})

test('a lease expiring during a remote solve escalates instead of duplicating an expensive run', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-lease-partition-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const owner = NodeIdentity.loadOrCreate(join(home, 'owner'))
  const executor = NodeIdentity.loadOrCreate(join(home, 'executor'))
  const database = new LocalDatabase(join(home, 'thermal.db'))
  t.after(() => database.close())
  const clock = new Date('2026-09-21T09:00:00.000Z')
  const task = database.createTask(createTask({ title: 'Long solve', description: '', ownerNodeId: owner.nodeId, requirementSnapshot: {} }))
  database.transitionTask(task.id, 'READY', 1)
  database.transitionTask(task.id, 'QUEUED', 2)
  database.trustPeer(executor.publicIdentity, 'Windows executor', clock)
  database.recordPeerHeartbeat(executor.nodeId, { pluginStatus: 'READY', aedtVersions: [], maxConcurrent: 1, activeAttempts: 0 }, clock)
  const { lease } = database.claimQueuedTaskLease(task.id, executor.nodeId, owner.nodeId, 3, 30_000, clock)
  database.transitionTask(task.id, 'RUNNING', 4)
  database.reconcileLeases(new Date('2026-09-21T09:00:31Z'))
  assert.equal(database.getTask(task.id)?.executionStatus, 'ESCALATED')
  assert.equal(database.isCurrentLease(lease.id, task.id, executor.nodeId, lease.epoch, new Date('2026-09-21T09:00:31Z')), false)
})
