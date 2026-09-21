import type { RemoteJobRecord } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import { PeerArtifactError, PeerArtifactTransfer } from './peer-artifact-transfer.js'
import type { PeerDiscovery, DiscoveredPeer } from './peer-discovery.js'
import { PeerLeaseControl } from './peer-lease-control.js'
import { PeerSecureChannel } from './peer-secure-channel.js'

const RENEW_INTERVAL_MS = 20_000
const RETRY_DELAY_MS = 10_000

export class PeerRemoteInputProcessor {
  private timer?: NodeJS.Timeout
  private active?: Promise<void>
  private controller?: AbortController
  private stopped = false
  private readonly retryAfter = new Map<string, number>()

  constructor(
    private readonly database: LocalDatabase,
    private readonly discovery: PeerDiscovery,
    private readonly channel: PeerSecureChannel,
    private readonly artifacts: PeerArtifactTransfer,
    private readonly onReady?: () => void,
  ) {}

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => this.wake(), 5_000)
    this.timer.unref()
    this.wake()
  }

  wake(force = false): void {
    if (force) this.retryAfter.clear()
    if (this.stopped || this.active) return
    const job = this.database.listRemoteJobs().find(item =>
      ['OFFERED', 'TRANSFERRING'].includes(item.status) &&
      (this.retryAfter.get(item.attemptId) ?? 0) <= Date.now())
    if (!job) return
    const owner = this.ownerPeer(job.ownerNodeId)
    if (!owner) return
    const controller = new AbortController()
    this.controller = controller
    this.active = this.process(job, owner, controller).finally(() => {
      this.active = undefined
      this.controller = undefined
      this.wake()
    })
  }

  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.controller?.abort()
    await this.active
  }

  private ownerPeer(nodeId: string): DiscoveredPeer | undefined {
    return this.discovery.status().discovered.find(peer => peer.trusted && peer.identity.nodeId === nodeId)
  }

  private async process(job: RemoteJobRecord, owner: DiscoveredPeer, controller: AbortController): Promise<void> {
    let renewalTimer: NodeJS.Timeout | undefined
    let renewalError: Error | undefined
    let renewing = false
    try {
      await PeerLeaseControl.renewOnOwner(owner, this.channel, job.leaseId, job.epoch)
      const current = this.database.getRemoteJob(job.attemptId)
      if (!current || current.leaseId !== job.leaseId || current.epoch !== job.epoch ||
        !['OFFERED', 'TRANSFERRING'].includes(current.status)) return
      if (current.status === 'OFFERED') {
        this.database.transitionRemoteJob(job.attemptId, job.leaseId, job.epoch, 'OFFERED', 'TRANSFERRING')
      }
      renewalTimer = setInterval(() => {
        if (renewing || controller.signal.aborted) return
        renewing = true
        void (async () => {
          try {
            const freshOwner = this.ownerPeer(job.ownerNodeId)
            if (!freshOwner) throw new Error('trusted Owner is no longer freshly discovered')
            await PeerLeaseControl.renewOnOwner(freshOwner, this.channel, job.leaseId, job.epoch)
          } catch (error) {
            renewalError = error instanceof Error ? error : new Error('lease renewal failed')
            controller.abort()
          } finally { renewing = false }
        })()
      }, RENEW_INTERVAL_MS)
      renewalTimer.unref()
      const artifact = await this.artifacts.downloadLeasedInput(owner, {
        taskId: job.taskId, attemptId: job.attemptId, leaseId: job.leaseId, epoch: job.epoch,
        sha256: job.inputSha256, sizeBytes: job.inputSizeBytes, originalName: job.inputOriginalName,
      }, this.channel, controller.signal)
      if (controller.signal.aborted) throw renewalError ?? new PeerArtifactError('TRANSFER_CANCELLED', 'input transfer was stopped')
      if (artifact.sha256 !== job.inputSha256) throw new PeerArtifactError('HASH_MISMATCH', 'stored input SHA does not match the offer')
      this.database.transitionRemoteJob(job.attemptId, job.leaseId, job.epoch, 'TRANSFERRING', 'INPUT_READY')
      this.onReady?.()
      this.retryAfter.delete(job.attemptId)
    } catch (error) {
      const cause = renewalError ?? (error instanceof Error ? error : new Error('remote input transfer failed'))
      const current = this.database.getRemoteJob(job.attemptId)
      if (!current || current.leaseId !== job.leaseId || current.epoch !== job.epoch ||
        !['OFFERED', 'TRANSFERRING'].includes(current.status)) return
      const code = cause instanceof PeerArtifactError ? cause.code : 'REMOTE_INPUT_UNAVAILABLE'
      const permanent = ['HASH_MISMATCH', 'INVALID_CHUNK', 'INVALID_REFERENCE', 'INVALID_PARTIAL'].includes(code)
      try {
        if (permanent) {
          this.database.transitionRemoteJob(job.attemptId, job.leaseId, job.epoch, current.status, 'FAILED',
            { code, message: cause.message })
        } else {
          this.database.recordRemoteJobError(job.attemptId, job.leaseId, job.epoch, code, cause.message)
          this.retryAfter.set(job.attemptId, Date.now() + RETRY_DELAY_MS)
        }
      } catch { /* a newer lease or terminal status won the race */ }
    } finally {
      if (renewalTimer) clearInterval(renewalTimer)
    }
  }
}
