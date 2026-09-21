import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import type { ArtifactRecord } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import { PeerSecureChannel } from './peer-secure-channel.js'
import { PeerLeaseControl } from './peer-lease-control.js'
import type { DiscoveredPeer } from './peer-discovery.js'

export const PEER_ARTIFACT_CHUNK_BYTES = 128 * 1024

export interface LeasedInputReference {
  taskId: string
  attemptId: string
  leaseId: string
  epoch: number
  sha256: string
  sizeBytes: number
  originalName?: string
  mediaType?: string
}

export interface InputChunk {
  operation: 'artifact.input.chunk.result'
  sha256: string
  sizeBytes: number
  offset: number
  data: string
  eof: boolean
  originalName: string
  mediaType: string
}

export interface LeasedResultChunk extends LeasedInputReference {
  operation: 'artifact.result.chunk'
  role: 'SOLVED_PROJECT' | 'SOLVER_RESULT' | 'CONVERGENCE_EVIDENCE' | 'LOG'
  offset: number
  data: string
  eof: boolean
  originalName: string
  mediaType: string
}

export class PeerArtifactError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class PeerArtifactTransfer {
  private readonly activeDownloads = new Set<string>()
  private readonly activeUploads = new Set<string>()
  constructor(
    private readonly localNodeId: string,
    private readonly database: LocalDatabase,
    private readonly artifacts: ArtifactStore,
  ) {}

  async readLeasedInput(peerNodeId: string, value: unknown): Promise<InputChunk> {
    const input = parseReference(value)
    const attempt = this.database.getAttempt(input.attemptId)
    const run = attempt ? this.database.getRun(attempt.runId) : null
    const task = this.database.getTask(input.taskId)
    if (!task || task.ownerNodeId !== this.localNodeId || !run || run.taskId !== task.id ||
      attempt?.executorNodeId !== peerNodeId || attempt.inputArtifactSha256 !== input.sha256 ||
      this.database.listTaskRuns(task.id).at(-1)?.id !== run.id ||
      this.database.listRunAttempts(run.id).at(-1)?.id !== attempt.id ||
      !this.database.isCurrentLease(input.leaseId, task.id, peerNodeId, input.epoch) ||
      !this.database.listAttemptArtifacts(attempt.id).some(link => link.role === 'INPUT_PROJECT' && link.sha256 === input.sha256)) {
      throw new PeerArtifactError('ARTIFACT_NOT_AUTHORIZED', 'input artifact is not authorized by the current lease')
    }
    const artifact = this.database.getArtifact(input.sha256)
    if (!artifact || artifact.sizeBytes !== input.sizeBytes || input.offset > artifact.sizeBytes) {
      throw new PeerArtifactError('ARTIFACT_NOT_FOUND', 'input artifact metadata is missing or inconsistent')
    }
    const path = this.artifacts.resolveArtifact(input.sha256)
    const handle = await open(path, 'r')
    let data: Buffer
    try {
      const info = await handle.stat()
      if (info.size !== artifact.sizeBytes || !info.isFile()) throw new PeerArtifactError('ARTIFACT_CHANGED', 'input artifact changed on disk')
      const size = Math.min(PEER_ARTIFACT_CHUNK_BYTES, artifact.sizeBytes - input.offset)
      data = Buffer.alloc(size)
      const { bytesRead } = await handle.read(data, 0, size, input.offset)
      if (bytesRead !== size) throw new PeerArtifactError('ARTIFACT_CHANGED', 'input artifact was truncated during transfer')
    } finally { await handle.close() }
    if (!this.database.isCurrentLease(input.leaseId, task.id, peerNodeId, input.epoch)) {
      throw new PeerArtifactError('LEASE_EXPIRED', 'lease expired while reading the input artifact')
    }
    return {
      operation: 'artifact.input.chunk.result', sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes, offset: input.offset,
      data: data.toString('base64url'), eof: input.offset + data.byteLength === artifact.sizeBytes,
      originalName: artifact.originalName, mediaType: artifact.mediaType,
    }
  }

