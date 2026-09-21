import {
  createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, type KeyObject,
} from 'node:crypto'
import { isIP } from 'node:net'
import { PEER_SECURE_MAX_PLAINTEXT_BYTES, PEER_SECURE_PROTOCOL, type PeerIdentity } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import { NodeIdentity } from './node-identity.js'
import type { DiscoveredPeer } from './peer-discovery.js'

const PROTOCOL = PEER_SECURE_PROTOCOL
const CLOCK_WINDOW_MS = 30_000
const SESSION_MS = 5 * 60_000
const MAX_PLAINTEXT = PEER_SECURE_MAX_PLAINTEXT_BYTES

interface OfferPayload {
  protocol: typeof PROTOCOL
  identity: PeerIdentity
  targetNodeId: string
  issuedAt: string
  nonce: string
  ephemeralKey: string
}
export interface SessionOffer extends OfferPayload { signature: string }

interface AnswerPayload {
  protocol: typeof PROTOCOL
  identity: PeerIdentity
  targetNodeId: string
  requestNonce: string
  clientEphemeralKey: string
  ephemeralKey: string
  sessionId: string
  issuedAt: string
  expiresAt: string
}
export interface SessionAnswer extends AnswerPayload { signature: string }

export interface EncryptedPeerMessage {
  protocol: typeof PROTOCOL
  sessionId: string
  counter: number
  ciphertext: string
  tag: string
}

interface PendingSession { privateKey: KeyObject; offer: SessionOffer; createdAt: number }
interface Session {
  peerNodeId: string
  peerPublicKey: string
  sendKey: Buffer
  receiveKey: Buffer
  expiresAt: number
  sendCounter: number
  receiveCounter: number
}

export class PeerSecureError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class PeerSecureChannel {
  private readonly pending = new Map<string, PendingSession>()
  private readonly sessions = new Map<string, Session>()
  private readonly seenOffers = new Map<string, number>()

  constructor(private readonly identity: NodeIdentity, private readonly database: LocalDatabase) {}

  begin(peerNodeId: string, now = new Date()): SessionOffer {
    this.prune(now)
    this.assertTrusted(peerNodeId)
    const ephemeral = generateKeyPairSync('x25519')
    const payload: OfferPayload = {
      protocol: PROTOCOL, identity: this.identity.publicIdentity, targetNodeId: peerNodeId,
      issuedAt: now.toISOString(), nonce: randomBytes(32).toString('base64url'),
      ephemeralKey: exportEphemeral(ephemeral.publicKey),
    }
    const offer = { ...payload, signature: this.identity.sign(bytes(payload)) }
    if (this.pending.size >= 256) this.pending.delete(this.pending.keys().next().value as string)
    this.pending.set(offer.nonce, { privateKey: ephemeral.privateKey, offer, createdAt: now.getTime() })
    return offer
  }

