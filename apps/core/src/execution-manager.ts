import { basename, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import type { IcepakCandidateInput, IcepakProjectOperationInput, IcepakProjectOperationResult, AttemptRecord, RunRecord, ThermalVerdict } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import type { IcepakPluginPort } from './icepak-plugin-client.js'

export interface StartedExecution {
  run: RunRecord
  attempt: AttemptRecord
}

export class IcepakExecutionManager {
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>()

  constructor(
    private readonly home: string,
    private readonly database: LocalDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly plugin: IcepakPluginPort,
  ) {
    this.recoverInterruptedAttempts()
  }

  async startBaseline(taskId: string, input: IcepakProjectOperationInput): Promise<StartedExecution> {
    const task = this.database.getTask(taskId)
    if (!task) throw new Error(`task ${taskId} was not found`)
    if (task.executionStatus !== 'READY') throw new Error('task must be READY before starting a baseline run')

    const inputArtifact = await this.artifacts.importFile(input.projectPath)
    this.database.upsertArtifact(inputArtifact)
    const created = this.database.createRunWithAttempt({
      taskId,
      kind: 'BASELINE',
      executorNodeId: task.ownerNodeId,
      pluginId: 'icepak-pyaedt',
      pluginVersion: '0.2.0',
      parameters: { ...input, projectPath: undefined },
      inputArtifactSha256: inputArtifact.sha256,
    })
    this.database.linkAttemptArtifact({
      attemptId: created.attempt.id,
      sha256: inputArtifact.sha256,
      role: 'INPUT_PROJECT',
      createdAt: new Date().toISOString(),
    })
    const attemptRoot = join(this.home, 'runs', created.attempt.id)
    const stagedProject = await this.artifacts.materialize(
      inputArtifact.sha256,
      join(attemptRoot, 'input', basename(input.projectPath)),
    )
    const pluginInput = { ...input, projectPath: stagedProject, outputDir: join(attemptRoot, 'plugin') }
    this.database.transitionTask(taskId, 'QUEUED', task.version, 'Baseline 已进入本机队列')
    this.database.transitionAttempt(created.attempt.id, 'STARTING', { progressStage: 'plugin_starting' })
    this.database.transitionTask(taskId, 'RUNNING', task.version + 1, 'Icepak 插件已启动')

    const controller = new AbortController()
    const promise = this.executeBaseline(taskId, created.attempt.id, pluginInput, controller)
    this.active.set(created.attempt.id, { controller, promise })
    void promise.finally(() => this.active.delete(created.attempt.id))
    return {
      run: this.database.getRun(created.run.id) as RunRecord,
      attempt: this.database.getAttempt(created.attempt.id) as AttemptRecord,
    }
  }

  async startCandidate(taskId: string, input: IcepakCandidateInput): Promise<StartedExecution> {
    const task = this.database.getTask(taskId)
    if (!task) throw new Error(`task ${taskId} was not found`)
    if (task.executionStatus !== 'WAITING_FOR_APPROVAL' || task.approvalStatus !== 'PENDING' || task.thermalVerdict !== 'FAIL') {
      throw new Error('task must be waiting on a converged FAIL baseline before starting a candidate')
    }
    if (this.database.listTaskRuns(taskId).some(run => run.kind === 'CANDIDATE')) {
      throw new Error('task must not run more than one candidate in the two-round workflow')
    }
    const baselineRun = this.database.listTaskRuns(taskId).filter(run => run.kind === 'BASELINE' && run.status === 'COMPLETED').at(-1)
    const baselineAttempt = baselineRun?.selectedAttemptId ? this.database.getAttempt(baselineRun.selectedAttemptId) : null
    if (!baselineRun || !baselineAttempt) throw new Error('task must have a selected Baseline attempt')
    const baselineArtifacts = this.database.listAttemptArtifacts(baselineAttempt.id)
    const solved = baselineArtifacts.find(item => item.role === 'SOLVED_PROJECT')
    const resultArtifact = baselineArtifacts.find(item => item.role === 'SOLVER_RESULT')
    if (!solved || !resultArtifact) throw new Error('task must have Baseline solved-project and result artifacts')
    const baselineResult = JSON.parse(await readFile(this.artifacts.resolveArtifact(resultArtifact.sha256), 'utf8')) as IcepakProjectOperationResult
    if (!baselineResult.metrics || typeof baselineResult.metrics !== 'object') throw new Error('task must have Baseline temperature metrics')

    const candidateRoot = join(this.home, 'runs', `candidate-${Date.now()}`)
    const stagedProject = await this.artifacts.materialize(
      solved.sha256,
      join(candidateRoot, 'input', basename(baselineResult.workingProject || 'Baseline.aedt')),
    )
    const approved = this.database.approveCandidateAction(
      taskId, input.expectedVersion ?? task.version, `用户批准风扇转速比例 ${input.fanSpeedRatio}`,
    )
    const created = this.database.createRunWithAttempt({
      taskId, kind: 'CANDIDATE', executorNodeId: task.ownerNodeId,
      pluginId: baselineAttempt.pluginId, pluginVersion: baselineAttempt.pluginVersion,
      parameters: { ...input, expectedVersion: undefined, baselineAttemptId: baselineAttempt.id }, inputArtifactSha256: solved.sha256,
    })
    this.database.linkAttemptArtifact({
      attemptId: created.attempt.id, sha256: solved.sha256, role: 'INPUT_PROJECT', createdAt: new Date().toISOString(),
    })
    this.database.transitionAttempt(created.attempt.id, 'STARTING', { progressStage: 'plugin_starting' })
    this.database.transitionTask(taskId, 'RUNNING', approved.version, '已批准的风扇候选开始求解')
    const pluginInput = {
      ...input,
      expectedVersion: undefined,
      projectPath: stagedProject,
      baselineMetrics: baselineResult.metrics,
      outputDir: join(this.home, 'runs', created.attempt.id, 'plugin'),
      nonGraphical: true,
    }
    const controller = new AbortController()
    const promise = this.executeCandidate(taskId, created.attempt.id, pluginInput, controller)
    this.active.set(created.attempt.id, { controller, promise })
    void promise.finally(() => this.active.delete(created.attempt.id))
    return {
      run: this.database.getRun(created.run.id) as RunRecord,
      attempt: this.database.getAttempt(created.attempt.id) as AttemptRecord,
    }
  }

  async retryLatestRun(taskId: string, expectedVersion: number): Promise<StartedExecution> {
    const task = this.database.getTask(taskId)
    if (!task) throw new Error(`task ${taskId} was not found`)
    if (!['FAILED', 'CANCELLED'].includes(task.executionStatus)) throw new Error('task must be failed or cancelled before retry')
    const run = this.database.listTaskRuns(taskId).at(-1)
    if (!run || !['FAILED', 'CANCELLED'].includes(run.status)) throw new Error('task must have a failed or cancelled latest Run')
    const previous = this.database.listRunAttempts(run.id).at(-1)
    if (!previous?.inputArtifactSha256) throw new Error('retry requires an immutable input artifact')
    const inputArtifact = this.database.getArtifact(previous.inputArtifactSha256)
    if (!inputArtifact) throw new Error('retry requires the stored input artifact metadata')
    const retryRoot = join(this.home, 'runs', `retry-${Date.now()}`)
    const stagedProject = await this.artifacts.materialize(
      previous.inputArtifactSha256, join(retryRoot, 'input', inputArtifact.originalName),
    )
    let baselineMetrics: Record<string, unknown> | undefined
    if (run.kind === 'CANDIDATE') {
      const baselineAttemptId = previous.parameters.baselineAttemptId
      if (typeof baselineAttemptId !== 'string') throw new Error('candidate retry requires its Baseline attempt identity')
      const resultArtifact = this.database.listAttemptArtifacts(baselineAttemptId).find(item => item.role === 'SOLVER_RESULT')
      if (!resultArtifact) throw new Error('candidate retry requires Baseline result evidence')
      const baseline = JSON.parse(await readFile(this.artifacts.resolveArtifact(resultArtifact.sha256), 'utf8')) as IcepakProjectOperationResult
      if (!baseline.metrics || typeof baseline.metrics !== 'object') throw new Error('candidate retry requires Baseline metrics')
      baselineMetrics = baseline.metrics
    }
    const retried = this.database.retryRun(run.id, expectedVersion)
    this.database.linkAttemptArtifact({
      attemptId: retried.attempt.id, sha256: previous.inputArtifactSha256,
      role: 'INPUT_PROJECT', createdAt: new Date().toISOString(),
    })
    this.database.transitionAttempt(retried.attempt.id, 'STARTING', { progressStage: 'plugin_starting' })
    this.database.transitionTask(taskId, 'RUNNING', retried.task.version, '失败 Run 已由用户显式重试')
    const pluginInput = {
      ...previous.parameters,
      expectedVersion: undefined,
      baselineAttemptId: undefined,
      projectPath: stagedProject,
      ...(baselineMetrics ? { baselineMetrics } : {}),
      outputDir: join(this.home, 'runs', retried.attempt.id, 'plugin'),
      nonGraphical: true,
    } as IcepakProjectOperationInput & { outputDir: string }
    const controller = new AbortController()
    const promise = run.kind === 'CANDIDATE'
      ? this.executeCandidate(taskId, retried.attempt.id, pluginInput, controller)
      : this.executeBaseline(taskId, retried.attempt.id, pluginInput, controller)
    this.active.set(retried.attempt.id, { controller, promise })
    void promise.finally(() => this.active.delete(retried.attempt.id))
    return { run: retried.run, attempt: this.database.getAttempt(retried.attempt.id) as AttemptRecord }
  }

  cancel(attemptId: string): void {
    const execution = this.active.get(attemptId)
    if (!execution) throw new Error(`attempt ${attemptId} is not active in this process`)
    execution.controller.abort()
  }

  async close(): Promise<void> {
    const executions = [...this.active.values()]
    for (const execution of executions) execution.controller.abort()
    await Promise.allSettled(executions.map(execution => execution.promise))
  }

  private async executeBaseline(
    taskId: string,
    attemptId: string,
    input: IcepakProjectOperationInput & { outputDir: string },
    controller: AbortController,
  ): Promise<void> {
    this.database.transitionAttempt(attemptId, 'RUNNING', { progressStage: 'plugin_running' })
    const heartbeat = setInterval(() => {
      try { this.database.heartbeatAttempt(attemptId) } catch { /* terminal transition won the race */ }
    }, 15_000)
    heartbeat.unref()
    try {
      const result = await this.plugin.solveProject(input, {
        signal: controller.signal,
        onProgress: stage => {
          try { this.database.heartbeatAttempt(attemptId, stage) } catch { /* ignore terminal races */ }
        },
      })
      const solvedPath = typeof result.artifacts?.projectPath === 'string' ? result.artifacts.projectPath : null
      if (!solvedPath) throw new Error('Icepak plugin result is missing the solved project artifact')
      const solvedArtifact = await this.artifacts.importFile(solvedPath)
      this.database.upsertArtifact(solvedArtifact)
      this.database.linkAttemptArtifact({
        attemptId, sha256: solvedArtifact.sha256, role: 'SOLVED_PROJECT', createdAt: new Date().toISOString(),
      })
      const resultArtifact = await this.artifacts.putBytes(
        Buffer.from(JSON.stringify(result, null, 2)),
        `${attemptId}-result.json`,
        'application/json',
      )
      this.database.upsertArtifact(resultArtifact)
      this.database.linkAttemptArtifact({
        attemptId, sha256: resultArtifact.sha256, role: 'SOLVER_RESULT', createdAt: new Date().toISOString(),
      })
      const convergencePath = typeof result.artifacts?.convergencePath === 'string'
        ? result.artifacts.convergencePath
        : null
      if (convergencePath) {
        const convergenceArtifact = await this.artifacts.importFile(convergencePath, 'convergence.json', 'application/json')
        this.database.upsertArtifact(convergenceArtifact)
        this.database.linkAttemptArtifact({
          attemptId, sha256: convergenceArtifact.sha256, role: 'CONVERGENCE_EVIDENCE', createdAt: new Date().toISOString(),
        })
      }
      this.database.transitionAttempt(attemptId, 'SUCCEEDED', {
        progressStage: 'result_collected', outputArtifactSha256: solvedArtifact.sha256,
      })
      const task = this.database.getTask(taskId)
      if (task?.executionStatus === 'RUNNING') {
        const verdict = determineThermalVerdict(result, task.requirementSnapshot)
        this.database.requestTaskApproval(taskId, verdict, task.version, 'Baseline 求解及证据收集完成，等待人工复核')
      }
    } catch (error) {
      const cancelled = controller.signal.aborted
      const message = error instanceof Error ? error.message : 'unknown Icepak execution error'
      const attempt = this.database.getAttempt(attemptId)
      if (attempt && ['STARTING', 'RUNNING'].includes(attempt.status)) {
        this.database.transitionAttempt(attemptId, cancelled ? 'CANCELLED' : 'FAILED', {
          progressStage: cancelled ? 'cancelled' : 'failed',
          errorCode: cancelled ? 'USER_CANCELLED' : 'ICEPAK_EXECUTION_FAILED',
          errorMessage: message,
        })
      }
      const task = this.database.getTask(taskId)
      if (task?.executionStatus === 'RUNNING') {
        this.database.transitionTask(taskId, cancelled ? 'CANCELLED' : 'FAILED', task.version, message)
      }
    } finally {
      clearInterval(heartbeat)
    }
  }

  private async executeCandidate(
    taskId: string,
    attemptId: string,
    input: IcepakProjectOperationInput & { outputDir: string },
    controller: AbortController,
  ): Promise<void> {
    this.database.transitionAttempt(attemptId, 'RUNNING', { progressStage: 'plugin_running' })
    const heartbeat = setInterval(() => {
      try { this.database.heartbeatAttempt(attemptId) } catch { /* terminal transition won the race */ }
    }, 15_000)
    heartbeat.unref()
    try {
      const result = await this.plugin.fanSolve(input, {
        signal: controller.signal,
        onProgress: stage => {
          try { this.database.heartbeatAttempt(attemptId, stage) } catch { /* ignore terminal races */ }
        },
      })
      const solvedPath = typeof result.artifacts?.projectPath === 'string' ? result.artifacts.projectPath : null
      if (!solvedPath) throw new Error('Icepak plugin result is missing the solved project artifact')
      const solvedArtifact = await this.artifacts.importFile(solvedPath)
      this.database.upsertArtifact(solvedArtifact)
      this.database.linkAttemptArtifact({ attemptId, sha256: solvedArtifact.sha256, role: 'SOLVED_PROJECT', createdAt: new Date().toISOString() })
      const resultArtifact = await this.artifacts.putBytes(
        Buffer.from(JSON.stringify(result, null, 2)), `${attemptId}-result.json`, 'application/json',
      )
      this.database.upsertArtifact(resultArtifact)
      this.database.linkAttemptArtifact({ attemptId, sha256: resultArtifact.sha256, role: 'SOLVER_RESULT', createdAt: new Date().toISOString() })
      const convergencePath = typeof result.artifacts?.convergencePath === 'string' ? result.artifacts.convergencePath : null
      if (convergencePath) {
        const convergenceArtifact = await this.artifacts.importFile(convergencePath, 'convergence.json', 'application/json')
        this.database.upsertArtifact(convergenceArtifact)
        this.database.linkAttemptArtifact({ attemptId, sha256: convergenceArtifact.sha256, role: 'CONVERGENCE_EVIDENCE', createdAt: new Date().toISOString() })
      }
      this.database.transitionAttempt(attemptId, 'SUCCEEDED', { progressStage: 'result_collected', outputArtifactSha256: solvedArtifact.sha256 })
      const task = this.database.getTask(taskId)
      if (task?.executionStatus === 'RUNNING') {
        const rollback = result.comparison?.rollbackRequired === true
        const verdict = rollback ? 'FAIL' : determineThermalVerdict(result, task.requirementSnapshot)
        this.database.requestTaskApproval(taskId, verdict, task.version, rollback
          ? '候选出现局部温度回退，等待人工复核'
          : '候选求解及对比证据收集完成，等待人工复核')
      }
    } catch (error) {
      const cancelled = controller.signal.aborted
      const message = error instanceof Error ? error.message : 'unknown Icepak candidate execution error'
      const attempt = this.database.getAttempt(attemptId)
      if (attempt && ['STARTING', 'RUNNING'].includes(attempt.status)) {
        this.database.transitionAttempt(attemptId, cancelled ? 'CANCELLED' : 'FAILED', {
          progressStage: cancelled ? 'cancelled' : 'failed', errorCode: cancelled ? 'USER_CANCELLED' : 'ICEPAK_CANDIDATE_FAILED', errorMessage: message,
        })
      }
      const task = this.database.getTask(taskId)
      if (task?.executionStatus === 'RUNNING') this.database.transitionTask(taskId, cancelled ? 'CANCELLED' : 'FAILED', task.version, message)
    } finally {
      clearInterval(heartbeat)
    }
  }

  private recoverInterruptedAttempts(): void {
    for (const attempt of this.database.listActiveAttempts()) {
      this.database.transitionAttempt(attempt.id, 'INTERRUPTED', {
        progressStage: 'interrupted',
        errorCode: 'CORE_RESTARTED',
        errorMessage: 'Local Core restarted while the plugin attempt was active',
      })
      const run = this.database.getRun(attempt.runId)
      const task = run ? this.database.getTask(run.taskId) : null
      if (task?.executionStatus === 'RUNNING') {
        this.database.transitionTask(task.id, 'FAILED', task.version, 'Core 重启，中断的求解需要人工确认后重试')
      }
    }
  }
}

export function determineThermalVerdict(
  result: { validation: { verified: boolean }; metrics?: Record<string, unknown> },
  requirementSnapshot: Record<string, unknown>,
): ThermalVerdict {
  if (!result.validation.verified) return 'INVALID'
  const metrics = result.metrics
  const tmaxC = Number(metrics?.tmaxC)
  if (!metrics || !Number.isFinite(tmaxC)) return 'INVALID'
  if (metrics.converged !== true || metrics.solverNormalCompletion === false) return 'DIVERGED'
  const target = Number(requirementSnapshot.targetTmaxC)
  if (!Number.isFinite(target)) return 'PENDING'
  return tmaxC <= target ? 'PASS' : 'FAIL'
}
