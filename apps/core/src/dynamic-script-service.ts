import { DynamicScriptIterations } from './dynamic-script-iterations.js'
import { constants } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { TaskWorkspace } from './task-workspace.js'
import { join } from 'node:path'
import type { LocalDatabase, ModelPreparationStore } from '@thermal-agent/sqlite-store'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import type { IcepakPluginPort } from './icepak-plugin-client.js'
import { DynamicScriptLibrary } from './dynamic-script-library.js'
import { DynamicScriptManager } from './dynamic-script-manager.js'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求必须是 JSON 对象')
  return value as Record<string, unknown>
}
/** Shared business entry for loopback HTTP and authenticated DSH; neither accepts caller-owned paths or receipts. */
export class DynamicScriptService {
  readonly library: DynamicScriptLibrary
  readonly manager: DynamicScriptManager
  readonly iterations: DynamicScriptIterations
  get busy(): boolean { return this.manager.busy || this.iterations.busy }
  private readonly workspace: TaskWorkspace
  constructor(home: string, private readonly database: LocalDatabase, private readonly artifacts: ArtifactStore,
    plugin: IcepakPluginPort, private readonly nodeId: string, private readonly operations: ModelPreparationStore) {
    this.workspace = new TaskWorkspace(home)
    this.library = new DynamicScriptLibrary(join(home, 'data', 'dynamic-scripts.sqlite'))
    this.manager = new DynamicScriptManager(home, this.library, artifacts, plugin, artifact => database.upsertArtifact(artifact))
    this.iterations = new DynamicScriptIterations(home, this.library, this.manager, artifacts, plugin, artifact => database.upsertArtifact(artifact), job => {
      const task = this.task(job.taskId)
      if (task.version !== job.approvedTaskVersion || task.requirementSnapshot.planConfirmed !== true) throw new Error('任务已变化，自动迭代授权不再匹配')
    })
    this.recover()
  }
  private recover(): void {
    if (!this.busy && !this.operations.reconcileRecoveredOperation()) { this.library.recoverInterrupted(); this.iterations.recoverInterrupted() }
  }
  private task(taskId: string) {
    const task = this.database.getTask(taskId)
    if (!task || task.ownerNodeId !== this.nodeId) throw new Error('动态脚本仅能操作本机拥有的任务')
    return task
  }
  private async sourcePath(taskId: string, sha256: string): Promise<string> {
    const directory = join(this.workspace.ensure(taskId), 'dynamic-inputs', sha256)
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'project.aedt')
    try { await copyFile(this.artifacts.resolveArtifact(sha256), path, constants.COPYFILE_EXCL) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    return path
  }
  async context(taskId: string) {
    this.recover()
    const task = this.task(taskId)
    const snapshot = task.requirementSnapshot
    const sourceSha256 = typeof snapshot.modelSha256 === 'string' ? snapshot.modelSha256 : undefined
    const artifact = sourceSha256 ? this.database.getArtifact(sourceSha256) : undefined
    return { taskId, taskVersion: task.version, planConfirmed: snapshot.planConfirmed === true,
      aedtVersion: typeof snapshot.aedtVersion === 'string' ? snapshot.aedtVersion : undefined,
      source: artifact && artifact.originalName.toLowerCase().endsWith('.aedt') ? {
        sha256: artifact.sha256, originalName: artifact.originalName,
        projectPath: await this.sourcePath(taskId, artifact.sha256),
      } : null,
      runs: this.library.runs(taskId), iterations: this.library.iterations(taskId), busy: this.busy,
      pendingEngineeringCleanup: !!this.operations.reconcileRecoveredOperation(),
      scriptContract: { entrypoints: ['apply(ipk, parameters)', 'verify(ipk, parameters)'],
        readback: 'verify returns {passed: boolean, checks: nonempty array}; checks must read the saved and reopened project',
        solve: 'No solver result is granted by script completion; use the authorized simulation workflow',
        definitionFields: ['name', 'version', 'description', 'source', 'parameters', 'applicability', 'tags'],
        parameterTypes: ['number', 'integer', 'string', 'boolean'],
        applicability: '{aedtVersions: string[], requiredObjects: string[]}' } }
  }
  async dispatch(method: string, path: string, body?: unknown, query = '', channel: 'app' | 'agent' = 'app'): Promise<{ status: number; body: unknown }> {
    this.recover()
    if (path === '/dynamic-scripts') {
      if (method === 'GET') return { status: 200, body: { scripts: this.library.list(query) } }
      if (method === 'POST') return { status: 201, body: { script: this.library.stage(body) } }
    }
    const scriptMatch = path.match(/^\/dynamic-scripts\/([a-f0-9]{64})(\/disable)?$/u)
    if (scriptMatch) {
      if (method === 'GET' && !scriptMatch[2]) return { status: 200, body: { script: this.library.get(scriptMatch[1]) } }
      if (method === 'POST' && scriptMatch[2]) {
        const value = object(body)
        if (typeof value.disabled !== 'boolean') throw new Error('disabled 必须为布尔值')
        return { status: 200, body: { script: this.library.disable(scriptMatch[1], value.disabled) } }
      }
    }
    const iterationMatch = path.match(/^\/tasks\/([a-f0-9-]{36})\/script-iterations(?:\/([a-f0-9-]{36})\/(start|cancel))?$/u)
    if (iterationMatch) {
      const task = this.task(iterationMatch[1])
      if (method === 'GET' && !iterationMatch[2]) return { status: 200, body: { iterations: this.library.iterations(task.id) } }
      if (method === 'POST') {
        if (!iterationMatch[2]) {
          const context = await this.context(task.id)
          if (!context.source || !context.aedtVersion) throw new Error('需要已登记的 AEDT 工程和明确版本')
          return { status: 201, body: { iteration: this.iterations.draft(task.id, context.source.sha256, context.aedtVersion, body) } }
        }
        const iteration = this.library.iteration(iterationMatch[2])
        if (iteration.taskId !== task.id) throw new Error('迭代不属于当前任务')
        if (iterationMatch[3] === 'cancel') {
          this.iterations.cancel(iteration.id)
          return { status: 202, body: { iteration: this.library.iteration(iteration.id), cancellationRequested: true } }
        }
        if (channel !== 'app') throw new Error('AI 只能准备迭代计划，启动求解需用户在 App 确认预算和参数范围')
        const value = object(body)
        if (value.expectedTaskVersion !== task.version || task.requirementSnapshot.planConfirmed !== true) throw new Error('任务或确认状态已变化，请刷新后确认')
        if (task.requirementSnapshot.modelSha256 !== iteration.projectSha256 || task.requirementSnapshot.aedtVersion !== iteration.aedtVersion) throw new Error('迭代输入工程或环境已变化，请重新准备计划')
        if (this.database.listActiveAttempts().length || this.operations.reconcileRecoveredOperation()) throw new Error('本机有工程任务或进程待清理')
        return { status: 202, body: { iteration: await this.iterations.start(iteration.id, task.version) } }
      }
      throw new Error('未知迭代操作')
    }
    const match = path.match(/^\/tasks\/([a-f0-9-]{36})\/(script-context|script-runs)(?:\/([a-f0-9-]{36})\/(cancel))?$/u)
    if (match) {
      const task = this.task(match[1])
      if (method === 'GET' && !match[3]) return { status: 200, body: match[2] === 'script-context' ? await this.context(task.id) : { runs: this.library.runs(task.id) } }
      if (method === 'POST' && match[2] === 'script-runs') {
        if (match[3]) {
          const run = this.library.getRun(match[3])
          if (run.taskId !== task.id) throw new Error('脚本执行不属于当前任务')
          const iteration = this.library.iterations(task.id).find(item => item.status === 'RUNNING' && item.rounds.some(round => round.scriptRunId === run.id))
          if (iteration) this.iterations.cancel(iteration.id)
          else this.manager.cancel(run.id)
          return { status: 202, body: { run: this.library.getRun(run.id), cancellationRequested: true } }
        }
        const value = object(body)
        if (Object.keys(value).some(key => !['scriptId', 'parameters', 'projectSha256'].includes(key)) || typeof value.scriptId !== 'string') throw new Error('脚本执行只接受 scriptId、parameters 和可选 projectSha256')
        const context = await this.context(task.id)
        if (!context.planConfirmed) throw new Error('请先在任务中确认仿真计划')
        if (!context.source || !context.aedtVersion) throw new Error('任务需要已登记的 AEDT 工程和明确的 AEDT 版本')
        const selected = value.projectSha256 ?? context.source.sha256
        const allowed = new Set([context.source.sha256, ...context.runs.filter(run => run.status === 'SUCCEEDED').map(run => run.evidence?.projectSha256)])
        if (typeof selected !== 'string' || !allowed.has(selected)) throw new Error('工程不属于当前任务的输入或成功脚本产物')
        if (this.database.listActiveAttempts().length) throw new Error('本机有求解运行，请等待或取消后执行脚本')
        if (this.iterations.busy) throw new Error('自动迭代进行中，请等待或取消')
        const run = await this.manager.start({ taskId: task.id, scriptId: value.scriptId, parameters: object(value.parameters),
          projectSha256: selected, aedtVersion: context.aedtVersion })
        return { status: 202, body: { run } }
      }
    }
    throw new Error('未知动态脚本操作')
  }
  async close(): Promise<void> { await this.iterations.close(); await this.manager.close(); this.library.close() }
}