  async receiveResultChunk(peerNodeId: string, value: unknown): Promise<{ operation: 'artifact.result.chunk.accepted'; offset: number; complete: boolean; sha256: string }> {
    const chunk = parseResultChunk(value)
    const key = `${chunk.attemptId}-${chunk.role}-${chunk.sha256}`
    if (this.activeUploads.has(key)) throw new PeerArtifactError('TRANSFER_BUSY', 'this result artifact is being written')
    this.activeUploads.add(key)
    try {
      this.assertResultLease(peerNodeId, chunk)
      const completed = this.database.listAttemptArtifacts(chunk.attemptId).some(item => item.role === chunk.role && item.sha256 === chunk.sha256)
      if (completed) {
        const artifact = this.database.getArtifact(chunk.sha256)
        if (!artifact || artifact.sizeBytes !== chunk.sizeBytes) throw new PeerArtifactError('ARTIFACT_CHANGED', 'linked result metadata is inconsistent')
        return { operation: 'artifact.result.chunk.accepted', offset: chunk.sizeBytes, complete: true, sha256: chunk.sha256 }
      }
      const partialRoot = join(this.artifacts.root, 'tmp', 'peer-results')
      await mkdir(partialRoot, { recursive: true })
      const partialPath = join(partialRoot, `${key}.part`)
      const handle = await open(partialPath, 'a')
      await handle.close()
      let offset = (await stat(partialPath)).size
      if (offset > chunk.sizeBytes) throw new PeerArtifactError('INVALID_PARTIAL', 'partial result exceeds declared size')
      if (chunk.offset < offset) {
        const current = await open(partialPath, 'r')
        try {
          const existing = Buffer.alloc(Math.min(chunk.data.byteLength, offset - chunk.offset))
          const { bytesRead } = await current.read(existing, 0, existing.length, chunk.offset)
          if (bytesRead !== existing.length || !existing.equals(chunk.data.subarray(0, existing.length))) {
            throw new PeerArtifactError('CHUNK_CONFLICT', 'replayed result chunk differs from stored data')
          }
          if (chunk.data.byteLength > existing.length) {
            await appendFile(partialPath, chunk.data.subarray(existing.length))
            offset = chunk.offset + chunk.data.byteLength
          }
        } finally { await current.close() }
      } else if (chunk.offset === offset) {
        if (chunk.data.byteLength) await appendFile(partialPath, chunk.data)
        offset += chunk.data.byteLength
      } else throw new PeerArtifactError('INVALID_OFFSET', `expected offset ${offset}`)
      this.assertResultLease(peerNodeId, chunk)
      if (!chunk.eof || offset !== chunk.sizeBytes) {
        return { operation: 'artifact.result.chunk.accepted', offset, complete: false, sha256: chunk.sha256 }
      }
      const hash = createHash('sha256')
      for await (const part of createReadStream(partialPath)) hash.update(part)
      if (hash.digest('hex') !== chunk.sha256) {
        await unlink(partialPath)
        throw new PeerArtifactError('HASH_MISMATCH', 'uploaded result artifact hash does not match')
      }
      this.assertResultLease(peerNodeId, chunk)
      const artifact = await this.artifacts.importFile(partialPath, chunk.originalName, chunk.mediaType)
      if (artifact.sha256 !== chunk.sha256 || artifact.sizeBytes !== chunk.sizeBytes) {
        throw new PeerArtifactError('HASH_MISMATCH', 'stored result artifact differs from declared content')
      }
      try {
        this.database.linkLeasedResultArtifact(this.localNodeId, peerNodeId, chunk.taskId, chunk.attemptId,
          chunk.leaseId, chunk.epoch, artifact, chunk.role)
      } catch {
        throw new PeerArtifactError('ARTIFACT_NOT_AUTHORIZED', 'result was not linked: attempt lease changed or role conflicts')
      }
      await unlink(partialPath)
      return { operation: 'artifact.result.chunk.accepted', offset, complete: true, sha256: chunk.sha256 }
    } finally { this.activeUploads.delete(key) }
  }

