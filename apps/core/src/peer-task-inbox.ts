import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { IcepakEnvironmentProbe, RemoteJobRecord } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import type { IcepakPluginPort } from './icepak-plugin-client.js'
import { PeerSecureChannel } from './peer-secure-channel.js'
import type { DiscoveredPeer } from './peer-discovery.js'

export interface PeerTaskOffer {
  operation: 'task.baseline.offer'
  taskId: string
  runId: string
  attemptId: string
  ownerNodeId: string
  executorNodeId: string
  leaseId: string
  epoch: number
  leaseExpiresAt: string
  inputSha256: string
  inputSizeBytes: number
  inputOriginalName: string
  parameters: Record<string, unknown>
}

export class PeerTaskError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

// The download, content-addressed import, working copy and solver outputs can
// coexist. This is a conservative admission estimate, not a disk reservation.
const DISK_HEADROOM_BYTES = 512n * 1024n * 1024n
const INPUT_DISK_MULTIPLIER = 4n

export class PeerTaskInbox {
  constructor(
    private readonly localNodeId: string,
    private readonly database: LocalDatabase,
    private readonly plugin: IcepakPluginPort,
    private readonly onAccepted?: () => void,
    private readonly readinessProbe?: () => Promise<IcepakEnvironmentProbe>,
  ) {}

  async receive(peerNodeId: string, value: unknown): Promise<{ operation: 'task.baseline.accepted'; attemptId: string; status: RemoteJobRecord['status'] }> {
    const offer = parseOffer(value)
    const peer = this.database.getPeer(peerNodeId)
    if (!this.database.remoteExecutionEnabled() || !peer || peer.trustStatus !== 'TRUSTED' ||
      offer.ownerNodeId !== peerNodeId || offer.executorNodeId !== this.localNodeId) {
      throw new PeerTaskError('OFFER_NOT_AUTHORIZED', 'remote execution is disabled or owner identity does not match')
    }
    if (Date.parse(offer.leaseExpiresAt) <= Date.now() + 5_000) {
      throw new PeerTaskError('OFFER_EXPIRED', 'task offer lease is expired or nearly expired')
    }
    const existing = this.database.getRemoteJob(offer.attemptId)
    if (!existing) {
      if (this.database.listRemoteJobs().some(job => ['OFFERED', 'TRANSFERRING', 'INPUT_READY', 'RUNNING', 'SYNCING_RESULTS'].includes(job.status))) {
        throw new PeerTaskError('EXECUTOR_BUSY', 'executor already has a remote job')
      }
      const probe = await (this.readinessProbe?.() ?? this.plugin.probeEnvironment())
      if (probe.platform !== 'win32' || probe.status !== 'READY' || probe.licenseStatus !== 'AVAILABLE' ||
        !probe.capabilities.includes('baseline_solve') ||
        typeof offer.parameters.version !== 'string' || !probe.aedtVersions.includes(offer.parameters.version)) {
        throw new PeerTaskError('ICEPAK_NOT_READY', 'Icepak is not ready for this baseline offer')
      }
      let capacity
      try { capacity = await statfs(dirname(this.database.path), { bigint: true }) }
      catch { throw new PeerTaskError('DISK_CAPACITY_UNKNOWN', 'executor disk capacity cannot be checked') }
      const available = capacity.bavail * capacity.bsize
      const required = BigInt(offer.inputSizeBytes) * INPUT_DISK_MULTIPLIER + DISK_HEADROOM_BYTES
      if (available < required) {
        throw new PeerTaskError('INSUFFICIENT_DISK', `executor needs at least ${required} free bytes for this input; ${available} available`)
      }
    }
    const job = this.database.acceptRemoteJob({
      attemptId: offer.attemptId, taskId: offer.taskId, runId: offer.runId,
      ownerNodeId: offer.ownerNodeId, executorNodeId: offer.executorNodeId,
      leaseId: offer.leaseId, epoch: offer.epoch,
      inputSha256: offer.inputSha256, inputSizeBytes: offer.inputSizeBytes,
      inputOriginalName: offer.inputOriginalName, parameters: offer.parameters,
    })
    this.onAccepted?.()
    return { operation: 'task.baseline.accepted', attemptId: job.attemptId, status: job.status }
  }

  static async send(ownerChannel: PeerSecureChannel, executor: DiscoveredPeer, offer: PeerTaskOffer): Promise<void> {
    const { sessionId } = await ownerChannel.connect(executor)
    const response = await ownerChannel.request(executor, sessionId, offer)
    if (!isObject(response) || response.operation !== 'task.baseline.accepted' ||
      response.attemptId !== offer.attemptId ||
      !['OFFERED', 'TRANSFERRING', 'INPUT_READY', 'RUNNING', 'SYNCING_RESULTS', 'COMPLETED'].includes(String(response.status))) {
      throw new PeerTaskError('INVALID_OFFER_RESPONSE', 'executor did not accept the baseline offer')
    }
  }
}

function parseOffer(value: unknown): PeerTaskOffer {
  if (!isObject(value) || value.operation !== 'task.baseline.offer' ||
    !isId(value.taskId) || !isId(value.runId) || !isId(value.attemptId) || !isId(value.leaseId) ||
    !isNodeId(value.ownerNodeId) || !isNodeId(value.executorNodeId) ||
    !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1 ||
    typeof value.leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(value.leaseExpiresAt)) ||
    typeof value.inputSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.inputSha256) ||
    !Number.isSafeInteger(value.inputSizeBytes) || Number(value.inputSizeBytes) < 1 ||
    typeof value.inputOriginalName !== 'string' || value.inputOriginalName.length > 255 ||
    !/^[^/\\]+\.aedt$/iu.test(value.inputOriginalName) ||
    !isObject(value.parameters) || !validParameters(value.parameters)) {
    throw new PeerTaskError('INVALID_OFFER', 'baseline task offer is invalid')
  }
  return value as unknown as PeerTaskOffer
}

function validParameters(value: Record<string, unknown>): boolean {
  const allowed = new Set(['version', 'design', 'setup', 'cores', 'nonGraphical', 'flowConvergenceCriterion'])
  if (Object.keys(value).some(key => !allowed.has(key))) return false
  if (typeof value.version !== 'string' || !/^20\d{2}\.[1-9]$/u.test(value.version)) return false
  if (value.design !== undefined && (typeof value.design !== 'string' || value.design.length > 100)) return false
  if (value.setup !== undefined && (typeof value.setup !== 'string' || value.setup.length > 100)) return false
  if (value.cores !== undefined && (!Number.isInteger(value.cores) || Number(value.cores) < 1 || Number(value.cores) > 64)) return false
  if (value.nonGraphical !== undefined && value.nonGraphical !== true) return false
  if (value.flowConvergenceCriterion !== undefined && (typeof value.flowConvergenceCriterion !== 'number' ||
    !Number.isFinite(value.flowConvergenceCriterion) || value.flowConvergenceCriterion <= 0 || value.flowConvergenceCriterion > 1)) return false
  return true
}

function isId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9-]{36}$/iu.test(value) }
function isNodeId(value: unknown): value is string { return typeof value === 'string' && /^node-[a-f0-9]{32}$/u.test(value) }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
