import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCoreApp, createPeerBeacon, NodeIdentity, parsePeerBeacon, PeerDiscovery } from '@thermal-agent/core'
import { LocalDatabase } from '@thermal-agent/sqlite-store'

const ready = { pluginStatus: 'READY', aedtVersions: ['2024.2'], maxConcurrent: 1, activeAttempts: 0 }

test('signed peer beacon rejects tampering, stale timestamps, and invalid capacity', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-beacon-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const identity = NodeIdentity.loadOrCreate(home)
  const now = new Date('2026-09-21T10:00:00.000Z')
  const beacon = createPeerBeacon(identity, ready, 43111, now, 'a'.repeat(22))
  const bytes = Buffer.from(JSON.stringify(beacon))
  assert.equal(parsePeerBeacon(bytes, now)?.identity.nodeId, identity.nodeId)
  assert.equal(parsePeerBeacon(bytes, new Date('2026-09-21T10:00:31.000Z')), null)
  assert.equal(parsePeerBeacon(Buffer.from(JSON.stringify({ ...beacon, heartbeat: { ...ready, activeAttempts: 1 } })), now), null)
  assert.equal(parsePeerBeacon(Buffer.from(JSON.stringify({ ...beacon, signature: 'x' })), now), null)
  assert.equal(parsePeerBeacon(Buffer.alloc(4_097), now), null)
  assert.throws(() => createPeerBeacon(identity, { ...ready, maxConcurrent: -1 }, 43111, now), /invalid/u)
})

test('UDP discovery stores only trusted signed capabilities and rejects replay or revoked peers', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-udp-discovery-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const owner = NodeIdentity.loadOrCreate(join(home, 'owner'))
  const executor = NodeIdentity.loadOrCreate(join(home, 'executor'))
  const database = new LocalDatabase(join(home, 'thermal.db'))
  t.after(() => database.close())
  const port = randomInt(47_000, 55_000)
  const discovery = new PeerDiscovery(owner, database, async () => ({ ...ready, pluginStatus: 'DETECTED', maxConcurrent: 0 }), {
    port, group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false, intervalMs: 10_000,
  })
  await discovery.start(43111)
  t.after(() => discovery.stop())
  const sender = createSocket('udp4')
  t.after(() => sender.close())
  const send = async beacon => {
    const bytes = Buffer.from(JSON.stringify(beacon))
    await new Promise((resolveSend, reject) => sender.send(bytes, port, '127.0.0.1', error => error ? reject(error) : resolveSend()))
  }

  const first = createPeerBeacon(executor, ready, 43111)
  await send(first)
  await waitFor(() => discovery.status().discovered.length === 1)
  assert.equal(discovery.status().discovered[0].trusted, false)
  assert.equal(database.getPeer(executor.nodeId), null)
  assert.equal(discovery.ingest(Buffer.from(JSON.stringify(first)), { address: '127.0.0.1' }), null)

  database.trustPeer(executor.publicIdentity, 'Windows worker')
  await send(createPeerBeacon(executor, ready, 43111))
  await waitFor(() => database.getPeer(executor.nodeId)?.pluginStatus === 'READY')
  assert.equal(discovery.status().discovered[0].trusted, true)
  assert.equal(database.listAvailablePeers('2024.2').length, 1)

  database.revokePeer(executor.nodeId)
  await send(createPeerBeacon(executor, ready, 43111))
  await waitFor(() => discovery.status().discovered[0]?.trusted === false)
  assert.equal(database.getPeer(executor.nodeId)?.trustStatus, 'REVOKED')
  assert.equal(database.getPeer(executor.nodeId)?.lastSeenAt, null)
})

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('expected UDP discovery state was not reached')
}

test('Core starts signed discovery with LAN publishing and stops it with LAN', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-discovery-core-'))
  const pluginClient = { async probeEnvironment() { return {
    pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', protocolVersion: '1.0.0',
    status: 'DETECTED', platform: 'win32', aedtVersions: ['2024.2'], selectedVersion: '2024.2',
    pyaedtAvailable: true, licenseStatus: 'UNKNOWN', capabilities: [], diagnostics: [],
  } } }
  const app = createCoreApp({
    home, pluginClient, startAgentRuntime: false,
    discoveryOptions: { port: randomInt(47_000, 55_000), group: '127.0.0.1', bindAddress: '127.0.0.1', multicast: false },
  })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }) })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const before = await fetch(`${base}/api/nodes/discovery`)
  assert.equal((await before.json()).discovery.enabled, false)
  const start = await fetch(`${base}/api/lan/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 0 }),
  })
  assert.equal(start.status, 200)
  assert.equal((await start.json()).discovery.enabled, true)
  const stop = await fetch(`${base}/api/lan/stop`, { method: 'POST' })
  assert.equal(stop.status, 200)
  const after = await fetch(`${base}/api/nodes/discovery`)
  assert.equal((await after.json()).discovery.enabled, false)
})