  async uploadLeasedResult(
    owner: DiscoveredPeer, reference: LeasedInputReference,
    role: LeasedResultChunk['role'], channel: PeerSecureChannel, signal?: AbortSignal,
  ): Promise<void> {
    const input = parseReference({ ...reference, offset: 0 })
    const artifact = this.database.getArtifact(input.sha256)
    if (!artifact || artifact.sizeBytes !== input.sizeBytes) throw new PeerArtifactError('ARTIFACT_NOT_FOUND', 'local result artifact is unavailable')
    const path = this.artifacts.resolveArtifact(input.sha256)
    const hash = createHash('sha256')
    for await (const part of createReadStream(path)) hash.update(part)
    if (hash.digest('hex') !== input.sha256) throw new PeerArtifactError('HASH_MISMATCH', 'local result artifact changed before upload')
    const handle = await open(path, 'r')
    try {
      if ((await handle.stat()).size !== input.sizeBytes) throw new PeerArtifactError('ARTIFACT_CHANGED', 'local result size changed')
      const connection = await channel.connect(owner)
      let offset = 0
      let renewedAt = 0
      while (true) {
        if (signal?.aborted) throw new PeerArtifactError('TRANSFER_CANCELLED', 'result upload was stopped')
        if (Date.now() - renewedAt > 20_000) {
          await PeerLeaseControl.renewOnOwner(owner, channel, input.leaseId, input.epoch)
          renewedAt = Date.now()
        }
        const size = Math.min(PEER_ARTIFACT_CHUNK_BYTES, input.sizeBytes - offset)
        const bytes = Buffer.alloc(size)
        const { bytesRead } = await handle.read(bytes, 0, size, offset)
        if (bytesRead !== size) throw new PeerArtifactError('ARTIFACT_CHANGED', 'local result was truncated during upload')
        const response = await channel.request(owner, connection.sessionId, {
          operation: 'artifact.result.chunk', ...input, role, offset, data: bytes.toString('base64url'),
          eof: offset + size === input.sizeBytes, originalName: reference.originalName ?? artifact.originalName,
          mediaType: reference.mediaType ?? artifact.mediaType,
        })
        if (!isObject(response) || response.operation !== 'artifact.result.chunk.accepted' ||
          response.sha256 !== input.sha256 || !Number.isSafeInteger(response.offset) ||
          Number(response.offset) < offset + size || Number(response.offset) > input.sizeBytes ||
          typeof response.complete !== 'boolean') {
          throw new PeerArtifactError('INVALID_ACK', 'owner returned an inconsistent result upload acknowledgement')
        }
        offset = Number(response.offset)
        if (response.complete && offset === input.sizeBytes) return
        if (offset === input.sizeBytes) throw new PeerArtifactError('INVALID_ACK', 'owner did not commit the complete result artifact')
      }
    } finally { await handle.close() }
  }

  private assertResultLease(peerNodeId: string, reference: LeasedInputReference): void {
    const task = this.database.getTask(reference.taskId)
    const attempt = this.database.getAttempt(reference.attemptId)
    const run = attempt ? this.database.getRun(attempt.runId) : null
    if (!task || task.ownerNodeId !== this.localNodeId || !run || run.taskId !== task.id ||
      attempt?.executorNodeId !== peerNodeId || !['QUEUED', 'STARTING', 'RUNNING'].includes(attempt.status) ||
      this.database.listTaskRuns(task.id).at(-1)?.id !== run.id ||
      this.database.listRunAttempts(run.id).at(-1)?.id !== attempt.id ||
      !this.database.isCurrentLease(reference.leaseId, task.id, peerNodeId, reference.epoch)) {
      throw new PeerArtifactError('ARTIFACT_NOT_AUTHORIZED', 'result artifact is not authorized by the current attempt lease')
    }
  }

  async downloadLeasedInput(
    owner: DiscoveredPeer, reference: LeasedInputReference, channel: PeerSecureChannel, signal?: AbortSignal,
  ): Promise<ArtifactRecord> {
    const input = parseReference({ ...reference, offset: 0 })
    if (this.activeDownloads.has(input.sha256)) throw new PeerArtifactError('TRANSFER_BUSY', 'this artifact is already downloading')
    this.activeDownloads.add(input.sha256)
    try {
      const partialRoot = join(this.artifacts.root, 'tmp', 'peer-downloads')
      await mkdir(partialRoot, { recursive: true })
      const partialPath = join(partialRoot, `${input.sha256}.part`)
      const created = await open(partialPath, 'a')
      await created.close()
      let offset = (await stat(partialPath)).size
      if (offset > input.sizeBytes) throw new PeerArtifactError('INVALID_PARTIAL', 'partial artifact exceeds expected size')
      const connection = await channel.connect(owner)
      while (offset < input.sizeBytes) {
        if (signal?.aborted) throw new PeerArtifactError('TRANSFER_CANCELLED', 'input transfer was stopped before completion')
        const response = await channel.request(owner, connection.sessionId, { operation: 'artifact.input.chunk', ...input, offset })
        const chunk = parseChunk(response)
        if (chunk.sha256 !== input.sha256 || chunk.sizeBytes !== input.sizeBytes || chunk.offset !== offset ||
          chunk.data.byteLength < 1 || chunk.data.byteLength > PEER_ARTIFACT_CHUNK_BYTES ||
          offset + chunk.data.byteLength > input.sizeBytes || chunk.eof !== (offset + chunk.data.byteLength === input.sizeBytes)) {
          throw new PeerArtifactError('INVALID_CHUNK', 'peer returned an inconsistent input chunk')
        }
        await appendFile(partialPath, chunk.data)
        offset += chunk.data.byteLength
      }
      if (signal?.aborted) throw new PeerArtifactError('TRANSFER_CANCELLED', 'input transfer was stopped before completion')
      if (offset === input.sizeBytes) {
        const response = await channel.request(owner, connection.sessionId, { operation: 'artifact.input.chunk', ...input, offset })
        const finalChunk = parseChunk(response)
        if (finalChunk.sha256 !== input.sha256 || finalChunk.sizeBytes !== input.sizeBytes ||
          finalChunk.offset !== offset || finalChunk.data.byteLength !== 0 || !finalChunk.eof) {
          throw new PeerArtifactError('INVALID_CHUNK', 'peer did not confirm the complete input artifact')
        }
      }
      if (offset !== input.sizeBytes) throw new PeerArtifactError('INVALID_PARTIAL', 'input artifact transfer is incomplete')
      if (signal?.aborted) throw new PeerArtifactError('TRANSFER_CANCELLED', 'input transfer was stopped before completion')
      const hash = createHash('sha256')
      for await (const part of createReadStream(partialPath)) hash.update(part)
      if (hash.digest('hex') !== input.sha256) {
        await unlink(partialPath)
        throw new PeerArtifactError('HASH_MISMATCH', 'downloaded input artifact hash does not match')
      }
      const record = await this.artifacts.importFile(partialPath, reference.originalName ?? 'input.aedt', reference.mediaType ?? 'application/octet-stream')
      if (record.sha256 !== input.sha256) throw new PeerArtifactError('HASH_MISMATCH', 'stored input artifact hash does not match')
      this.database.upsertArtifact(record)
      await unlink(partialPath)
      return record
    } finally { this.activeDownloads.delete(input.sha256) }
  }
}

