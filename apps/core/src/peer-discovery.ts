import { randomBytes } from 'node:crypto'
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import type { PeerHeartbeat, PeerIdentity } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import { NodeIdentity } from './node-identity.js'

const PROTOCOL = 'thermal-agent-peer-beacon-v1'
const DEFAULT_GROUP = '239.255.43.12'
const DEFAULT_PORT = 43112
const MAX_CLOCK_SKEW_MS = 30_000
const DISCOVERY_TTL_MS = 30_000

export interface PeerBeaconPayload {
  protocol: typeof PROTOCOL
  identity: PeerIdentity
  issuedAt: string
  nonce: string
  servicePort: number
  heartbeat: PeerHeartbeat
}

export interface PeerBeacon extends PeerBeaconPayload { signature: string }

export interface DiscoveredPeer {
  identity: PeerIdentity
  address: string
  servicePort: number
  heartbeat: PeerHeartbeat
  lastSeenAt: string
  trusted: boolean
}

export interface PeerDiscoveryStatus {
  enabled: boolean
  udpPort: number
  group: string
  lastError: string | null
  discovered: DiscoveredPeer[]
}

export interface PeerDiscoveryOptions {
  port?: number
  group?: string
  intervalMs?: number
  bindAddress?: string
  multicast?: boolean
}

export function createPeerBeacon(
  identity: NodeIdentity, heartbeat: PeerHeartbeat, servicePort: number,
  now = new Date(), nonce = randomBytes(16).toString('base64url'),
): PeerBeacon {
  if (!validHeartbeat(heartbeat) || !Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65_535) {
    throw new Error('peer beacon capability or service port is invalid')
  }
  const payload: PeerBeaconPayload = {
    protocol: PROTOCOL,
    identity: identity.publicIdentity,
    issuedAt: now.toISOString(),
    nonce,
    servicePort,
    heartbeat,
  }
  return { ...payload, signature: identity.sign(Buffer.from(JSON.stringify(payload))) }
}

export function parsePeerBeacon(data: Uint8Array, now = new Date()): PeerBeacon | null {
  if (data.byteLength > 4_096) return null
  let value: unknown
  try { value = JSON.parse(Buffer.from(data).toString('utf8')) as unknown }
  catch { return null }
  if (!isObject(value) || value.protocol !== PROTOCOL || !isObject(value.identity) || !isObject(value.heartbeat) ||
    typeof value.issuedAt !== 'string' || typeof value.nonce !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/u.test(value.nonce) ||
    !Number.isInteger(value.servicePort) || Number(value.servicePort) < 1 || Number(value.servicePort) > 65_535 ||
    typeof value.signature !== 'string') return null
  const issued = Date.parse(value.issuedAt)
  if (!Number.isFinite(issued) || Math.abs(now.getTime() - issued) > MAX_CLOCK_SKEW_MS) return null
  const identity = value.identity as unknown as PeerIdentity
  const heartbeat = value.heartbeat as unknown as PeerHeartbeat
  if (!validHeartbeat(heartbeat)) return null
  const payload: PeerBeaconPayload = {
    protocol: PROTOCOL, identity, issuedAt: value.issuedAt, nonce: value.nonce,
    servicePort: Number(value.servicePort), heartbeat,
  }
  if (!NodeIdentity.verify(identity, Buffer.from(JSON.stringify(payload)), value.signature)) return null
  return { ...payload, signature: value.signature }
}

export class PeerDiscovery {
  private socket?: Socket
  private timer?: NodeJS.Timeout
  private servicePort = 0
  private lastError: string | null = null
  private readonly discovered = new Map<string, DiscoveredPeer>()
  private readonly seenNonces = new Map<string, number>()
  private readonly port: number
  private readonly group: string
  private readonly intervalMs: number
  private readonly bindAddress: string
  private readonly multicast: boolean

