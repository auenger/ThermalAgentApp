import { basename, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import type { IcepakEnvironmentProbe, RemoteJobRecord } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import type { IcepakPluginPort } from './icepak-plugin-client.js'
import { PeerArtifactTransfer } from './peer-artifact-transfer.js'
import type { DiscoveredPeer, PeerDiscovery } from './peer-discovery.js'
import { PeerLeaseControl } from './peer-lease-control.js'
import { PeerSecureChannel } from './peer-secure-channel.js'
import { provesIcepakSolve } from './icepak-readiness.js'
import { TaskWorkspace } from './task-workspace.js'

const RENEW_INTERVAL_MS = 20_000
const RETRY_DELAY_MS = 10_000
const FAILURE_NOTIFY_WINDOW_MS = 5 * 60_000

export class PeerRemoteSolveProcessor {
  private timer?: NodeJS.Timeout
  private active?: Promise<void>
  private controller?: AbortController
  private stopped = true
  private readonly retryAfter = new Map<string, number>()
  private readonly workspace: TaskWorkspace

  constructor(
    private readonly home: string,
    private readonly database: LocalDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly plugin: IcepakPluginPort,
    private readonly discovery: PeerDiscovery,
    private readonly channel: PeerSecureChannel,
    private readonly transfer: PeerArtifactTransfer,
    private readonly readinessProbe?: () => Promise<IcepakEnvironmentProbe>,
  ) { this.workspace = new TaskWorkspace(home) }

  start(): void {
    if (this.timer) return
    this.stopped = false
    for (const job of this.database.listRemoteJobs().filter(item => item.status === 'RUNNING')) {
      try {
        this.database.transitionRemoteJob(job.attemptId, job.leaseId, job.epoch, 'RUNNING', 'FAILED',
          { code: 'EXECUTOR_RESTARTED', message: 'Executor restarted during Icepak solve; automatic re-run is unsafe' })
      } catch { /* a newer offer won the race */ }
    }
    this.timer = setInterval(() => this.wake(), 5_000)
    this.timer.unref()
    this.wake()
  }

  wake(): void {
    if (this.stopped || this.active) return
    const jobs = this.database.listRemoteJobs()
    for (const item of jobs.filter(candidate => candidate.status === 'FAILED' && candidate.failureNotificationStatus === 'PENDING')) {
      if (Date.now() - Date.parse(item.updatedAt) >= FAILURE_NOTIFY_WINDOW_MS) {
        try { this.database.markRemoteFailureNotification(item.attemptId, item.leaseId, item.epoch, 'EXPIRED') }
        catch { /* a newer state won */ }
      }
    }
    const failed = jobs.find(item => item.status === 'FAILED' && item.failureNotificationStatus === 'PENDING' &&
      Date.now() - Date.parse(item.updatedAt) < FAILURE_NOTIFY_WINDOW_MS &&
      (this.retryAfter.get(item.attemptId) ?? 0) <= Date.now())
    const job = failed ?? (this.database.remoteExecutionEnabled() ? jobs.find(item =>
      ['INPUT_READY', 'SYNCING_RESULTS'].includes(item.status) &&
      (this.retryAfter.get(item.attemptId) ?? 0) <= Date.now()) : undefined)
    if (!job) return
    const owner = this.discovery.status().discovered.find(peer =>
      peer.trusted && peer.identity.nodeId === job.ownerNodeId)
    if (!owner) return
    const controller = new AbortController()
    this.controller = controller
    this.active = (failed ? this.notifyFailure(job, owner) : this.process(job, owner, controller)).finally(() => {
      this.active = undefined
      this.controller = undefined
      this.wake()
    })
  }

  private async notifyFailure(job: RemoteJobRecord, owner: DiscoveredPeer): Promise<void> {
    try {
      const response = await this.send(owner, { operation: 'task.baseline.fail', ...jobReference(job),
        code: job.errorCode ?? 'REMOTE_SOLVE_FAILED',
        message: (job.errorMessage ?? 'remote Icepak solve failed').slice(0, 2_000) })
      if (!isObject(response) || response.operation !== 'task.baseline.failed' || response.attemptId !== job.attemptId) {
        throw new Error('Owner did not acknowledge the remote failure')
      }
      this.database.markRemoteFailureNotification(job.attemptId, job.leaseId, job.epoch, 'ACKED')
      this.retryAfter.delete(job.attemptId)
    } catch {
      this.retryAfter.set(job.attemptId, Date.now() + RETRY_DELAY_MS)
    }
  }

  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.controller?.abort()
    await this.active
  }

  private async process(job: RemoteJobRecord, owner: DiscoveredPeer, controller: AbortController): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    let renewalError: Error | undefined
    let renewing = false
    let stage: RemoteJobRecord['status'] = job.status
    try {
      if (stage === 'SYNCING_RESULTS' && job.solvedSha256 && job.resultSha256) {
        try {
          const completed = await this.send(owner, { operation: 'task.baseline.complete', ...jobReference(job),
            solvedSha256: job.solvedSha256, resultSha256: job.resultSha256 })
          if (isObject(completed) && completed.operation === 'task.baseline.completed' && completed.attemptId === job.attemptId) {
            this.database.transitionRemoteJob(job.attemptId, job.leaseId, job.epoch, 'SYNCING_RESULTS', 'COMPLETED')
            this.retryAfter.delete(job.attemptId)
            return
          }
        } catch { /* result evidence may still need uploading */ }
      }
      await PeerLeaseControl.renewOnOwner(owner, this.channel, job.leaseId, job.epoch)
      const current = this.database.getRemoteJob(job.attemptId)
      if (!current || current.leaseId !== job.leaseId || current.epoch !== job.epoch || current.status !== stage) return
      timer = setInterval(() => {
        if (renewing || controller.signal.aborted) return
        renewing = true
        void (async () => {
          try {
            const fresh = this.discovery.status().discovered.find(peer =>
              peer.trusted && peer.identity.nodeId === job.ownerNodeId)
            if (!fresh) throw new Error('trusted Owner is no longer discovered')
            await PeerLeaseControl.renewOnOwner(fresh, this.channel, job.leaseId, job.epoch)
          } catch (error) {
            renewalError = error instanceof Error ? error : new Error('remote lease renewal failed')
            controller.abort()
          } finally { renewing = false }
        })()
      }, RENEW_INTERVAL_MS)
      timer.unref()

      if (stage === 'INPUT_READY') {
        const probe = await (this.readinessProbe?.() ?? this.plugin.probeEnvironment())
        if (probe.platform !== 'win32' || probe.status !== 'READY' || probe.licenseStatus !== 'AVAILABLE' ||
          !probe.capabilities.includes('baseline_solve')) throw new Error('Icepak is no longer READY for remote solve')
        const input = this.database.getArtifact(job.inputSha256)
        if (!input || input.sizeBytes !== job.inputSizeBytes) throw new Error('staged input artifact is missing')
        const projectPath = await this.artifacts.materialize(job.inputSha256,
          join(this.workspace.ensure(job.taskId), 'runs', job.attemptId, 'input', basename(job.inputOriginalName)))
        await this.send(owner, { operation: 'task.baseline.start', ...jobReference(job) })
        this.database.transitionRemoteJob(job.attemptId, job.leaseId, job.epoch, 'INPUT_READY', 'RUNNING')
        stage = 'RUNNING'
        const result = await this.plugin.solveProject({ ...job.parameters, projectPath,
          outputDir: join(this.workspace.ensure(job.taskId), 'runs', job.attemptId, 'plugin') }, { signal: controller.signal })
        if (controller.signal.aborted) throw renewalError ?? new Error('remote solve was cancelled')
        if (result.status !== 'ok' || result.mode !== 'solve' || result.inputSha256 !== job.inputSha256) {
          throw new Error('Icepak returned a mismatched Baseline result')
        }
        const solvedPath = typeof result.artifacts?.projectPath === 'string' ? result.artifacts.projectPath : null
        if (!solvedPath) throw new Error('Icepak result is missing the solved project')
        const solved = await this.artifacts.importFile(solvedPath)
        const structured = await this.artifacts.putBytes(Buffer.from(JSON.stringify(result)),
          `${job.attemptId}-result.json`, 'application/json')
        const convergencePath = typeof result.artifacts?.convergencePath === 'string' ? result.artifacts.convergencePath : null
        const convergence = convergencePath
          ? await this.artifacts.importFile(convergencePath, 'convergence.json', 'application/json') : null
        for (const artifact of [solved, structured, convergence].filter(item => item !== null)) {
          this.database.upsertArtifact(artifact)
        }
        this.database.stageRemoteJobResults(job.attemptId, job.leaseId, job.epoch,
          solved.sha256, structured.sha256, convergence?.sha256 ?? null)
        stage = 'SYNCING_RESULTS'
      }

      const staged = this.database.getRemoteJob(job.attemptId)
      if (!staged || staged.status !== 'SYNCING_RESULTS' || staged.leaseId !== job.leaseId ||
        staged.epoch !== job.epoch || !staged.solvedSha256 || !staged.resultSha256) return
      for (const [sha, role] of [
        [staged.solvedSha256, 'SOLVED_PROJECT'],
        [staged.resultSha256, 'SOLVER_RESULT'],
        ...(staged.convergenceSha256 ? [[staged.convergenceSha256, 'CONVERGENCE_EVIDENCE']] : []),
      ] as Array<[string, 'SOLVED_PROJECT' | 'SOLVER_RESULT' | 'CONVERGENCE_EVIDENCE']>) {
        if (controller.signal.aborted) throw renewalError ?? new Error('result synchronization was cancelled')
        const artifact = this.database.getArtifact(sha)
        if (!artifact) throw new Error(`staged ${role} artifact is missing`)
        await this.transfer.uploadLeasedResult(owner, { ...jobReference(job), sha256: sha,
          sizeBytes: artifact.sizeBytes, originalName: artifact.originalName, mediaType: artifact.mediaType },
        role, this.channel, controller.signal)
      }
      const response = await this.send(owner, { operation: 'task.baseline.complete', ...jobReference(job),
        solvedSha256: staged.solvedSha256, resultSha256: staged.resultSha256 })
      if (!isObject(response) || response.operation !== 'task.baseline.completed' || response.attemptId !== job.attemptId) {
        throw new Error('Owner did not confirm the completed Baseline')
      }
      this.database.transitionRemoteJob(job.attemptId, job.leaseId, job.epoch, 'SYNCING_RESULTS', 'COMPLETED')
      try {
        const version = typeof job.parameters.version === 'string' ? job.parameters.version : ''
        const evidence = JSON.parse(await readFile(this.artifacts.resolveArtifact(staged.resultSha256), 'utf8'))
        if (provesIcepakSolve(evidence, version)) {
          const probe = await this.plugin.probeEnvironment()
          this.database.recordIcepakReadinessFromRemoteJob(job.attemptId, version, probe.pluginVersion, staged.resultSha256)
        }
      } catch (error) { console.error('remote Icepak readiness evidence was not recorded', error) }
      this.retryAfter.delete(job.attemptId)
    } catch (error) {
      const cause = renewalError ?? (error instanceof Error ? error : new Error('remote solve failed'))
      const current = this.database.getRemoteJob(job.attemptId)
      if (!current || current.leaseId !== job.leaseId || current.epoch !== job.epoch) return
      if (current.status === 'RUNNING') {
        const code = controller.signal.aborted ? 'REMOTE_SOLVE_CANCELLED' : 'REMOTE_SOLVE_FAILED'
        try {
          this.database.transitionRemoteJob(job.attemptId, job.leaseId, job.epoch, 'RUNNING', 'FAILED',
            { code, message: cause.message.slice(0, 2_000) || 'remote solve failed' })
          await this.notifyFailure(this.database.getRemoteJob(job.attemptId) as RemoteJobRecord, owner)
        } catch { /* newer lease won */ }
      } else if (current.status === 'INPUT_READY' || current.status === 'SYNCING_RESULTS') {
        this.retryAfter.set(job.attemptId, Date.now() + RETRY_DELAY_MS)
        try { this.database.recordRemoteJobError(job.attemptId, job.leaseId, job.epoch,
          'REMOTE_OWNER_UNAVAILABLE', cause.message) } catch { /* newer lease won */ }
      }
    } finally { if (timer) clearInterval(timer) }
  }

  private async send(owner: DiscoveredPeer, message: object): Promise<unknown> {
    const { sessionId } = await this.channel.connect(owner)
    return this.channel.request(owner, sessionId, message)
  }
}

function jobReference(job: RemoteJobRecord): { taskId: string; attemptId: string; leaseId: string; epoch: number } {
  return { taskId: job.taskId, attemptId: job.attemptId, leaseId: job.leaseId, epoch: job.epoch }
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
