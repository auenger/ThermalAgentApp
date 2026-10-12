import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createTask } from '@thermal-agent/domain'
import { parseParameterPlanRequest, resolveParameterChanges } from '@thermal-agent/contracts'
import type { IcepakProjectOperationResult, ParameterPlan } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import type { IcepakPluginPort } from './icepak-plugin-client.js'
import { TaskWorkspace } from './task-workspace.js'
import type { IcepakExecutionManager } from './execution-manager.js'

export class ParameterPlanManager {
  private starting = false
  private readonly workspace: TaskWorkspace
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  constructor(private readonly home: string, private readonly database: LocalDatabase,
    private readonly artifacts: ArtifactStore, private readonly plugin: IcepakPluginPort,
    private readonly executions: IcepakExecutionManager) {
    this.workspace = new TaskWorkspace(home)
    database.recoverParameterPlans()
  }

  private async baseline(taskId: string) {
    const task = this.database.getTask(taskId)
    if (!task) throw new Error('任务不存在')
    const run = this.database.listTaskRuns(taskId).filter(run => run.kind === 'BASELINE' && run.status === 'COMPLETED').at(-1)
    const attempt = run?.selectedAttemptId ? this.database.getAttempt(run.selectedAttemptId) : null
    if (!attempt) throw new Error('请先完成一次 Baseline 求解，再修改参数')
    const links = this.database.listAttemptArtifacts(attempt.id)
    const source = links.find(item => item.role === 'SOLVED_PROJECT')
    const result = links.find(item => item.role === 'SOLVER_RESULT')
    if (!source || !result) throw new Error('缺少基准工程或结果证据')
    const parsed = JSON.parse(await readFile(this.artifacts.resolveArtifact(result.sha256), 'utf8')) as IcepakProjectOperationResult
    if (parsed.metrics?.converged !== true || parsed.validation?.verified !== true) throw new Error('基准结果未验证收敛，暂不能用于参数方案')
    return { task, run: run!, attempt, source, parsed }
  }

  async context(taskId: string) {
    const { attempt, source, parsed, task } = await this.baseline(taskId)
    let catalog = parsed.parameterCatalog
    const refreshed = this.database.listAttemptArtifacts(attempt.id).filter(link => link.role === 'LOG' &&
      this.database.getArtifact(link.sha256)?.originalName === 'parameter-catalog.json').at(-1)
    if (refreshed) {
      try { catalog = JSON.parse(await readFile(this.artifacts.resolveArtifact(refreshed.sha256), 'utf8')) } catch { /* fall back to baseline inventory */ }
    }
    const plans = this.database.listParameterPlans(taskId)
    const executions: Record<string, { status: string; tmaxC: number | null; converged: boolean | null; deltaC: number | null; error: string | null }> = {}
    for (const plan of plans) {
      const run = plan.runId ? this.database.getRun(plan.runId) : null
      if (!run) continue
      const attempts = this.database.listRunAttempts(run.id)
      const latest = attempts.at(-1)
      const summary = { status: run.status, tmaxC: null as number | null, converged: null as boolean | null, deltaC: null as number | null, error: latest?.errorMessage ?? null }
      const link = latest && this.database.listAttemptArtifacts(latest.id).find(item => item.role === 'SOLVER_RESULT')
      if (link) {
        try {
          const result = JSON.parse(await readFile(this.artifacts.resolveArtifact(link.sha256), 'utf8')) as IcepakProjectOperationResult
          summary.tmaxC = typeof result.metrics?.tmaxC === 'number' ? result.metrics.tmaxC : null
          summary.converged = typeof result.metrics?.converged === 'boolean' ? result.metrics.converged : null
          summary.deltaC = typeof result.comparison?.deltaTmaxC === 'number' ? result.comparison.deltaTmaxC : null
        } catch { /* result unavailable, retain status and error */ }
      }
      executions[plan.id] = summary
    }
    return { sourceAttemptId: attempt.id, sourceSha256: source.sha256, design: parsed.project.activeDesign,
      setup: String(parsed.solve?.setup ?? parsed.project.setups[0] ?? ''), aedtVersion: parsed.project.aedtVersion,
      parameters: catalog?.editableParameters ?? [],
      baselineTmaxC: typeof parsed.metrics?.tmaxC === 'number' ? parsed.metrics.tmaxC : null,
      canOptimize: task.executionStatus === 'WAITING_FOR_APPROVAL' && task.thermalVerdict === 'FAIL' &&
        !this.database.listTaskRuns(taskId).some(run => run.kind === 'CANDIDATE'),
      plans, executions, events: this.database.listTaskEvents(taskId).filter(event => event.eventType.startsWith('parameters.')) }
  }

  get busy(): boolean { return this.starting || this.active.size > 0 }

