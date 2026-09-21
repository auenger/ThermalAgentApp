import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCoreApp, createPeerBeacon, NodeIdentity, PeerSecureChannel, PeerSecureError } from '@thermal-agent/core'
import { LocalDatabase } from '@thermal-agent/sqlite-store'

test('signed X25519 handshake derives directional AEAD keys and rejects tampering or replay', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-peer-secure-'))
  const alice = NodeIdentity.loadOrCreate(join(home, 'alice'))
  const bob = NodeIdentity.loadOrCreate(join(home, 'bob'))
  const aliceDb = new LocalDatabase(join(home, 'alice.db'))
  const bobDb = new LocalDatabase(join(home, 'bob.db'))
  t.after(async () => { aliceDb.close(); bobDb.close(); await rm(home, { recursive: true, force: true }) })
  aliceDb.trustPeer(bob.publicIdentity, 'Bob')
  bobDb.trustPeer(alice.publicIdentity, 'Alice')
  const aliceChannel = new PeerSecureChannel(alice, aliceDb)
  const bobChannel = new PeerSecureChannel(bob, bobDb)
  const offer = aliceChannel.begin(bob.nodeId)
  const answer = bobChannel.accept(offer)
  const sessionId = aliceChannel.complete(offer, answer)
  assert.equal(sessionId, answer.sessionId)
  const request = aliceChannel.encrypt(sessionId, Buffer.from('private task metadata'))
  assert.equal(JSON.stringify(request).includes('private task metadata'), false)
  assert.equal(bobChannel.decrypt(request).plaintext.toString(), 'private task metadata')
  assert.throws(() => bobChannel.decrypt(request), error => error instanceof PeerSecureError && error.code === 'REPLAYED_MESSAGE')
  const reply = bobChannel.encrypt(sessionId, Buffer.from('ack'))
  assert.equal(aliceChannel.decrypt(reply).plaintext.toString(), 'ack')
  assert.throws(() => bobChannel.accept(offer), error => error instanceof PeerSecureError && error.code === 'REPLAYED_OFFER')

  const modified = aliceChannel.encrypt(sessionId, Buffer.from('original'))
  const tampered = `${modified.ciphertext[0] === 'A' ? 'B' : 'A'}${modified.ciphertext.slice(1)}`
  assert.throws(() => bobChannel.decrypt({ ...modified, ciphertext: tampered }),
    error => error instanceof PeerSecureError && error.code === 'AUTHENTICATION_FAILED')
  assert.equal(bobChannel.decrypt(modified).plaintext.toString(), 'original')
  aliceDb.revokePeer(bob.nodeId)
  assert.throws(() => aliceChannel.encrypt(sessionId, Buffer.from('denied')),
    error => error instanceof PeerSecureError && error.code === 'PEER_NOT_TRUSTED')
  assert.throws(() => aliceChannel.encrypt(sessionId, Buffer.from('expired'), new Date(Date.now() + 5 * 60_000 + 1_000)),
    error => error instanceof PeerSecureError && error.code === 'SESSION_EXPIRED')
})

test('secure session rejects wrong target, stale handshake and swapped response', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-peer-secure-invalid-'))
  const alice = NodeIdentity.loadOrCreate(join(home, 'alice'))
  const bob = NodeIdentity.loadOrCreate(join(home, 'bob'))
  const aliceDb = new LocalDatabase(join(home, 'alice.db'))
  const bobDb = new LocalDatabase(join(home, 'bob.db'))
  t.after(async () => { aliceDb.close(); bobDb.close(); await rm(home, { recursive: true, force: true }) })
  aliceDb.trustPeer(bob.publicIdentity, 'Bob')
  bobDb.trustPeer(alice.publicIdentity, 'Alice')
  const aliceChannel = new PeerSecureChannel(alice, aliceDb)
  const bobChannel = new PeerSecureChannel(bob, bobDb)
  const offer = aliceChannel.begin(bob.nodeId)
  assert.throws(() => bobChannel.accept({ ...offer, targetNodeId: alice.nodeId }),
    error => error instanceof PeerSecureError && error.code === 'WRONG_TARGET')
  assert.throws(() => bobChannel.accept({ ...offer, ephemeralKey: 'x' }),
    error => error instanceof PeerSecureError && error.code === 'INVALID_SIGNATURE')
  const stale = aliceChannel.begin(bob.nodeId, new Date(Date.now() - 31_000))
  assert.throws(() => bobChannel.accept(stale), error => error instanceof PeerSecureError && error.code === 'STALE_HANDSHAKE')
  const answer = bobChannel.accept(offer)
  assert.throws(() => aliceChannel.complete(offer, { ...answer, requestNonce: 'x' }),
    error => error instanceof PeerSecureError && error.code === 'INVALID_ANSWER')
})

