import { join, relative, resolve, sep } from 'node:path'
import { lstat, realpath, readFile } from 'node:fs/promises'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import type { ArtifactRecord, IcepakProjectOperationResult } from '@thermal-agent/contracts'
import { DynamicScriptLibrary } from './dynamic-script-library.js'
import { DynamicScriptManager } from './dynamic-script-manager.js'
import { parseIterationPlan, nextIterationParameters, type ScriptIteration, type ScriptIterationRound } from './dynamic-script-search.js'
import { pinIcepakPlugin, type PinnedIcepakPlugin, type IcepakPluginPort } from './icepak-plugin-client.js'
import { TaskWorkspace } from './task-workspace.js'
import { provesIcepakSolve } from './icepak-readiness.js'

/** Internal executor. Only a local user action may approve/start a persisted bounded plan. */
export class DynamicScriptIterations {
  private readonly workspace: TaskWorkspace
  private starting = false
  private closing = false
  private active?: { id: string; controller: AbortController; promise: Promise<void> }
  constructor(home: string, private readonly library: DynamicScriptLibrary, private readonly scripts: DynamicScriptManager,
    private readonly artifacts: ArtifactStore, private readonly plugin: IcepakPluginPort,
    private readonly recordArtifact?: (artifact: ArtifactRecord) => void, private readonly checkAuthorization?: (job: ScriptIteration) => void) { this.workspace = new TaskWorkspace(home) }
  get busy(): boolean { return this.starting || !!this.active }
  draft(taskId: string, projectSha256: string, aedtVersion: string, value: unknown): ScriptIteration {
    this.workspace.taskDir(taskId)
    if (!/^[a-f0-9]{64}$/u.test(projectSha256)) throw new Error('Invalid iteration project digest')
    const scriptId = value && typeof value === 'object' ? (value as { scriptId?: string }).scriptId : undefined
    const script = this.library.get(String(scriptId))
    if (script.disabled || !script.applicability.aedtVersions.includes(aedtVersion)) throw new Error('Script is disabled or incompatible')
    return this.library.createIteration({ taskId, projectSha256, aedtVersion, plan: parseIterationPlan(value, script) })
  }
  async start(id: string, approvedTaskVersion: number): Promise<ScriptIteration> {
    if (this.closing || this.busy || this.scripts.busy) throw new Error('Dynamic execution is busy or closing')
    if (!Number.isInteger(approvedTaskVersion) || approvedTaskVersion < 1) throw new Error('Task version approval is required')
    this.starting = true
    let pinned: PinnedIcepakPlugin | undefined
    try {
      let job = this.library.iteration(id)
      if (job.status !== 'DRAFT') throw new Error('Only a new draft can be started')
      const script = this.library.get(job.plan.scriptId)
      if (script.disabled) throw new Error('Script is disabled')
      parseIterationPlan(job.plan, script)
      pinned = await pinIcepakPlugin(this.plugin)
      if (this.closing) throw new Error('Iteration manager is closing')
      job = this.library.saveIteration({ ...job, status: 'RUNNING', startedAt: new Date().toISOString(), runtime: pinned.identity, approvedTaskVersion })
      const controller = new AbortController(), lease = pinned
      pinned = undefined
      const promise = this.execute(job, lease, controller).finally(() => { this.active = undefined })
      this.active = { id, controller, promise }
      void promise.catch(() => undefined)
      return job
    } finally { pinned?.release(); this.starting = false }
  }
  cancel(id: string): void {
    if (this.active?.id !== id) throw new Error('Iteration is not active')
    this.active.controller.abort()
  }
  async wait(id: string): Promise<ScriptIteration> {
    if (this.active?.id === id) await this.active.promise
    return this.library.iteration(id)
  }
  recoverInterrupted(): void {
    if (this.busy) return
    for (const job of this.library.iterations()) if (job.status === 'RUNNING') {
      this.library.saveIteration({ ...job, status: 'STOPPED', stopReason: 'INTERRUPTED', finishedAt: new Date().toISOString(),
        rounds: job.rounds.map(round => ['APPLYING', 'SOLVING'].includes(round.status) ? { ...round, status: 'FAILED', error: 'Core interrupted before completion' } : round) })
    }
  }
  async close(): Promise<void> { this.closing = true; this.active?.controller.abort(); await this.active?.promise.catch(() => undefined) }
  private async capture(path: string, root: string, name?: string, type?: string): Promise<ArtifactRecord> {
    const absolute = resolve(path), base = resolve(root), suffix = relative(base, absolute)
    if (!suffix || suffix.startsWith(`..${sep}`) || suffix === '..' || resolve(base, suffix) !== absolute) throw new Error('Solver artifact is outside the operation directory')
    const canonical = await realpath(base)
    if ((await lstat(absolute)).isSymbolicLink() || await realpath(absolute) !== join(canonical, suffix)) throw new Error('Solver artifact is a linked or unexpected file')
    const artifact = await this.artifacts.importFile(absolute, name, type)
    this.recordArtifact?.(artifact)
    return artifact
  }
  private async saveSolve(job: ScriptIteration, round: ScriptIterationRound, result: IcepakProjectOperationResult, output: string): Promise<void> {
    // Store failed solver replies too, so a rejected result remains inspectable.
    const receipt = await this.artifacts.putBytes(Buffer.from(JSON.stringify({ iterationId: job.id, round: round.number,
      runtime: job.runtime, inputSha256: round.scriptProjectSha256, result })), 'iteration-solve.json', 'application/json')
    this.recordArtifact?.(receipt); round.resultSha256 = receipt.sha256
    if (!provesIcepakSolve(result, job.aedtVersion) || result.inputSha256 !== round.scriptProjectSha256 ||
      result.solve?.setup !== job.plan.setup || job.plan.design && result.project.activeDesign !== job.plan.design ||
      result.metrics?.converged !== true || typeof result.metrics?.tmaxC !== 'number' || !Number.isFinite(result.metrics.tmaxC)) throw new Error('Solver result lacks matching setup, converged metrics or normal-completion evidence')
    if (typeof result.artifacts?.projectPath !== 'string' || typeof result.artifacts?.convergencePath !== 'string') throw new Error('Solver did not return persisted project and convergence artifacts')
    const project = await this.capture(result.artifacts.projectPath, output)
    if (project.sha256 !== result.artifacts.outputSha256) throw new Error('Solved project digest mismatch')
    const convergence = await this.capture(result.artifacts.convergencePath, output, 'convergence.json', 'application/json')
    const bundle = JSON.parse(await readFile(this.artifacts.resolveArtifact(convergence.sha256), 'utf8'))
    if (bundle.schemaVersion !== 'icepak-convergence-v1' || bundle.setup !== job.plan.setup || bundle.evidence?.verified !== true) throw new Error('Persisted convergence evidence is invalid')
    const rawArtifacts: ArtifactRecord[] = []
    for (const [name, path] of Object.entries(bundle.nativeEvidencePaths ?? {})) {
      if (typeof path !== 'string') throw new Error('Invalid native evidence path')
      const raw = await this.capture(path, output)
      if (raw.sha256 !== bundle.rawFileSha256?.[name]) throw new Error('Native evidence digest mismatch')
      rawArtifacts.push(raw)
    }
    const complete = await this.artifacts.putBytes(Buffer.from(JSON.stringify({ iterationId: job.id, round: round.number,
      runtime: job.runtime, parameters: round.parameters, executionKind: round.executionKind,
      project, convergence, rawArtifacts, solverResultSha256: receipt.sha256, result })), 'iteration-evidence.json', 'application/json')
    this.recordArtifact?.(complete)
    round.resultSha256 = complete.sha256
    round.solvedProjectSha256 = project.sha256
    round.tmaxC = result.metrics.tmaxC
  }
  private async execute(initial: ScriptIteration, pinned: PinnedIcepakPlugin, controller: AbortController): Promise<void> {
    let job = initial
    let timedOut = false
    const deadline = Date.parse(job.startedAt!) + job.plan.maxDurationMs
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, job.plan.maxDurationMs)
    const checkpoint = () => {
      this.checkAuthorization?.(job)
      if (Date.now() >= deadline) { timedOut = true; controller.abort() }
      if (controller.signal.aborted) throw new Error(timedOut ? 'Iteration time budget exhausted' : 'Iteration cancelled')
    }
    const save = () => { job = this.library.saveIteration(job) }
    const stop = (reason: NonNullable<ScriptIteration['stopReason']>) => {
      job.status = 'STOPPED'; job.stopReason = reason; job.finishedAt = new Date().toISOString(); save()
    }
    try {
      while (job.rounds.length < job.plan.maxRounds) {
        checkpoint()
        const parameters = nextIterationParameters(job.plan, job.rounds)
        if (!parameters) { stop('SEARCH_EXHAUSTED'); return }
        job.rounds.push({ number: job.rounds.length + 1, parameters, status: 'APPLYING', startedAt: new Date().toISOString() })
        save()
        const index = job.rounds.length - 1
        const applied = await this.scripts.start({ taskId: job.taskId, scriptId: job.plan.scriptId, parameters,
          projectSha256: job.projectSha256, aedtVersion: job.aedtVersion, design: job.plan.design }, { expectedRuntime: pinned.identity, signal: controller.signal })
        job.rounds[index].scriptRunId = applied.id; save()
        const completed = await this.scripts.wait(applied.id)
        checkpoint()
        if (completed.status !== 'SUCCEEDED' || !completed.evidence) throw new Error(completed.error ?? 'Script application failed')
        job.rounds[index].scriptProjectSha256 = completed.evidence.projectSha256
        job.rounds[index].executionKind = completed.evidence.kind
        job.rounds[index].status = 'SOLVING'; save()
        const root = join(this.workspace.ensure(job.taskId), 'script-iterations', job.id, String(index + 1))
        const projectPath = await this.artifacts.materialize(completed.evidence.projectSha256, join(root, 'input', 'project.aedt'))
        checkpoint()
        const outputDir = join(root, 'solve')
        const result = await pinned.port.solveProject({ projectPath, outputDir, version: job.aedtVersion,
          design: job.plan.design, setup: job.plan.setup, cores: job.plan.cores,
          expectedProfile: { artifact: { sha256: completed.evidence.projectSha256 }, aedtVersion: job.aedtVersion, setup: job.plan.setup, ...(job.plan.design ? { design: job.plan.design } : {}) } },
          { signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()) })
        checkpoint()
        await this.saveSolve(job, job.rounds[index], result, outputDir)
        checkpoint()
        const round = job.rounds[index]
        round.status = 'SUCCEEDED'; round.finishedAt = new Date().toISOString()
        if (!job.bestRound || round.tmaxC! < job.rounds[job.bestRound - 1].tmaxC!) job.bestRound = round.number
        save()
        if (job.rounds[index].tmaxC! <= job.plan.targetTmaxC) { stop('TARGET_REACHED'); return }
      }
      stop('ROUND_LIMIT')
    } catch (error) {
      job.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
      const round = job.rounds.at(-1)
      if (round && ['APPLYING', 'SOLVING'].includes(round.status)) {
        round.status = controller.signal.aborted ? 'CANCELLED' : 'FAILED'; round.error = job.error; round.finishedAt = new Date().toISOString()
      }
      stop(timedOut ? 'TIME_LIMIT' : controller.signal.aborted ? 'CANCELLED' : 'EXECUTION_FAILED')
    } finally { clearTimeout(timer); pinned.release() }
  }
}
