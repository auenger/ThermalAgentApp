import { basename, resolve } from 'node:path'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import type { AttemptRecord, AutoDispatchRecord, IcepakProjectOperationInput, LeaseRecord, RunRecord, TaskRecord } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import type { DiscoveredPeer } from './peer-discovery.js'
import { PeerSecureChannel } from './peer-secure-channel.js'
import { PeerTaskInbox, type PeerTaskOffer } from './peer-task-inbox.js'
import { hasAdvertisedDiskCapacity } from './peer-disk-capacity.js'

export interface PeerDispatchResult {
  task: TaskRecord
  run: RunRecord
  attempt: AttemptRecord
  lease: LeaseRecord | null
  delivered: boolean
  deliveryError?: string
}

export class PeerDispatchError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class PeerTaskDispatcher {
  private readonly pending = new Set<string>()

  constructor(
    private readonly localNodeId: string,
    private readonly database: LocalDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly channel: PeerSecureChannel,
  ) {}

  async dispatchBaseline(
    taskId: string, executor: DiscoveredPeer, expectedVersion: number, input: IcepakProjectOperationInput,
  ): Promise<PeerDispatchResult> {
    if (this.pending.has(taskId)) throw new PeerDispatchError('DISPATCH_BUSY', 'this task is already being dispatched')
    this.pending.add(taskId)
    try {
      const task = this.database.getTask(taskId)
      if (!task || task.ownerNodeId !== this.localNodeId || task.executionStatus !== 'READY' ||
        task.version !== expectedVersion || this.database.listTaskRuns(taskId).length > 0) {
        throw new PeerDispatchError('TASK_NOT_DISPATCHABLE', 'task must be an owned READY task without an existing Run')
      }
      if (this.database.getAutoDispatch(taskId)?.status === 'WAITING') {
        throw new PeerDispatchError('AUTO_DISPATCH_PENDING', 'cancel automatic dispatch before choosing an executor manually')
      }
      if (typeof task.requirementSnapshot.projectPath !== 'string' ||
        resolve(task.requirementSnapshot.projectPath) !== resolve(input.projectPath)) {
        throw new PeerDispatchError('INPUT_NOT_CONFIRMED', 'remote project path differs from the confirmed task requirement')
      }
      this.assertExecutor(executor, task)
      const parameters = normalizeParameters(input, task, executor)
      const artifact = await this.artifacts.importFile(input.projectPath)
      if (artifact.sizeBytes < 1 || !/\.aedt$/iu.test(artifact.originalName)) {
        throw new PeerDispatchError('INVALID_INPUT', 'remote baseline requires a non-empty .aedt project')
      }
      this.assertExecutorDisk(executor, artifact.sizeBytes)
      const inspection = task.requirementSnapshot.inspection
      if (isObject(inspection) && typeof inspection.inputSha256 === 'string' &&
        inspection.inputSha256 !== artifact.sha256) {
        throw new PeerDispatchError('INPUT_CHANGED', 'project bytes differ from the confirmed inspection')
      }
      this.database.upsertArtifact(artifact)
      const prepared = this.database.prepareRemoteBaseline(taskId, this.localNodeId, executor.identity.nodeId,
        expectedVersion, artifact.sha256, parameters, '0.2.0')
      return this.sendPrepared(prepared.task, prepared.run, prepared.attempt, executor)
    } finally { this.pending.delete(taskId) }
  }

