import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import { PeerSecureChannel } from './peer-secure-channel.js'
import type { DiscoveredPeer } from './peer-discovery.js'

const RENEW_TTL_MS = 60_000

export interface PeerLeaseRenewal {
  operation: 'lease.renewed'
  leaseId: string
  epoch: number
  expiresAt: string
  ttlMs: number
}

export class PeerLeaseError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class PeerLeaseControl {
  constructor(private readonly localNodeId: string, private readonly database: LocalDatabase) {}

  renewForExecutor(peerNodeId: string, value: unknown): PeerLeaseRenewal {
    if (!isObject(value) || typeof value.leaseId !== 'string' || value.leaseId.length > 80 ||
      !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1) {
      throw new PeerLeaseError('INVALID_LEASE_REQUEST', 'lease renewal request is invalid')
    }
    const lease = this.database.getLease(value.leaseId)
    const task = lease ? this.database.getTask(lease.taskId) : null
    const run = task ? this.database.listTaskRuns(task.id).at(-1) : null
    const attempt = run ? this.database.listRunAttempts(run.id).at(-1) : null
    if (!lease || !task || task.ownerNodeId !== this.localNodeId ||
      lease.executorNodeId !== peerNodeId || lease.epoch !== Number(value.epoch) ||
      attempt?.executorNodeId !== peerNodeId || !['QUEUED', 'STARTING', 'RUNNING'].includes(attempt.status) ||
      !this.database.isCurrentLease(lease.id, task.id, peerNodeId, lease.epoch)) {
      throw new PeerLeaseError('LEASE_NOT_AUTHORIZED', 'peer does not hold the current task lease')
    }
    try {
      const renewed = this.database.renewLease(lease.id, peerNodeId, lease.epoch, RENEW_TTL_MS)
      return { operation: 'lease.renewed', leaseId: renewed.id, epoch: renewed.epoch,
        expiresAt: renewed.expiresAt, ttlMs: RENEW_TTL_MS }
    } catch {
      throw new PeerLeaseError('LEASE_NOT_AUTHORIZED', 'task lease cannot be renewed')
    }
  }

  static async renewOnOwner(owner: DiscoveredPeer, channel: PeerSecureChannel, leaseId: string, epoch: number): Promise<PeerLeaseRenewal> {
    const { sessionId } = await channel.connect(owner)
    const value = await channel.request(owner, sessionId, { operation: 'lease.renew', leaseId, epoch })
    if (!isObject(value) || value.operation !== 'lease.renewed' || value.leaseId !== leaseId ||
      value.epoch !== epoch || !Number.isSafeInteger(value.ttlMs) || value.ttlMs !== RENEW_TTL_MS ||
      typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) {
      throw new PeerLeaseError('INVALID_LEASE_RESPONSE', 'owner returned an invalid lease renewal')
    }
    return value as unknown as PeerLeaseRenewal
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
