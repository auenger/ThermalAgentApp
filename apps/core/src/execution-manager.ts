import { basename, join } from 'node:path'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import type { IcepakProjectOperationInput, AttemptRecord, RunRecord } from '@thermal-agent/contracts'
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
        this.database.transitionTask(taskId, 'COMPLETED', task.version, 'Baseline 求解及证据收集完成')
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