  async queueAutomaticBaseline(taskId: string, expectedVersion: number,
    input: IcepakProjectOperationInput): Promise<AutoDispatchRecord> {
    const task = this.database.getTask(taskId)
    if (!task || task.ownerNodeId !== this.localNodeId || task.executionStatus !== 'READY' ||
      task.version !== expectedVersion || this.database.listTaskRuns(taskId).length > 0) {
      throw new PeerDispatchError('TASK_NOT_DISPATCHABLE', 'task must be an owned READY task without a Run')
    }
    if (typeof task.requirementSnapshot.projectPath !== 'string' ||
      resolve(task.requirementSnapshot.projectPath) !== resolve(input.projectPath)) {
      throw new PeerDispatchError('INPUT_NOT_CONFIRMED', 'project path differs from the confirmed requirement')
    }
    const version = baselineVersion(input, task)
    const artifact = await this.artifacts.importFile(input.projectPath)
    if (artifact.sizeBytes < 1 || !/\.aedt$/iu.test(artifact.originalName)) {
      throw new PeerDispatchError('INVALID_INPUT', 'remote Baseline requires a non-empty .aedt project')
    }
    const inspection = task.requirementSnapshot.inspection
    if (isObject(inspection) && typeof inspection.inputSha256 === 'string' && inspection.inputSha256 !== artifact.sha256) {
      throw new PeerDispatchError('INPUT_CHANGED', 'project bytes differ from the confirmed inspection')
    }
    this.database.upsertArtifact(artifact)
    return this.database.enqueueAutoDispatch(taskId, this.localNodeId, expectedVersion, artifact.sha256, {
      version,
      ...(input.design ? { design: input.design } : {}),
      ...(input.setup ? { setup: input.setup } : {}),
      ...(input.cores ? { cores: input.cores } : {}),
      nonGraphical: true,
      ...(input.flowConvergenceCriterion ? { flowConvergenceCriterion: input.flowConvergenceCriterion } : {}),
    })
  }

  async dispatchQueuedAutomaticBaseline(intent: AutoDispatchRecord, executor: DiscoveredPeer): Promise<PeerDispatchResult> {
    if (this.pending.has(intent.taskId)) throw new PeerDispatchError('DISPATCH_BUSY', 'this task is already being dispatched')
    this.pending.add(intent.taskId)
    try {
      const task = this.database.getTask(intent.taskId)
      if (!task || task.ownerNodeId !== this.localNodeId || task.executionStatus !== 'READY' ||
        this.database.listTaskRuns(task.id).length > 0 ||
        this.database.getAutoDispatch(task.id)?.status !== 'WAITING') {
        throw new PeerDispatchError('TASK_NOT_DISPATCHABLE', 'automatic Baseline request is no longer waiting')
      }
      const artifact = this.database.getArtifact(intent.inputSha256)
      if (!artifact || artifact.sizeBytes < 1 || !/\.aedt$/iu.test(artifact.originalName)) {
        throw new PeerDispatchError('INPUT_NOT_FOUND', 'snapshotted .aedt input is unavailable')
      }
      this.assertExecutor(executor, task)
      this.assertExecutorDisk(executor, artifact.sizeBytes)
      const projectPath = task.requirementSnapshot.projectPath
      if (typeof projectPath !== 'string') throw new PeerDispatchError('INPUT_NOT_CONFIRMED', 'confirmed project path is missing')
      const parameters = normalizeParameters({ ...intent.parameters, projectPath } as IcepakProjectOperationInput, task, executor)
      const prepared = this.database.prepareRemoteBaseline(task.id, this.localNodeId, executor.identity.nodeId,
        task.version, artifact.sha256, parameters, '0.2.0')
      return this.sendPrepared(prepared.task, prepared.run, prepared.attempt, executor)
    } finally { this.pending.delete(intent.taskId) }
  }