interface ParsedReference extends LeasedInputReference { offset: number }
function parseReference(value: unknown): ParsedReference {
  if (!isObject(value) || typeof value.taskId !== 'string' || value.taskId.length > 80 ||
    typeof value.attemptId !== 'string' || value.attemptId.length > 80 ||
    typeof value.leaseId !== 'string' || value.leaseId.length > 80 ||
    !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1 ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.sizeBytes) || Number(value.sizeBytes) < 0 ||
    !Number.isSafeInteger(value.offset) || Number(value.offset) < 0) {
    throw new PeerArtifactError('INVALID_REFERENCE', 'leased input reference is invalid')
  }
  return {
    taskId: value.taskId, attemptId: value.attemptId, leaseId: value.leaseId,
    epoch: Number(value.epoch), sha256: value.sha256,
    sizeBytes: Number(value.sizeBytes), offset: Number(value.offset),
  }
}

function parseChunk(value: unknown): Omit<InputChunk, 'data'> & { data: Buffer } {
  if (!isObject(value) || value.operation !== 'artifact.input.chunk.result' ||
    typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !Number.isSafeInteger(value.sizeBytes) || !Number.isSafeInteger(value.offset) ||
    typeof value.data !== 'string' || value.data.length > 180_000 ||
    typeof value.eof !== 'boolean' || typeof value.originalName !== 'string' || typeof value.mediaType !== 'string') {
    throw new PeerArtifactError('INVALID_CHUNK', 'peer returned an invalid input chunk')
  }
  const data = Buffer.from(value.data, 'base64url')
  return { operation: 'artifact.input.chunk.result', sha256: value.sha256, sizeBytes: Number(value.sizeBytes),
    offset: Number(value.offset), data, eof: value.eof, originalName: value.originalName, mediaType: value.mediaType }
}
function parseResultChunk(value: unknown): Omit<LeasedResultChunk, 'data'> & { data: Buffer } {
  const reference = parseReference(value)
  if (!isObject(value) || value.operation !== 'artifact.result.chunk' ||
    !['SOLVED_PROJECT', 'SOLVER_RESULT', 'CONVERGENCE_EVIDENCE', 'LOG'].includes(String(value.role)) ||
    typeof value.data !== 'string' || value.data.length > 180_000 ||
    typeof value.eof !== 'boolean' || typeof value.originalName !== 'string' ||
    value.originalName.length < 1 || value.originalName.length > 255 || value.originalName.includes('\0') ||
    typeof value.mediaType !== 'string' || value.mediaType.length > 200 ||
    !/^[a-zA-Z0-9-]{1,80}$/u.test(reference.attemptId) ||
    reference.sizeBytes > 100 * 1024 * 1024 * 1024) {
    throw new PeerArtifactError('INVALID_CHUNK', 'result chunk metadata is invalid')
  }
  const data = Buffer.from(value.data, 'base64url')
  if (data.byteLength > PEER_ARTIFACT_CHUNK_BYTES || reference.offset + data.byteLength > reference.sizeBytes ||
    value.eof !== (reference.offset + data.byteLength === reference.sizeBytes) ||
    (!value.eof && data.byteLength === 0)) {
    throw new PeerArtifactError('INVALID_CHUNK', 'result chunk size or completion flag is invalid')
  }
  return { ...reference, operation: 'artifact.result.chunk', role: value.role as LeasedResultChunk['role'],
    data, eof: value.eof, originalName: value.originalName, mediaType: value.mediaType }
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