  async refreshCatalog(taskId: string) {
    const base = await this.baseline(taskId)
    if (this.busy || this.database.listActiveAttempts().length) throw new Error('本机已有验证或求解运行')
    const controller = new AbortController()
    const operation = (async () => {
      const source = this.database.getArtifact(base.source.sha256)!
      const root = join(this.workspace.ensure(taskId), 'parameter-inspections', randomUUID())
      const projectPath = await this.artifacts.materialize(source.sha256, join(root, 'input', source.originalName))
      const inspected = await this.plugin.inspectProject({ projectPath, outputDir: join(root, 'inspect'),
        version: base.parsed.project.aedtVersion, design: base.parsed.project.activeDesign }, { signal: controller.signal })
      if (!inspected.parameterCatalog || inspected.validation?.verified !== true) throw new Error('参数清单读取失败')
      const artifact = await this.artifacts.putBytes(Buffer.from(JSON.stringify(inspected.parameterCatalog)), 'parameter-catalog.json', 'application/json')
      this.database.upsertArtifact(artifact)
      this.database.linkAttemptArtifact({ attemptId: base.attempt.id, sha256: artifact.sha256, role: 'LOG', createdAt: new Date().toISOString() })
    })()
    this.active.set(`catalog:${taskId}`, { controller, promise: operation })
    try { await operation; return await this.context(taskId) }
    finally { this.active.delete(`catalog:${taskId}`) }
  }

  async submit(taskId: string, value: unknown) {
    if (!this.plugin.checkChanges) throw new Error('当前 Icepak 插件尚未支持参数验证')
    if (this.busy || this.database.listActiveAttempts().length) throw new Error('本机已有验证或求解运行，请完成后再验证参数')
    const request = parseParameterPlanRequest(value)
    const context = await this.context(taskId)
    if (request.sourceAttemptId !== context.sourceAttemptId) throw new Error('基准已变化，请刷新参数清单')
    const changes = resolveParameterChanges(context.parameters, request)
    if (this.busy || this.database.listActiveAttempts().length) throw new Error('本机已有验证或求解运行')
    const plan = this.database.createParameterPlan({ taskId, sourceAttemptId: context.sourceAttemptId, sourceSha256: context.sourceSha256,
      design: context.design, setup: context.setup, aedtVersion: context.aedtVersion, changes,
      purpose: changes.some(change => change.role === 'operating-condition') ? 'operating-condition' : 'design',
      author: request.author, reason: request.reason, status: 'CHECKING', error: null, actionResults: [],
      verifiedProjectSha256: null, evidenceSha256: null, executionTaskId: null, runId: null })
    const controller = new AbortController()
    const promise = this.check(plan, controller)
    this.active.set(plan.id, { controller, promise })
    void promise.finally(() => this.active.delete(plan.id))
    return plan
  }

  private async check(plan: ParameterPlan, controller: AbortController): Promise<void> {
    try {
      const source = this.database.getArtifact(plan.sourceSha256)
      if (!source) throw new Error('基准工程已丢失')
      const root = join(this.workspace.ensure(plan.taskId), 'parameter-plans', plan.id)
      const projectPath = await this.artifacts.materialize(source.sha256, join(root, 'input', source.originalName))
      const result = await this.plugin.checkChanges!({ projectPath, outputDir: join(root, 'check'),
        version: plan.aedtVersion, design: plan.design, setup: plan.setup, changes: plan.changes,
        expectedProfile: { design: plan.design, setup: plan.setup, aedtVersion: plan.aedtVersion, artifact: { sha256: plan.sourceSha256 } } }, { signal: controller.signal })
      if (result.inputSha256 !== plan.sourceSha256 || result.validation?.verified !== true || !result.validation.checks.includes('persistedParameters') || !result.verifiedProjectPath ||
        !result.actionResults || result.actionResults.length !== plan.changes.length ||
        plan.changes.some(change => !result.actionResults!.some(action => action.parameterId === change.parameter.id &&
          action.verified === true && action.target === change.parameter.target && action.before === change.parameter.currentValue && action.after === change.value))) throw new Error('保存后重新读取的验证证据不完整')
      const project = await this.artifacts.importFile(result.verifiedProjectPath, basename(source.originalName))
      const evidence = await this.artifacts.putBytes(Buffer.from(JSON.stringify(result, null, 2)), `parameters-v${plan.revision}.json`, 'application/json')
      this.database.upsertArtifact(project); this.database.upsertArtifact(evidence)
      this.database.updateParameterPlan(plan.id, 'CHECKING', { status: 'VERIFIED', verifiedProjectSha256: project.sha256,
        evidenceSha256: evidence.sha256, actionResults: result.actionResults })
    } catch (error) {
      this.database.updateParameterPlan(plan.id, 'CHECKING', { status: 'FAILED', error: error instanceof Error ? error.message : '参数验证失败' })
    }
  }

