import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PeerIdentity } from '@thermal-agent/contracts'

export type NodeIdentityPublic = PeerIdentity

interface StoredIdentity extends NodeIdentityPublic {
  privateKey: string
}

export class NodeIdentity {
  private constructor(
    readonly publicIdentity: NodeIdentityPublic,
    private readonly privateKey: KeyObject,
  ) {}

  get nodeId(): string { return this.publicIdentity.nodeId }

  sign(message: Uint8Array): string {
    return sign(null, message, this.privateKey).toString('base64url')
  }

  static verify(publicIdentity: NodeIdentityPublic, message: Uint8Array, signature: string): boolean {
    if (publicIdentity.algorithm !== 'Ed25519') return false
    const keyBytes = Buffer.from(publicIdentity.publicKey, 'base64url')
    if (nodeIdFor(keyBytes) !== publicIdentity.nodeId) return false
    try { return verify(null, message, createPublicKey({ key: keyBytes, format: 'der', type: 'spki' }), Buffer.from(signature, 'base64url')) }
    catch { return false }
  }

  static loadOrCreate(home: string, expectedNodeId?: string): NodeIdentity {
    const path = join(home, 'identity', 'node-key.json')
    mkdirSync(dirname(path), { recursive: true })
    try {
      assertPrivateFile(path)
      const identity = NodeIdentity.fromStored(JSON.parse(readFileSync(path, 'utf8')) as StoredIdentity)
      if (expectedNodeId && identity.nodeId !== expectedNodeId) throw new Error('node private key does not match the persisted database owner')
      return identity
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
    if (expectedNodeId) throw new Error('node private key is missing; restore it before opening the existing database')
    const pair = generateKeyPairSync('ed25519')
    const publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' })
    const privateBytes = pair.privateKey.export({ format: 'der', type: 'pkcs8' })
    const stored: StoredIdentity = {
      nodeId: nodeIdFor(publicBytes),
      algorithm: 'Ed25519',
      publicKey: publicBytes.toString('base64url'),
      privateKey: privateBytes.toString('base64url'),
    }
    try {
      writeFileSync(path, `${JSON.stringify(stored)}\n`, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!isExistingFile(error)) throw error
      assertPrivateFile(path)
      return NodeIdentity.fromStored(JSON.parse(readFileSync(path, 'utf8')) as StoredIdentity)
    }
    return NodeIdentity.fromStored(stored)
  }

  private static fromStored(value: StoredIdentity): NodeIdentity {
    if (!value || value.algorithm !== 'Ed25519' || typeof value.privateKey !== 'string' || typeof value.publicKey !== 'string') {
      throw new Error('stored node identity is invalid')
    }
    const privateKey = createPrivateKey({ key: Buffer.from(value.privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
    const derivedPublic = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
    if (derivedPublic.toString('base64url') !== value.publicKey || nodeIdFor(derivedPublic) !== value.nodeId) {
      throw new Error('stored node identity does not match its private key')
    }
    return new NodeIdentity({ nodeId: value.nodeId, algorithm: 'Ed25519', publicKey: value.publicKey }, privateKey)
  }
}

export function nodeIdFor(publicKeyDer: Uint8Array): string {
  return `node-${createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32)}`
}

function isMissingFile(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
function isExistingFile(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'EEXIST' }

function assertPrivateFile(path: string): void {
  if (process.platform === 'win32') return
  if ((statSync(path).mode & 0o077) !== 0) throw new Error('stored node identity is readable by other users')
}