  async reassignQueuedAutomaticBaseline(intent: AutoDispatchRecord, executor: DiscoveredPeer): Promise<PeerDispatchResult> {
    if (this.pending.has(intent.taskId)) throw new PeerDispatchError('DISPATCH_BUSY', 'this task is already being dispatched')
    this.pending.add(intent.taskId)
    try {
      const task = this.database.getTask(intent.taskId)
      if (!task || task.ownerNodeId !== this.localNodeId || task.executionStatus !== 'QUEUED' ||
        this.database.getAutoDispatch(task.id)?.status !== 'WAITING') {
        throw new PeerDispatchError('TASK_NOT_DISPATCHABLE', 'automatic Baseline request is no longer queued')
      }
      this.assertExecutor(executor, task)
      const artifact = this.database.getArtifact(intent.inputSha256)
      if (!artifact) throw new PeerDispatchError('INPUT_NOT_FOUND', 'snapshotted input artifact is unavailable')
      this.assertExecutorDisk(executor, artifact.sizeBytes)
      const reassigned = this.database.reassignQueuedRemoteBaseline(task.id, this.localNodeId,
        executor.identity.nodeId, task.version, intent.inputSha256)
      return this.sendPrepared(reassigned.task, reassigned.run, reassigned.attempt, executor)
    } finally { this.pending.delete(intent.taskId) }
  }

  async retryOffer(taskId: string, executor: DiscoveredPeer, expectedVersion: number): Promise<PeerDispatchResult> {
    if (this.pending.has(taskId)) throw new PeerDispatchError('DISPATCH_BUSY', 'this task is already being dispatched')
    this.pending.add(taskId)
    try {
      const task = this.database.getTask(taskId)
      const run = task ? this.database.listTaskRuns(taskId).at(-1) : null
      const attempt = run ? this.database.listRunAttempts(run.id).at(-1) : null
      if (!task || task.ownerNodeId !== this.localNodeId || task.version !== expectedVersion ||
        !['QUEUED', 'LEASED'].includes(task.executionStatus) || run?.kind !== 'BASELINE' ||
        run.status !== 'PLANNED' || attempt?.status !== 'QUEUED' ||
        attempt.executorNodeId !== executor.identity.nodeId || !attempt.inputArtifactSha256 ||
        !this.database.listAttemptArtifacts(attempt.id).some(link => link.role === 'INPUT_PROJECT' && link.sha256 === attempt.inputArtifactSha256)) {
        throw new PeerDispatchError('TASK_NOT_RETRYABLE', 'task has no matching prepared remote Baseline offer')
      }
      this.assertExecutor(executor, task, task.executionStatus === 'LEASED')
      return this.sendPrepared(task, run, attempt, executor)
    } finally { this.pending.delete(taskId) }
  }

  private async sendPrepared(
    task: TaskRecord, run: RunRecord, attempt: AttemptRecord, executor: DiscoveredPeer,
  ): Promise<PeerDispatchResult> {
    let lease: LeaseRecord | null = null
    try {
      const artifact = this.database.getArtifact(attempt.inputArtifactSha256 as string)
      if (!artifact) throw new PeerDispatchError('INPUT_NOT_FOUND', 'remote input artifact metadata is missing')
      this.assertExecutorDisk(executor, artifact.sizeBytes)
      if (task.executionStatus === 'QUEUED') {
        lease = this.database.claimQueuedTaskLease(task.id, executor.identity.nodeId, this.localNodeId, task.version, 60_000).lease
      } else {
        lease = this.database.listTaskLeases(task.id).at(-1) ?? null
        if (!lease || !this.database.isCurrentLease(lease.id, task.id, executor.identity.nodeId, lease.epoch)) {
          throw new PeerDispatchError('LEASE_NOT_CURRENT', 'remote task lease is not current')
        }
      }
      const offer: PeerTaskOffer = {
        operation: 'task.baseline.offer', taskId: task.id, runId: run.id, attemptId: attempt.id,
        ownerNodeId: this.localNodeId, executorNodeId: executor.identity.nodeId,
        leaseId: lease.id, epoch: lease.epoch, leaseExpiresAt: lease.expiresAt,
        inputSha256: artifact.sha256, inputSizeBytes: artifact.sizeBytes,
        inputOriginalName: artifact.originalName, parameters: attempt.parameters,
      }
      await PeerTaskInbox.send(this.channel, executor, offer)
      return { task: this.database.getTask(task.id) as TaskRecord, run, attempt, lease, delivered: true }
    } catch (error) {
      return { task: this.database.getTask(task.id) as TaskRecord, run, attempt, lease, delivered: false,
        deliveryError: error instanceof Error ? error.message : 'remote offer delivery failed' }
    }
  }