  async execute(taskId: string, planId: string, expectedVersion: number) {
    if (this.busy || this.database.listActiveAttempts().length) throw new Error('本机已有验证或求解运行')
    this.starting = true
    try { return await this.executePlan(taskId, planId, expectedVersion) }
    finally { this.starting = false }
  }

  private async executePlan(taskId: string, planId: string, expectedVersion: number) {
    const plan = this.database.getParameterPlan(planId)
    if (!plan || plan.taskId !== taskId || plan.status !== 'VERIFIED' || !plan.verifiedProjectSha256) throw new Error('请先完成此版本的参数验证')
    if (this.active.size || this.database.listActiveAttempts().length) throw new Error('本机已有验证或求解运行')
    const base = await this.baseline(taskId)
    if (base.task.version !== expectedVersion) throw new Error('任务已变化，请刷新后执行')
    if (base.attempt.id !== plan.sourceAttemptId || base.source.sha256 !== plan.sourceSha256) throw new Error('基准已变化，请生成新版本')
    if (plan.purpose === 'design' && (base.task.executionStatus !== 'WAITING_FOR_APPROVAL' || base.task.thermalVerdict !== 'FAIL' ||
      this.database.listTaskRuns(taskId).some(run => run.kind === 'CANDIDATE'))) throw new Error('结构候选仅支持未尝试候选的 FAIL 基准任务')
    if (this.active.size || this.database.listActiveAttempts().length) throw new Error('本机已有验证或求解运行')
    this.database.updateParameterPlan(plan.id, 'VERIFIED', { status: 'STARTING' })
    try {
      if (plan.purpose === 'design') {
        const started = await this.executions.startCandidate(taskId, { expectedVersion, parameterPlanId: plan.id,
          preparedProjectSha256: plan.verifiedProjectSha256, version: plan.aedtVersion, setup: plan.setup,
          cores: typeof base.attempt.parameters.cores === 'number' ? base.attempt.parameters.cores : undefined,
          flowConvergenceCriterion: typeof base.attempt.parameters.flowConvergenceCriterion === 'number' ? base.attempt.parameters.flowConvergenceCriterion : undefined,
          minImprovementC: 0.5 })
        return this.database.updateParameterPlan(plan.id, 'STARTING', { status: 'EXECUTED', executionTaskId: taskId, runId: started.run.id })
      }
      // Condition changes get their own task and baseline, never a cooling-gain comparison.
      const childId = randomUUID()
      const source = this.database.getArtifact(plan.verifiedProjectSha256)!
      const path = await this.artifacts.materialize(source.sha256, join(this.workspace.ensure(childId), 'inputs', source.originalName))
      const snapshot = { ...base.task.requirementSnapshot, modelSha256: source.sha256, projectPath: path,
        modelOriginalName: source.originalName, modelKind: 'AEDT', taskWorkspacePath: this.workspace.ensure(childId),
        parentTaskId: taskId, parameterPlanId: plan.id, parentBaselineAttemptId: plan.sourceAttemptId,
        workCondition: `参数方案 v${plan.revision}：${plan.reason}`, autoFanRatio: undefined,
        capabilityAssessment: undefined, planConfirmed: true }
      const child = this.database.createTask(createTask({ title: `${base.task.title} · 工况 v${plan.revision}`,
        description: plan.reason, ownerNodeId: base.task.ownerNodeId, requirementSnapshot: snapshot }, undefined, childId))
      this.database.updateParameterPlan(plan.id, 'STARTING', { executionTaskId: childId })
      this.database.transitionTask(child.id, 'READY', child.version, `来自参数方案 ${plan.id} 的新工况基准`)
      const started = await this.executions.startBaseline(child.id, { projectPath: path, version: plan.aedtVersion,
        design: plan.design, setup: plan.setup, expectedProfile: { design: plan.design, setup: plan.setup, aedtVersion: plan.aedtVersion, artifact: { sha256: source.sha256 } }, cores: typeof base.attempt.parameters.cores === 'number' ? base.attempt.parameters.cores : undefined,
        flowConvergenceCriterion: typeof base.attempt.parameters.flowConvergenceCriterion === 'number' ? base.attempt.parameters.flowConvergenceCriterion : undefined })
      return this.database.updateParameterPlan(plan.id, 'STARTING', { status: 'EXECUTED', executionTaskId: childId, runId: started.run.id })
    } catch (error) {
      this.database.updateParameterPlan(plan.id, 'STARTING', { status: 'FAILED', error: error instanceof Error ? error.message : '启动失败' })
      throw error
    }
  }

  async close() {
    for (const entry of this.active.values()) entry.controller.abort()
    await Promise.allSettled([...this.active.values()].map(entry => entry.promise))
  }
}