  constructor(
    private readonly identity: NodeIdentity,
    private readonly database: LocalDatabase,
    private readonly heartbeat: () => Promise<PeerHeartbeat>,
    options: PeerDiscoveryOptions = {},
  ) {
    this.port = options.port ?? DEFAULT_PORT
    this.group = options.group ?? DEFAULT_GROUP
    this.intervalMs = options.intervalMs ?? 5_000
    this.bindAddress = options.bindAddress ?? '0.0.0.0'
    this.multicast = options.multicast !== false
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65_535) throw new Error('peer discovery port is invalid')
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 100) throw new Error('peer discovery interval is invalid')
  }

  status(now = new Date()): PeerDiscoveryStatus {
    this.prune(now)
    return {
      enabled: Boolean(this.socket), udpPort: this.port, group: this.group,
      lastError: this.lastError, discovered: [...this.discovered.values()].sort((a, b) => a.identity.nodeId.localeCompare(b.identity.nodeId)),
    }
  }

  async start(servicePort: number): Promise<PeerDiscoveryStatus> {
    if (this.socket) throw new Error('peer discovery is already enabled')
    if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65_535) throw new Error('peer service port is invalid')
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('message', (data, remote) => this.ingest(data, remote))
    socket.on('error', error => { this.lastError = error.message.slice(0, 500) })
    try {
      await new Promise<void>((resolveListen, reject) => {
        socket.once('listening', resolveListen)
        socket.once('error', reject)
        socket.bind(this.port, this.bindAddress)
      })
      if (this.multicast) {
        socket.addMembership(this.group)
        socket.setMulticastTTL(1)
        socket.setMulticastLoopback(true)
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message.slice(0, 500) : 'peer discovery failed to start'
      socket.close()
      throw error
    }
    this.socket = socket
    this.servicePort = servicePort
    this.lastError = null
    this.timer = setInterval(() => { void this.announce() }, this.intervalMs)
    this.timer.unref()
    await this.announce()
    return this.status()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    const socket = this.socket
    this.socket = undefined
    this.servicePort = 0
    this.discovered.clear()
    this.seenNonces.clear()
    if (!socket) return
    await new Promise<void>(resolveClose => socket.close(resolveClose))
  }

  ingest(data: Uint8Array, remote: Pick<RemoteInfo, 'address'>, now = new Date()): DiscoveredPeer | null {
    this.prune(now)
    const beacon = parsePeerBeacon(data, now)
    if (!beacon || beacon.identity.nodeId === this.identity.nodeId) return null
    const nonceKey = `${beacon.identity.nodeId}:${beacon.nonce}`
    if (this.seenNonces.has(nonceKey)) return null
    this.seenNonces.set(nonceKey, now.getTime())
    if (this.seenNonces.size > 1_000) {
      const oldest = this.seenNonces.keys().next().value
      if (oldest) this.seenNonces.delete(oldest)
    }
    const peer = this.database.getPeer(beacon.identity.nodeId)
    const trusted = peer?.trustStatus === 'TRUSTED' && peer.publicKey === beacon.identity.publicKey
    const discovered: DiscoveredPeer = {
      identity: beacon.identity,
      address: remote.address,
      servicePort: beacon.servicePort,
      heartbeat: beacon.heartbeat,
      lastSeenAt: now.toISOString(),
      trusted,
    }
    this.discovered.set(beacon.identity.nodeId, discovered)
    if (trusted) {
      try { this.database.recordPeerHeartbeat(beacon.identity.nodeId, beacon.heartbeat, now) }
      catch (error) { this.lastError = error instanceof Error ? error.message.slice(0, 500) : 'peer heartbeat could not be stored' }
    }
    if (this.discovered.size > 100) {
      const oldest = [...this.discovered.values()].sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))[0]
      if (oldest) this.discovered.delete(oldest.identity.nodeId)
    }
    return discovered
  }

  private async announce(): Promise<void> {
    const socket = this.socket
    if (!socket) return
    try {
      const heartbeat = await this.heartbeat()
      if (!this.socket || socket !== this.socket) return
      const data = Buffer.from(JSON.stringify(createPeerBeacon(this.identity, heartbeat, this.servicePort)))
      if (data.byteLength > 4_096) throw new Error('peer beacon exceeds 4 KB')
      await new Promise<void>((resolveSend, reject) => {
        socket.send(data, this.port, this.group, error => error ? reject(error) : resolveSend())
      })
      this.lastError = null
    } catch (error) {
      this.lastError = error instanceof Error ? error.message.slice(0, 500) : 'peer announcement failed'
    }
  }

  private prune(now: Date): void {
    for (const [nodeId, peer] of this.discovered) {
      if (Date.parse(peer.lastSeenAt) < now.getTime() - DISCOVERY_TTL_MS) this.discovered.delete(nodeId)
    }
    for (const [key, seenAt] of this.seenNonces) {
      if (seenAt < now.getTime() - DISCOVERY_TTL_MS) this.seenNonces.delete(key)
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validHeartbeat(value: unknown): value is PeerHeartbeat {
  if (!isObject(value)) return false
  return ['NOT_INSTALLED', 'DETECTED', 'NEEDS_CONFIG', 'LAUNCHABLE', 'PROJECT_COMPATIBLE', 'READY', 'BUSY', 'DEGRADED'].includes(String(value.pluginStatus)) &&
    Array.isArray(value.aedtVersions) && value.aedtVersions.length <= 32 &&
    value.aedtVersions.every(version => typeof version === 'string' && version.length > 0 && version.length <= 40) &&
    Number.isInteger(value.maxConcurrent) && Number(value.maxConcurrent) >= 0 && Number(value.maxConcurrent) <= 32 &&
    Number.isInteger(value.activeAttempts) && Number(value.activeAttempts) >= 0 && Number(value.activeAttempts) <= 32
}