  private assertExecutor(executor: DiscoveredPeer, task: TaskRecord, alreadyLeased = false): void {
    const peer = this.database.getPeer(executor.identity.nodeId)
    if (!executor.trusted || !peer || peer.trustStatus !== 'TRUSTED' || peer.publicKey !== executor.identity.publicKey ||
      !Number.isFinite(Date.parse(executor.lastSeenAt)) || Date.now() - Date.parse(executor.lastSeenAt) > 30_000) {
      throw new PeerDispatchError('EXECUTOR_NOT_AVAILABLE', 'executor is not freshly discovered and trusted')
    }
    const version = typeof task.requirementSnapshot.aedtVersion === 'string' ? task.requirementSnapshot.aedtVersion : undefined
    if (!alreadyLeased && !this.database.listAvailablePeers(version).some(item => item.nodeId === executor.identity.nodeId)) {
      throw new PeerDispatchError('EXECUTOR_NOT_AVAILABLE', 'executor is not READY, compatible and idle')
    }
  }

  private assertExecutorDisk(executor: DiscoveredPeer, inputSizeBytes: number): void {
    if (!hasAdvertisedDiskCapacity(executor.heartbeat.freeDiskBytes, inputSizeBytes)) {
      throw new PeerDispatchError('EXECUTOR_DISK_LOW', 'executor advertised insufficient disk space for this input')
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeParameters(
  input: IcepakProjectOperationInput, task: TaskRecord, executor: DiscoveredPeer,
): Record<string, unknown> {
  const version = baselineVersion(input, task, executor.heartbeat.aedtVersions.length === 1 ? executor.heartbeat.aedtVersions[0] : undefined)
  if (!executor.heartbeat.aedtVersions.includes(version)) {
    throw new PeerDispatchError('INVALID_PARAMETERS', 'select an AEDT version supported by the executor')
  }
  return {
    version,
    ...(input.design ? { design: input.design } : {}),
    ...(input.setup ? { setup: input.setup } : {}),
    ...(input.cores ? { cores: input.cores } : {}),
    nonGraphical: true,
    ...(input.flowConvergenceCriterion ? { flowConvergenceCriterion: input.flowConvergenceCriterion } : {}),
  }
}

function baselineVersion(input: IcepakProjectOperationInput, task: TaskRecord, fallbackVersion?: string): string {
  if (input.fanSpeedRatio !== undefined || input.baselineMetrics !== undefined || input.minImprovementC !== undefined ||
    input.expectedProfile !== undefined || input.nonGraphical === false ||
    (input.cores !== undefined && input.cores > 64) ||
    (input.flowConvergenceCriterion !== undefined && input.flowConvergenceCriterion > 1) ||
    (input.design?.length ?? 0) > 100 || (input.setup?.length ?? 0) > 100) {
    throw new PeerDispatchError('INVALID_PARAMETERS', 'remote Baseline only accepts bounded solver parameters')
  }
  const requiredVersion = typeof task.requirementSnapshot.aedtVersion === 'string' ? task.requirementSnapshot.aedtVersion : undefined
  if (requiredVersion && input.version && requiredVersion !== input.version) {
    throw new PeerDispatchError('INVALID_PARAMETERS', 'AEDT version differs from confirmed task requirements')
  }
  const version = input.version ?? requiredVersion ?? fallbackVersion
  if (!version || version.length > 40) throw new PeerDispatchError('INVALID_PARAMETERS', 'select an AEDT version before remote dispatch')
  if (!/\.aedt$/iu.test(basename(input.projectPath))) throw new PeerDispatchError('INVALID_INPUT', 'input must be an .aedt project')
  return version
}
