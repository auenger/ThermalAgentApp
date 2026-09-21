import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import type { PeerIdentity } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import { NodeIdentity } from './node-identity.js'
import type { DiscoveredPeer } from './peer-discovery.js'

const PROTOCOL = 'thermal-agent-peer-auth-v1'
const CLOCK_WINDOW_MS = 30_000

export interface PeerChallengePayload {
  protocol: typeof PROTOCOL
  identity: PeerIdentity
  targetNodeId: string
  issuedAt: string
  nonce: string
}
export interface PeerChallenge extends PeerChallengePayload { signature: string }

export interface PeerChallengeResponsePayload {
  protocol: typeof PROTOCOL
  identity: PeerIdentity
  targetNodeId: string
  requestNonce: string
  issuedAt: string
}
export interface PeerChallengeResponse extends PeerChallengeResponsePayload { signature: string }

export class PeerAuthError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class PeerAuth {
  private readonly seen = new Map<string, number>()

  constructor(private readonly identity: NodeIdentity, private readonly database: LocalDatabase) {}

  createChallenge(targetNodeId: string, now = new Date()): PeerChallenge {
    this.assertTrusted(targetNodeId)
    const payload: PeerChallengePayload = {
      protocol: PROTOCOL, identity: this.identity.publicIdentity, targetNodeId,
      issuedAt: now.toISOString(), nonce: randomBytes(32).toString('base64url'),
    }
    return { ...payload, signature: this.identity.sign(Buffer.from(JSON.stringify(payload))) }
  }

