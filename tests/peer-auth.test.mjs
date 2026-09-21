import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCoreApp, createPeerBeacon, NodeIdentity, PeerAuth, PeerAuthError } from '@thermal-agent/core'
import { LocalDatabase } from '@thermal-agent/sqlite-store'

test('peer challenge binds both identities, target, nonce and trust state', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-peer-auth-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const owner = NodeIdentity.loadOrCreate(join(home, 'owner'))
  const executor = NodeIdentity.loadOrCreate(join(home, 'executor'))
  const ownerDb = new LocalDatabase(join(home, 'owner.db'))
  const executorDb = new LocalDatabase(join(home, 'executor.db'))
  t.after(() => { ownerDb.close(); executorDb.close() })
  ownerDb.trustPeer(executor.publicIdentity, 'Executor')
  executorDb.trustPeer(owner.publicIdentity, 'Owner')
  const ownerAuth = new PeerAuth(owner, ownerDb)
  const executorAuth = new PeerAuth(executor, executorDb)
  const challenge = ownerAuth.createChallenge(executor.nodeId)
  const response = executorAuth.acceptChallenge(challenge)
  assert.equal(ownerAuth.verifyResponse(challenge, response).nodeId, executor.nodeId)
  assert.throws(() => executorAuth.acceptChallenge(challenge), error => error instanceof PeerAuthError && error.code === 'REPLAYED_CHALLENGE')
  assert.throws(() => executorAuth.acceptChallenge({ ...challenge, nonce: 'b'.repeat(43) }), error => error instanceof PeerAuthError && error.code === 'INVALID_SIGNATURE')
  assert.throws(() => executorAuth.acceptChallenge({ ...challenge, targetNodeId: owner.nodeId }), error => error instanceof PeerAuthError && error.code === 'INVALID_CHALLENGE')
  const stale = ownerAuth.createChallenge(executor.nodeId, new Date(Date.now() - 31_000))
  assert.throws(() => executorAuth.acceptChallenge(stale), error => error instanceof PeerAuthError && error.code === 'STALE_CHALLENGE')
  assert.throws(() => ownerAuth.verifyResponse(challenge, { ...response, requestNonce: 'b'.repeat(43) }), error => error instanceof PeerAuthError && error.code === 'INVALID_RESPONSE')
  assert.throws(() => ownerAuth.verifyResponse(challenge, { ...response, signature: 'x' }), error => error instanceof PeerAuthError && error.code === 'INVALID_SIGNATURE')
  ownerDb.revokePeer(executor.nodeId)
  assert.throws(() => ownerAuth.verifyResponse(challenge, response), error => error instanceof PeerAuthError && error.code === 'PEER_NOT_TRUSTED')
})

test('LAN listener accepts only signed trusted peer challenge without browser session', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-peer-lan-'))
  const app = createCoreApp({ home: join(home, 'app'), startAgentRuntime: false,
    discoveryOptions: { port: randomInt(49_000, 59_000), group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  const sender = NodeIdentity.loadOrCreate(join(home, 'sender'))
  const senderDb = new LocalDatabase(join(home, 'sender.db'))
  t.after(async () => { await app.close(); senderDb.close(); await rm(home, { recursive: true, force: true }) })
  app.database.trustPeer(sender.publicIdentity, 'Sender')
  senderDb.trustPeer(app.nodeIdentity.publicIdentity, 'App')
  const senderAuth = new PeerAuth(sender, senderDb)
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const start = await fetch(`http://127.0.0.1:${address.port}/api/lan/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 0 }),
  })
  assert.equal(start.status, 200)
  const { lan } = await start.json()
  const peer = { identity: app.nodeIdentity.publicIdentity, address: '127.0.0.1', servicePort: lan.port,
    heartbeat: { pluginStatus: 'DETECTED', aedtVersions: [], maxConcurrent: 0, activeAttempts: 0 },
    lastSeenAt: new Date().toISOString(), trusted: true }
  const verified = await senderAuth.verifyDiscovered(peer)
  assert.equal(verified.nodeId, app.nodeIdentity.nodeId)

  const challenge = senderAuth.createChallenge(app.nodeIdentity.nodeId)
  const send = () => fetch(`http://127.0.0.1:${lan.port}/api/peer/v1/challenge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(challenge),
  })
  assert.equal((await send()).status, 200)
  assert.equal((await send()).status, 401)
  app.database.revokePeer(sender.nodeId)
  assert.equal((await fetch(`http://127.0.0.1:${lan.port}/api/peer/v1/challenge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(senderAuth.createChallenge(app.nodeIdentity.nodeId)),
  })).status, 401)
})

test('local App verifies a freshly discovered second App and rejects one-sided trust', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-peer-two-apps-'))
  const discoveryPort = randomInt(49_000, 59_000)
  const probeEnvironment = async () => ({ status: 'DETECTED', aedtVersions: [], selectedVersion: null })
  const owner = createCoreApp({ home: join(home, 'owner'), startAgentRuntime: false,
    pluginClient: { probeEnvironment }, discoveryOptions: { port: discoveryPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  const executor = createCoreApp({ home: join(home, 'executor'), startAgentRuntime: false,
    pluginClient: { probeEnvironment }, discoveryOptions: { port: discoveryPort + 1, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  for (const app of [owner, executor]) {
    app.server.listen(0, '127.0.0.1')
    await new Promise(resolve => app.server.once('listening', resolve))
  }
  const udp = createSocket('udp4')
  t.after(async () => { udp.close(); await owner.close(); await executor.close(); await rm(home, { recursive: true, force: true }) })
  owner.database.trustPeer(executor.nodeIdentity.publicIdentity, 'Executor')
  executor.database.trustPeer(owner.nodeIdentity.publicIdentity, 'Owner')
  const localBase = app => {
    const address = app.server.address()
    assert.ok(address && typeof address !== 'string')
    return `http://127.0.0.1:${address.port}`
  }
  const startLan = async app => {
    const response = await fetch(`${localBase(app)}/api/lan/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 0 }),
    })
    assert.equal(response.status, 200)
    return (await response.json()).lan.port
  }
  await startLan(owner)
  const executorPort = await startLan(executor)
  const beacon = createPeerBeacon(executor.nodeIdentity,
    { pluginStatus: 'DETECTED', aedtVersions: [], maxConcurrent: 0, activeAttempts: 0 }, executorPort)
  await new Promise((resolveSend, reject) => udp.send(Buffer.from(JSON.stringify(beacon)), discoveryPort, '127.0.0.1', error => error ? reject(error) : resolveSend()))
  const verifyUrl = `${localBase(owner)}/api/nodes/peers/${executor.nodeIdentity.nodeId}/verify`
  let result
  for (let index = 0; index < 50; index++) {
    result = await fetch(verifyUrl, { method: 'POST' })
    if (result.status === 200) break
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  assert.equal(result.status, 200)
  assert.equal((await result.json()).verification.nodeId, executor.nodeIdentity.nodeId)
  executor.database.revokePeer(owner.nodeIdentity.nodeId)
  assert.equal((await fetch(verifyUrl, { method: 'POST' })).status, 401)
})
