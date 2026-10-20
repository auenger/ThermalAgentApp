import { basename, join, resolve } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import type { DynamicScriptResult } from '@thermal-agent/contracts'
import { pinIcepakPlugin, type IcepakPluginPort, type PinnedIcepakPlugin } from './icepak-plugin-client.js'
import { DynamicScriptLibrary, resolveScriptParameters, type ScriptRun } from './dynamic-script-library.js'
import { TaskWorkspace } from './task-workspace.js'

/** Caller resolves a locally owned task and its project artifact before starting. Not an HTTP request contract. */
export interface DynamicScriptTaskInput {
  taskId: string
  scriptId: string
  parameters: Record<string, unknown>
  projectSha256: string
  aedtVersion: string
  design?: string
}
export class DynamicScriptManager {
  private readonly workspace: TaskWorkspace
  private starting = false
  private closing = false
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  constructor(home: string, private readonly library: DynamicScriptLibrary,
    private readonly artifacts: ArtifactStore, private readonly plugin: IcepakPluginPort) {
    this.workspace = new TaskWorkspace(home)
  }
  get busy(): boolean { return this.starting || this.active.size > 0 }
  async start(input: DynamicScriptTaskInput): Promise<ScriptRun> {
    if (this.closing || this.busy) throw new Error('Dynamic script execution is busy or closing')
    this.starting = true
    let pinned: PinnedIcepakPlugin | undefined
    try {
      const request = structuredClone(input)
      this.workspace.taskDir(request.taskId)
      const script = this.library.get(request.scriptId)
      resolveScriptParameters(script, request.parameters)
      // Pin before recording, so receipts and all calls refer to the same runtime revision.
      pinned = await pinIcepakPlugin(this.plugin)
      if (this.closing) throw new Error('Dynamic script manager is closing')
      if (!pinned.port.executeScript) throw new Error('Icepak plugin does not support dynamic scripts')
      const run = this.library.beginRun({ ...request, runtime: pinned.identity })
      const controller = new AbortController()
      const lease = pinned
      pinned = undefined
      const promise = this.execute(run, request.design, lease, controller).finally(() => this.active.delete(run.id))
      this.active.set(run.id, { controller, promise })
      void promise.catch(() => undefined) // wait/close observe persistence failures; never create an unhandled rejection
      return run
    } finally { pinned?.release(); this.starting = false }
  }
  cancel(id: string): void {
    const active = this.active.get(id)
    if (!active) throw new Error('Script run is not active')
    active.controller.abort()
  }
  async wait(id: string): Promise<ScriptRun> {
    await this.active.get(id)?.promise
    return this.library.getRun(id)
  }
  async close(): Promise<void> {
    this.closing = true
    for (const item of this.active.values()) item.controller.abort()
    await Promise.allSettled([...this.active.values()].map(item => item.promise))
  }
  private async execute(run: ScriptRun, design: string | undefined, pinned: PinnedIcepakPlugin, controller: AbortController): Promise<void> {
    const abort = () => { if (controller.signal.aborted) throw new Error('Script run cancelled') }
    try {
      const script = this.library.get(run.scriptId)
      if (script.disabled) throw new Error('Script revision is disabled')
      const root = join(this.workspace.ensure(run.taskId), 'dynamic-scripts', run.id)
      const projectPath = await this.artifacts.materialize(run.projectSha256, join(root, 'input', 'project.aedt'))
      abort()
      const inspected = await pinned.port.inspectProject({ projectPath, outputDir: join(root, 'inspect'), version: run.aedtVersion, design }, { signal: controller.signal })
      abort()
      if (inspected.status !== 'ok' || inspected.inputSha256 !== run.projectSha256 || inspected.project.aedtVersion !== run.aedtVersion) throw new Error('Project inspection did not match the requested source and AEDT version')
      const missing = script.applicability.requiredObjects.filter(name => !inspected.project.objects.includes(name))
      if (missing.length) throw new Error(`Required project objects are missing: ${missing.join(', ')}`)
      const outputDir = join(root, 'execute')
      const result = await pinned.port.executeScript!({ projectPath, projectSha256: run.projectSha256,
        outputDir, version: run.aedtVersion, design, source: script.source, scriptSha256: script.sourceSha256,
        parameters: run.parameters }, { signal: controller.signal })
      abort()
      await this.complete(run, result, outputDir, script.sourceSha256, controller.signal)
    } catch (error) {
      this.library.finish(run.id, { status: controller.signal.aborted ? 'CANCELLED' : 'FAILED',
        error: error instanceof Error ? error.message : String(error) })
    } finally { pinned.release() }
  }
  private async complete(run: ScriptRun, result: DynamicScriptResult, outputDir: string, sourceSha256: string, signal: AbortSignal): Promise<void> {
    if (result.status !== 'ok' || result.scriptSha256 !== sourceSha256 || result.inputSha256 !== run.projectSha256 ||
      result.scriptExecuted !== true || result.persistedReadback !== true || result.readback?.passed !== true ||
      !Array.isArray(result.readback.checks) || !result.readback.checks.length || result.readbackEvidenceSource !== 'script-reported-after-reopen' ||
      !['native-aedt', 'test-double'].includes(result.executionKind) || JSON.stringify(result.parameters) !== JSON.stringify(run.parameters)) throw new Error('Dynamic script returned mismatched or incomplete evidence')
    const verified = join(outputDir, 'verified', 'project.aedt')
    if (resolve(result.verifiedProjectPath) !== resolve(verified)) throw new Error('Dynamic script returned an unexpected project path')
    // Do not import a symlink target or a project from outside this operation directory.
    const canonicalOutput = await realpath(outputDir)
    for (const path of [outputDir, join(outputDir, 'verified'), verified]) {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Unexpected linked script artifact')
    }
    if (await realpath(verified) !== join(canonicalOutput, 'verified', 'project.aedt')) throw new Error('Unexpected linked script artifact')
    const project = await this.artifacts.importFile(verified, basename(verified))
    if (project.sha256 !== result.verifiedProjectSha256) throw new Error('Verified project digest mismatch')
    // Receipt is constructed by Core and stored content-addressed. Script self-reports remain labelled.
    const evidence = await this.artifacts.putBytes(Buffer.from(JSON.stringify({ schemaVersion: 1, runId: run.id,
      taskId: run.taskId, scriptId: run.scriptId, runtime: run.runtime, parameters: run.parameters,
      inputSha256: run.projectSha256, project, result })), 'dynamic-script-receipt.json', 'application/json')
    if (signal.aborted) throw new Error('Script run cancelled')
    this.library.finish(run.id, { status: 'SUCCEEDED', evidence: { kind: result.executionKind,
      level: 'script-reported-readback', projectSha256: project.sha256, artifactSha256: evidence.sha256 } })
  }
}