  acceptChallenge(value: unknown, now = new Date()): PeerChallengeResponse {
    this.prune(now)
    if (!isObject(value) || value.protocol !== PROTOCOL || !isIdentity(value.identity) ||
      value.targetNodeId !== this.identity.nodeId || typeof value.issuedAt !== 'string' ||
      typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.nonce) ||
      typeof value.signature !== 'string' || value.signature.length > 120) {
      throw new PeerAuthError('INVALID_CHALLENGE', 'peer challenge is invalid')
    }
    this.assertFresh(value.issuedAt, now)
    this.assertTrusted(value.identity.nodeId, value.identity.publicKey)
    const payload: PeerChallengePayload = {
      protocol: PROTOCOL, identity: value.identity, targetNodeId: value.targetNodeId,
      issuedAt: value.issuedAt, nonce: value.nonce,
    }
    if (!NodeIdentity.verify(value.identity, Buffer.from(JSON.stringify(payload)), value.signature)) {
      throw new PeerAuthError('INVALID_SIGNATURE', 'peer challenge signature is invalid')
    }
    const key = `${value.identity.nodeId}:${value.nonce}`
    if (this.seen.has(key)) throw new PeerAuthError('REPLAYED_CHALLENGE', 'peer challenge was already used')
    this.seen.set(key, now.getTime())
    if (this.seen.size > 2_048) this.seen.delete(this.seen.keys().next().value as string)
    const reply: PeerChallengeResponsePayload = {
      protocol: PROTOCOL, identity: this.identity.publicIdentity, targetNodeId: value.identity.nodeId,
      requestNonce: value.nonce, issuedAt: now.toISOString(),
    }
    return { ...reply, signature: this.identity.sign(Buffer.from(JSON.stringify(reply))) }
  }

  verifyResponse(challenge: PeerChallenge, value: unknown, now = new Date()): PeerIdentity {
    if (!isObject(value) || value.protocol !== PROTOCOL || !isIdentity(value.identity) ||
      value.identity.nodeId !== challenge.targetNodeId || value.targetNodeId !== this.identity.nodeId ||
      value.requestNonce !== challenge.nonce || typeof value.issuedAt !== 'string' ||
      typeof value.signature !== 'string' || value.signature.length > 120) {
      throw new PeerAuthError('INVALID_RESPONSE', 'peer challenge response is invalid')
    }
    this.assertFresh(value.issuedAt, now)
    this.assertTrusted(value.identity.nodeId, value.identity.publicKey)
    const payload: PeerChallengeResponsePayload = {
      protocol: PROTOCOL, identity: value.identity, targetNodeId: value.targetNodeId,
      requestNonce: value.requestNonce, issuedAt: value.issuedAt,
    }
    if (!NodeIdentity.verify(value.identity, Buffer.from(JSON.stringify(payload)), value.signature)) {
      throw new PeerAuthError('INVALID_SIGNATURE', 'peer response signature is invalid')
    }
    return value.identity
  }

  async verifyDiscovered(peer: DiscoveredPeer): Promise<{ nodeId: string; verifiedAt: string }> {
    const seenAt = Date.parse(peer.lastSeenAt)
    if (!peer.trusted || isIP(peer.address) === 0 || !Number.isInteger(peer.servicePort) ||
      peer.servicePort < 1 || peer.servicePort > 65_535 ||
      !Number.isFinite(seenAt) || Math.abs(Date.now() - seenAt) > CLOCK_WINDOW_MS) {
      throw new PeerAuthError('PEER_NOT_DISCOVERED', 'trusted peer is not freshly discovered')
    }
    this.assertTrusted(peer.identity.nodeId, peer.identity.publicKey)
    const challenge = this.createChallenge(peer.identity.nodeId)
    const address = peer.address.includes(':') ? `[${peer.address}]` : peer.address
    let response: Response
    try {
      response = await fetch(`http://${address}:${peer.servicePort}/api/peer/v1/challenge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(challenge), redirect: 'error', signal: AbortSignal.timeout(5_000),
      })
    } catch (error) {
      throw new PeerAuthError('PEER_UNREACHABLE', error instanceof Error ? error.message : 'peer connection failed')
    }
    if (!response.ok) throw new PeerAuthError('PEER_REJECTED', `peer rejected identity challenge (${response.status})`)
    if (Number(response.headers.get('content-length') ?? 0) > 8_192) {
      throw new PeerAuthError('INVALID_RESPONSE', 'peer response is too large')
    }
    const raw = await readLimitedResponse(response, 8_192)
    let body: unknown
    try { body = JSON.parse(raw) as unknown }
    catch { throw new PeerAuthError('INVALID_RESPONSE', 'peer response is not JSON') }
    if (!isObject(body)) throw new PeerAuthError('INVALID_RESPONSE', 'peer response is invalid')
    this.verifyResponse(challenge, body.response)
    return { nodeId: peer.identity.nodeId, verifiedAt: new Date().toISOString() }
  }

  private assertTrusted(nodeId: string, publicKey?: string): void {
    const peer = this.database.getPeer(nodeId)
    if (!peer || peer.trustStatus !== 'TRUSTED' || (publicKey && peer.publicKey !== publicKey)) {
      throw new PeerAuthError('PEER_NOT_TRUSTED', 'peer identity is not trusted locally')
    }
  }

  private assertFresh(issuedAt: string, now: Date): void {
    const timestamp = Date.parse(issuedAt)
    if (!Number.isFinite(timestamp) || Math.abs(now.getTime() - timestamp) > CLOCK_WINDOW_MS) {
      throw new PeerAuthError('STALE_CHALLENGE', 'peer challenge is outside the allowed time window')
    }
  }

  private prune(now: Date): void {
    for (const [key, seenAt] of this.seen) if (seenAt < now.getTime() - CLOCK_WINDOW_MS) this.seen.delete(key)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIdentity(value: unknown): value is PeerIdentity {
  return isObject(value) && value.algorithm === 'Ed25519' && typeof value.nodeId === 'string' &&
    typeof value.publicKey === 'string' && value.publicKey.length <= 512
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new PeerAuthError('INVALID_RESPONSE', 'peer response is empty')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new PeerAuthError('INVALID_RESPONSE', 'peer response is too large')
      }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}