  accept(value: unknown, now = new Date()): SessionAnswer {
    this.prune(now)
    const offer = parseOffer(value)
    if (offer.targetNodeId !== this.identity.nodeId) throw new PeerSecureError('WRONG_TARGET', 'session offer targets another node')
    assertFresh(offer.issuedAt, now)
    this.assertTrusted(offer.identity.nodeId, offer.identity.publicKey)
    if (!NodeIdentity.verify(offer.identity, bytes(offerPayload(offer)), offer.signature)) {
      throw new PeerSecureError('INVALID_SIGNATURE', 'session offer signature is invalid')
    }
    const replayKey = `${offer.identity.nodeId}:${offer.nonce}`
    if (this.seenOffers.has(replayKey)) throw new PeerSecureError('REPLAYED_OFFER', 'session offer has already been used')
    const clientPublic = parseEphemeral(offer.ephemeralKey)
    const ephemeral = generateKeyPairSync('x25519')
    const answerPayload: AnswerPayload = {
      protocol: PROTOCOL, identity: this.identity.publicIdentity, targetNodeId: offer.identity.nodeId,
      requestNonce: offer.nonce, clientEphemeralKey: offer.ephemeralKey,
      ephemeralKey: exportEphemeral(ephemeral.publicKey), sessionId: randomBytes(16).toString('base64url'),
      issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_MS).toISOString(),
    }
    const answer = { ...answerPayload, signature: this.identity.sign(bytes(answerPayload)) }
    const keys = deriveKeys(ephemeral.privateKey, clientPublic, offer, answer)
    this.sessions.set(answer.sessionId, {
      peerNodeId: offer.identity.nodeId, peerPublicKey: offer.identity.publicKey,
      sendKey: keys.serverToClient, receiveKey: keys.clientToServer,
      expiresAt: now.getTime() + SESSION_MS, sendCounter: 0, receiveCounter: 0,
    })
    this.seenOffers.set(replayKey, now.getTime())
    return answer
  }

  complete(offer: SessionOffer, value: unknown, now = new Date()): string {
    this.prune(now)
    const pending = this.pending.get(offer.nonce)
    if (!pending || pending.offer !== offer) throw new PeerSecureError('UNKNOWN_OFFER', 'session offer is not pending')
    this.pending.delete(offer.nonce)
    const answer = parseAnswer(value)
    if (answer.identity.nodeId !== offer.targetNodeId || answer.targetNodeId !== this.identity.nodeId ||
      answer.requestNonce !== offer.nonce || answer.clientEphemeralKey !== offer.ephemeralKey) {
      throw new PeerSecureError('INVALID_ANSWER', 'session answer does not match the offer')
    }
    assertFresh(answer.issuedAt, now)
    const expiry = Date.parse(answer.expiresAt)
    if (!Number.isFinite(expiry) || expiry <= now.getTime() || expiry > now.getTime() + SESSION_MS + CLOCK_WINDOW_MS) {
      throw new PeerSecureError('INVALID_ANSWER', 'session expiry is invalid')
    }
    this.assertTrusted(answer.identity.nodeId, answer.identity.publicKey)
    if (!NodeIdentity.verify(answer.identity, bytes(answerPayload(answer)), answer.signature)) {
      throw new PeerSecureError('INVALID_SIGNATURE', 'session answer signature is invalid')
    }
    const serverPublic = parseEphemeral(answer.ephemeralKey)
    const keys = deriveKeys(pending.privateKey, serverPublic, offer, answer)
    this.sessions.set(answer.sessionId, {
      peerNodeId: answer.identity.nodeId, peerPublicKey: answer.identity.publicKey,
      sendKey: keys.clientToServer, receiveKey: keys.serverToClient,
      expiresAt: expiry, sendCounter: 0, receiveCounter: 0,
    })
    return answer.sessionId
  }

  encrypt(sessionId: string, plaintext: Uint8Array, now = new Date()): EncryptedPeerMessage {
    const session = this.requireSession(sessionId, now)
    if (plaintext.byteLength > MAX_PLAINTEXT) throw new PeerSecureError('MESSAGE_TOO_LARGE', 'peer message exceeds 256 KB')
    const counter = ++session.sendCounter
    const cipher = createCipheriv('aes-256-gcm', session.sendKey, iv(counter), { authTagLength: 16 })
    cipher.setAAD(aad(sessionId, counter, this.identity.nodeId, session.peerNodeId))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return { protocol: PROTOCOL, sessionId, counter, ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }
  }

  decrypt(value: unknown, now = new Date()): { peerNodeId: string; sessionId: string; plaintext: Buffer } {
    if (!isObject(value) || value.protocol !== PROTOCOL || typeof value.sessionId !== 'string' ||
      !/^[A-Za-z0-9_-]{22}$/u.test(value.sessionId) || !Number.isSafeInteger(value.counter) ||
      Number(value.counter) < 1 || typeof value.ciphertext !== 'string' ||
      value.ciphertext.length > 350_000 || typeof value.tag !== 'string' || value.tag.length !== 22) {
      throw new PeerSecureError('INVALID_MESSAGE', 'encrypted peer message is invalid')
    }
    const session = this.requireSession(value.sessionId, now)
    const counter = Number(value.counter)
    if (counter <= session.receiveCounter) throw new PeerSecureError('REPLAYED_MESSAGE', 'encrypted peer message was already used')
    const tag = Buffer.from(value.tag, 'base64url')
    if (tag.byteLength !== 16) throw new PeerSecureError('INVALID_MESSAGE', 'authentication tag is invalid')
    try {
      const decipher = createDecipheriv('aes-256-gcm', session.receiveKey, iv(counter), { authTagLength: 16 })
      decipher.setAAD(aad(value.sessionId, counter, session.peerNodeId, this.identity.nodeId))
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()])
      if (plaintext.byteLength > MAX_PLAINTEXT) throw new PeerSecureError('MESSAGE_TOO_LARGE', 'peer message exceeds 256 KB')
      session.receiveCounter = counter
      return { peerNodeId: session.peerNodeId, sessionId: value.sessionId, plaintext }
    } catch (error) {
      if (error instanceof PeerSecureError) throw error
      throw new PeerSecureError('AUTHENTICATION_FAILED', 'encrypted peer message authentication failed')
    }
  }

  async connect(peer: DiscoveredPeer): Promise<{ nodeId: string; sessionId: string; expiresAt: string }> {
    const seenAt = Date.parse(peer.lastSeenAt)
    if (!peer.trusted || !Number.isFinite(seenAt) || Math.abs(Date.now() - seenAt) > CLOCK_WINDOW_MS ||
      isIP(peer.address) === 0 || !Number.isInteger(peer.servicePort) || peer.servicePort < 1 || peer.servicePort > 65_535) {
      throw new PeerSecureError('PEER_NOT_DISCOVERED', 'trusted peer is not freshly discovered')
    }
    this.assertTrusted(peer.identity.nodeId, peer.identity.publicKey)
    const address = peer.address.includes(':') ? `[${peer.address}]` : peer.address
    const base = `http://${address}:${peer.servicePort}`
    const offer = this.begin(peer.identity.nodeId)
    const answerBody = await postPeerJson(`${base}/api/peer/v1/session`, offer)
    if (!isObject(answerBody)) throw new PeerSecureError('INVALID_ANSWER', 'peer answer is invalid')
    const sessionId = this.complete(offer, answerBody.answer)
    const expiresAt = (answerBody.answer as SessionAnswer).expiresAt
    const request = this.encrypt(sessionId, bytes({ operation: 'ping' }))
    const messageBody = await postPeerJson(`${base}/api/peer/v1/message`, request)
    if (!isObject(messageBody)) throw new PeerSecureError('INVALID_MESSAGE', 'peer response is invalid')
    const result = this.decrypt(messageBody.message)
    let payload: unknown
    try { payload = JSON.parse(result.plaintext.toString('utf8')) as unknown }
    catch { throw new PeerSecureError('INVALID_MESSAGE', 'peer response plaintext is invalid') }
    if (!isObject(payload) || payload.operation !== 'pong' || payload.nodeId !== peer.identity.nodeId) {
      throw new PeerSecureError('INVALID_MESSAGE', 'peer did not confirm the encrypted session')
    }
    return { nodeId: peer.identity.nodeId, sessionId, expiresAt }
  }

  async request(peer: DiscoveredPeer, sessionId: string, payload: object): Promise<unknown> {
    const address = peer.address.includes(':') ? `[${peer.address}]` : peer.address
    const request = this.encrypt(sessionId, bytes(payload))
    const response = await postPeerJson(`http://${address}:${peer.servicePort}/api/peer/v1/message`, request)
    if (!isObject(response)) throw new PeerSecureError('INVALID_RESPONSE', 'encrypted peer response is invalid')
    const decrypted = this.decrypt(response.message)
    if (decrypted.peerNodeId !== peer.identity.nodeId || decrypted.sessionId !== sessionId) {
      throw new PeerSecureError('INVALID_RESPONSE', 'encrypted peer response identity does not match')
    }
    try { return JSON.parse(decrypted.plaintext.toString('utf8')) as unknown }
    catch { throw new PeerSecureError('INVALID_RESPONSE', 'encrypted peer response plaintext is invalid') }
  }

  close(): void {
    this.pending.clear()
    for (const session of this.sessions.values()) {
      session.sendKey.fill(0)
      session.receiveKey.fill(0)
    }
    this.sessions.clear()
  }

  private requireSession(sessionId: string, now: Date): Session {
    this.prune(now)
    const session = this.sessions.get(sessionId)
    if (!session) throw new PeerSecureError('SESSION_EXPIRED', 'peer session is unavailable or expired')
    this.assertTrusted(session.peerNodeId, session.peerPublicKey)
    return session
  }

  private assertTrusted(nodeId: string, publicKey?: string): void {
    const peer = this.database.getPeer(nodeId)
    if (!peer || peer.trustStatus !== 'TRUSTED' || (publicKey && peer.publicKey !== publicKey)) {
      throw new PeerSecureError('PEER_NOT_TRUSTED', 'peer identity is not trusted locally')
    }
  }

  private prune(now: Date): void {
    for (const [key, value] of this.pending) if (value.createdAt + CLOCK_WINDOW_MS <= now.getTime()) this.pending.delete(key)
    for (const [key, value] of this.sessions) if (value.expiresAt <= now.getTime()) {
      value.sendKey.fill(0)
      value.receiveKey.fill(0)
      this.sessions.delete(key)
    }
    for (const [key, value] of this.seenOffers) if (value + CLOCK_WINDOW_MS <= now.getTime()) this.seenOffers.delete(key)
    if (this.sessions.size > 256) {
      const oldest = this.sessions.keys().next().value as string
      const session = this.sessions.get(oldest)
      session?.sendKey.fill(0)
      session?.receiveKey.fill(0)
      this.sessions.delete(oldest)
    }
  }
}