test('two Apps establish a signed encrypted LAN session without exposing browser APIs', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-peer-secure-apps-'))
  const discoveryPort = randomInt(49_000, 59_000)
  const pluginClient = { async probeEnvironment() { return { status: 'DETECTED', aedtVersions: [] } } }
  const owner = createCoreApp({ home: join(home, 'owner'), pluginClient, startAgentRuntime: false,
    discoveryOptions: { port: discoveryPort, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  const executor = createCoreApp({ home: join(home, 'executor'), pluginClient, startAgentRuntime: false,
    discoveryOptions: { port: discoveryPort + 1, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false } })
  const udp = createSocket('udp4')
  t.after(async () => { udp.close(); await owner.close(); await executor.close(); await rm(home, { recursive: true, force: true }) })
  owner.database.trustPeer(executor.nodeIdentity.publicIdentity, 'Executor')
  executor.database.trustPeer(owner.nodeIdentity.publicIdentity, 'Owner')
  const localBase = async app => {
    app.server.listen(0, '127.0.0.1')
    await new Promise(resolve => app.server.once('listening', resolve))
    const address = app.server.address()
    assert.ok(address && typeof address !== 'string')
    return `http://127.0.0.1:${address.port}`
  }
  const ownerBase = await localBase(owner)
  const executorBase = await localBase(executor)
  const startLan = async base => {
    const response = await fetch(`${base}/api/lan/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 0 }) })
    assert.equal(response.status, 200)
    return (await response.json()).lan.port
  }
  await startLan(ownerBase)
  const executorPort = await startLan(executorBase)
  const beacon = createPeerBeacon(executor.nodeIdentity,
    { pluginStatus: 'DETECTED', aedtVersions: [], maxConcurrent: 0, activeAttempts: 0 }, executorPort)
  await new Promise((resolveSend, reject) => udp.send(Buffer.from(JSON.stringify(beacon)), discoveryPort, '127.0.0.1', error => error ? reject(error) : resolveSend()))
  const connectUrl = `${ownerBase}/api/nodes/peers/${executor.nodeIdentity.nodeId}/connect`
  let connection
  for (let index = 0; index < 50; index++) {
    connection = await fetch(connectUrl, { method: 'POST' })
    if (connection.status === 200) break
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  assert.equal(connection.status, 200)
  assert.equal((await connection.json()).connection.nodeId, executor.nodeIdentity.nodeId)
  assert.equal((await fetch(`http://127.0.0.1:${executorPort}/api/tasks`)).status, 401)
  assert.equal((await fetch(`http://127.0.0.1:${executorPort}/api/peer/v1/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'x' }),
  })).status, 401)
  const directClient = new PeerSecureChannel(owner.nodeIdentity, owner.database)
  const offer = directClient.begin(executor.nodeIdentity.nodeId)
  const sessionResponse = await fetch(`http://127.0.0.1:${executorPort}/api/peer/v1/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(offer),
  })
  assert.equal(sessionResponse.status, 200)
  const sessionId = directClient.complete(offer, (await sessionResponse.json()).answer)
  const sendEncrypted = message => fetch(`http://127.0.0.1:${executorPort}/api/peer/v1/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message),
  })
  const forbidden = directClient.encrypt(sessionId, Buffer.from(JSON.stringify({ operation: 'solve' })))
  assert.equal((await sendEncrypted(forbidden)).status, 401)
  const allowed = directClient.encrypt(sessionId, Buffer.from(JSON.stringify({ operation: 'ping' })))
  assert.equal((await sendEncrypted(allowed)).status, 200)
  assert.equal((await sendEncrypted(allowed)).status, 401)
  executor.database.revokePeer(owner.nodeIdentity.nodeId)
  assert.equal((await fetch(connectUrl, { method: 'POST' })).status, 401)
})
