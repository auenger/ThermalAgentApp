import type { AutoDispatchRecord } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import type { PeerDiscovery } from './peer-discovery.js'
import { PeerDispatchError, PeerTaskDispatcher } from './peer-task-dispatcher.js'
import { hasAdvertisedDiskCapacity } from './peer-disk-capacity.js'

export class PeerAutoDispatcher {
  private timer?: NodeJS.Timeout
  private active?: Promise<void>
  private stopped = true
  private readonly retryAfter = new Map<string, number>()

  constructor(
    private readonly localNodeId: string,
    private readonly database: LocalDatabase,
    private readonly discovery: PeerDiscovery,
    private readonly dispatcher: PeerTaskDispatcher,
  ) {}

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => this.wake(), 5_000)
    this.timer.unref()
    this.wake()
  }

  wake(): void {
    if (this.stopped || this.active) return
    const intent = this.database.listAutoDispatches().find(item => item.status === 'WAITING' &&
      (this.retryAfter.get(item.taskId) ?? 0) <= Date.now())
    if (!intent) return
    this.active = this.process(intent).finally(() => {
      this.active = undefined
      this.wake()
    })
  }

  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.active
  }

  private async process(intent: AutoDispatchRecord): Promise<void> {
    const task = this.database.getTask(intent.taskId)
    if (!task || task.ownerNodeId !== this.localNodeId) {
      try { this.database.failAutoDispatch(intent.taskId, 'OWNER_CHANGED', 'task is no longer owned by this node') } catch { /* concurrent update */ }
      return
    }
    const run = this.database.listTaskRuns(task.id).at(-1)
    const latest = run ? this.database.listRunAttempts(run.id).at(-1) : null
    if (run && latest?.inputArtifactSha256 === intent.inputSha256 &&
      ['RUNNING', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'ESCALATED'].includes(task.executionStatus)) {
      try { this.database.recordAutoDispatchDelivery(task.id, latest.executorNodeId, true) } catch { /* concurrent update */ }
      if (this.database.getAutoDispatch(task.id)?.status === 'WAITING') this.retryAfter.set(task.id, Date.now() + 10_000)
      return
    }
    let peerNodeId: string | null = null
    try {
      const inputSizeBytes = this.database.getArtifact(intent.inputSha256)?.sizeBytes
      if (!inputSizeBytes) {
        this.database.failAutoDispatch(task.id, 'INPUT_NOT_FOUND', 'snapshotted input artifact metadata is missing')
        return
      }
      if (task.executionStatus === 'READY' && !run) {
        const version = typeof intent.parameters.version === 'string' ? intent.parameters.version : undefined
        const available = this.database.listAvailablePeers(version)
        const discovered = this.discovery.status().discovered
        const peer = available.map(item => discovered.find(candidate =>
          candidate.trusted && candidate.identity.nodeId === item.nodeId &&
          candidate.heartbeat.pluginStatus === 'READY' &&
          candidate.heartbeat.activeAttempts < candidate.heartbeat.maxConcurrent &&
          hasAdvertisedDiskCapacity(candidate.heartbeat.freeDiskBytes, inputSizeBytes) &&
          (!version || candidate.heartbeat.aedtVersions.includes(version))))
          .find(item => item !== undefined)
        if (!peer) { this.retryAfter.set(task.id, Date.now() + 5_000); return }
        peerNodeId = peer.identity.nodeId
        const result = await this.dispatcher.dispatchQueuedAutomaticBaseline(intent, peer)
        this.database.recordAutoDispatchDelivery(task.id, peerNodeId, result.delivered, result.deliveryError)
      } else if (run?.kind === 'BASELINE' && run.status === 'PLANNED' && latest?.status === 'QUEUED' &&
        ['QUEUED', 'LEASED'].includes(task.executionStatus) && latest.inputArtifactSha256 === intent.inputSha256) {
        peerNodeId = latest.executorNodeId
        const version = typeof intent.parameters.version === 'string' ? intent.parameters.version : undefined
        const available = this.database.listAvailablePeers(version)
        const discovered = this.discovery.status().discovered
        const original = discovered.find(item => item.trusted && item.identity.nodeId === peerNodeId)
        const originalReady = original && available.some(item => item.nodeId === peerNodeId) &&
          hasAdvertisedDiskCapacity(original.heartbeat.freeDiskBytes, inputSizeBytes)
        let result
        if (task.executionStatus === 'QUEUED' && !originalReady) {
          if (this.database.listRunAttempts(run.id).length >= 3) {
            this.database.exhaustQueuedAutoDispatch(task.id, this.localNodeId)
            return
          }
          const alternate = available.map(item => discovered.find(candidate =>
            candidate.trusted && candidate.identity.nodeId === item.nodeId && item.nodeId !== peerNodeId &&
            candidate.heartbeat.pluginStatus === 'READY' &&
            candidate.heartbeat.activeAttempts < candidate.heartbeat.maxConcurrent &&
            hasAdvertisedDiskCapacity(candidate.heartbeat.freeDiskBytes, inputSizeBytes) &&
            (!version || candidate.heartbeat.aedtVersions.includes(version)))).find(item => item !== undefined)
          if (!alternate) { this.retryAfter.set(task.id, Date.now() + 5_000); return }
          peerNodeId = alternate.identity.nodeId
          result = await this.dispatcher.reassignQueuedAutomaticBaseline(intent, alternate)
        } else {
          if (!original) { this.retryAfter.set(task.id, Date.now() + 5_000); return }
          result = await this.dispatcher.retryOffer(task.id, original, task.version)
        }
        this.database.recordAutoDispatchDelivery(task.id, peerNodeId, result.delivered, result.deliveryError)
      } else {
        this.database.failAutoDispatch(task.id, 'AUTO_DISPATCH_CONFLICT', 'task state no longer matches automatic Baseline dispatch')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'automatic dispatch failed'
      const current = this.database.getAutoDispatch(task.id)
      if (current?.status !== 'WAITING') return
      if (error instanceof PeerDispatchError && ['INVALID_INPUT', 'INVALID_PARAMETERS', 'INPUT_NOT_CONFIRMED', 'INPUT_NOT_FOUND', 'INPUT_CHANGED'].includes(error.code)) {
        try { this.database.failAutoDispatch(task.id, error.code, message) } catch { /* concurrent update */ }
      } else {
        this.retryAfter.set(task.id, Date.now() + 10_000)
      }
    } finally {
      if (peerNodeId && this.database.getAutoDispatch(task.id)?.status === 'WAITING') {
        this.retryAfter.set(task.id, Date.now() + 10_000)
      }
    }
  }
}