function bytes(value: object): Buffer { return Buffer.from(JSON.stringify(value)) }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isIdentity(value: unknown): value is PeerIdentity {
  return isObject(value) && value.algorithm === 'Ed25519' && typeof value.nodeId === 'string' && typeof value.publicKey === 'string' && value.publicKey.length <= 512
}
function assertFresh(timestamp: string, now: Date): void {
  const time = Date.parse(timestamp)
  if (!Number.isFinite(time) || Math.abs(now.getTime() - time) > CLOCK_WINDOW_MS) throw new PeerSecureError('STALE_HANDSHAKE', 'peer handshake is outside the allowed time window')
}
function exportEphemeral(key: KeyObject): string { return (key.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url') }
function parseEphemeral(value: string): KeyObject {
  if (value.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new PeerSecureError('INVALID_KEY', 'ephemeral key is invalid')
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'x25519') throw new Error('wrong key type')
    return key
  } catch { throw new PeerSecureError('INVALID_KEY', 'ephemeral key is invalid') }
}
function offerPayload(value: SessionOffer): OfferPayload {
  return { protocol: PROTOCOL, identity: value.identity, targetNodeId: value.targetNodeId,
    issuedAt: value.issuedAt, nonce: value.nonce, ephemeralKey: value.ephemeralKey }
}
function answerPayload(value: SessionAnswer): AnswerPayload {
  return { protocol: PROTOCOL, identity: value.identity, targetNodeId: value.targetNodeId,
    requestNonce: value.requestNonce, clientEphemeralKey: value.clientEphemeralKey,
    ephemeralKey: value.ephemeralKey, sessionId: value.sessionId, issuedAt: value.issuedAt, expiresAt: value.expiresAt }
}
function parseOffer(value: unknown): SessionOffer {
  if (!isObject(value) || value.protocol !== PROTOCOL || !isIdentity(value.identity) ||
    typeof value.targetNodeId !== 'string' || typeof value.issuedAt !== 'string' ||
    typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.nonce) ||
    typeof value.ephemeralKey !== 'string' || typeof value.signature !== 'string' || value.signature.length > 120) {
    throw new PeerSecureError('INVALID_OFFER', 'peer session offer is invalid')
  }
  return value as unknown as SessionOffer
}
function parseAnswer(value: unknown): SessionAnswer {
  if (!isObject(value) || value.protocol !== PROTOCOL || !isIdentity(value.identity) ||
    typeof value.targetNodeId !== 'string' || typeof value.requestNonce !== 'string' ||
    typeof value.clientEphemeralKey !== 'string' || typeof value.ephemeralKey !== 'string' ||
    typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(value.sessionId) ||
    typeof value.issuedAt !== 'string' || typeof value.expiresAt !== 'string' ||
    typeof value.signature !== 'string' || value.signature.length > 120) {
    throw new PeerSecureError('INVALID_ANSWER', 'peer session answer is invalid')
  }
  return value as unknown as SessionAnswer
}
function deriveKeys(privateKey: KeyObject, publicKey: KeyObject, offer: SessionOffer, answer: SessionAnswer): { clientToServer: Buffer; serverToClient: Buffer } {
  try {
    const shared = diffieHellman({ privateKey, publicKey })
    const salt = createHash('sha256').update(bytes(offerPayload(offer))).update(bytes(answerPayload(answer))).digest()
    const material = Buffer.from(hkdfSync('sha256', shared, salt, PROTOCOL, 64))
    return { clientToServer: material.subarray(0, 32), serverToClient: material.subarray(32, 64) }
  } catch { throw new PeerSecureError('INVALID_KEY', 'peer key exchange failed') }
}
function iv(counter: number): Buffer {
  const result = Buffer.alloc(12)
  result.writeBigUInt64BE(BigInt(counter), 4)
  return result
}
function aad(sessionId: string, counter: number, from: string, to: string): Buffer {
  return bytes({ protocol: PROTOCOL, sessionId, counter, from, to })
}
async function postPeerJson(url: string, body: object): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5_000) })
  } catch (error) { throw new PeerSecureError('PEER_UNREACHABLE', error instanceof Error ? error.message : 'peer request failed') }
  if (!response.ok) throw new PeerSecureError('PEER_REJECTED', `peer rejected secure request (${response.status})`)
  if (Number(response.headers.get('content-length') ?? 0) > 400_000) throw new PeerSecureError('INVALID_RESPONSE', 'peer response is too large')
  if (!response.body) throw new PeerSecureError('INVALID_RESPONSE', 'peer response is empty')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 400_000) {
        await reader.cancel().catch(() => undefined)
        throw new PeerSecureError('INVALID_RESPONSE', 'peer response is too large')
      }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new PeerSecureError('INVALID_RESPONSE', 'peer response is not JSON') }
}
