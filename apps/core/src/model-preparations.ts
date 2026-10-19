import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'
import { parsePluginExecutionIdentity, createThermalModelSpec, NATURAL_CONVECTION_TEMPLATE, parseThermalModelSpec, THERMAL_MODEL_MATERIALS, validateThermalModelSpec } from '@thermal-agent/contracts'
import type { CadInspection, ModelPreparation, ModelPreparationJob, ModelPreparationContext, ModelPluginInput, ModelPluginResult, ThermalModelSpec } from '@thermal-agent/contracts'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import { ModelPreparationStore, type LocalDatabase } from '@thermal-agent/sqlite-store'
import { pinIcepakPlugin, type PinnedIcepakPlugin, type IcepakPluginPort } from './icepak-plugin-client.js'
import { TaskWorkspace } from './task-workspace.js'
import { IcepakOperationBusyError } from './icepak-operation-lock.js'

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class ModelPreparationConflict extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message) }
}
export class ModelPreparationManager {
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private readonly workspace: TaskWorkspace
  constructor(private readonly home: string, private readonly database: LocalDatabase, private readonly artifacts: ArtifactStore,
    readonly store: ModelPreparationStore, private readonly plugin: IcepakPluginPort) {
    this.workspace = new TaskWorkspace(home)
  }
  get busy() { return this.active.size > 0 }
  hasActiveTask(taskId: string) { return [...this.active.keys()].some(id => this.store.job(id)?.taskId === taskId) }
  private task(taskId: string, editable = false) {
    const task = this.database.getTask(taskId)
    if (!task) throw new ModelPreparationConflict('TASK_NOT_FOUND', '任务不存在', 404)
    if (editable && task.executionStatus !== 'DRAFT') throw new ModelPreparationConflict('DRAFT_REQUIRED', '建模操作仅允许在任务草稿阶段进行')
    return task
  }
  context(taskId: string): ModelPreparationContext {
    this.task(taskId)
    const operation = this.store.reconcileRecoveredOperation()
    return { inspections: this.store.inspections(taskId), draft: this.store.draft(taskId), preparations: this.store.preparations(taskId),
      jobs: this.store.jobs(taskId), materials: [...THERMAL_MODEL_MATERIALS], template: NATURAL_CONVECTION_TEMPLATE,
      recovery: operation?.recovery_required ? { operationId: operation.operation_id, method: operation.method,
        message: operation.worker_pid || JSON.parse(operation.resources_json).length ? '前次受管进程尚未确认退出，暂不能启动新的 Icepak 作业。进程退出后自动解除执行锁。' : '前次执行缺少进程身份记录，无法自动确认会话已关闭；需要在本机核查旧会话。' } : null }
  }
  assertSimulationInput(taskId: string) {
    const task = this.task(taskId)
    const bound = task.requirementSnapshot.simulationInput as { preparationId?: string; sha256?: string; specSha256?: string; validationSha256?: string; design?: string; setup?: string } | undefined
    const prep = bound?.preparationId ? this.store.preparation(bound.preparationId) : null
    if (!bound || !prep || prep.taskId !== taskId || prep.status !== 'VERIFIED' || bound.sha256 !== prep.projectSha256 ||
      bound.specSha256 !== prep.specSha256 || bound.validationSha256 !== prep.validationSha256 || task.requirementSnapshot.modelSha256 !== prep.projectSha256 || task.requirementSnapshot.aedtVersion !== prep.spec.aedtVersion ||
      task.requirementSnapshot.targetTmaxC !== prep.spec.targetTmaxC || bound.design !== prep.validatedDesign || bound.setup !== prep.validatedSetup) throw new ModelPreparationConflict('SIMULATION_INPUT_MISMATCH', '求解输入与已验证建模版本不一致，请重新选择版本')
    return prep
  }
  private duplicate(taskId: string, kind: ModelPreparationJob['kind'], requestId: string, input: Record<string, unknown>) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/u.test(requestId)) throw new ModelPreparationConflict('INVALID_REQUEST_ID', '请求 ID 必须为 8–100 个字母、数字、下划线或连字符', 400)
    const prior = this.store.requestedJob(taskId, kind, requestId)
    if (prior && prior.requestSha256 !== sha(input)) throw new ModelPreparationConflict('REQUEST_CONFLICT', '同一请求 ID 不能提交不同配置')
    return prior
  }
  private available() {
    this.store.reconcileRecoveredOperation()
    if (this.busy || this.store.operation() || this.database.listActiveAttempts().some(a => a.executorNodeId === this.database.getLocalIdentity()?.nodeId)) throw new IcepakOperationBusyError()
  }
  private newJob(taskId: string, kind: ModelPreparationJob['kind'], requestId: string, input: Record<string, unknown>, inspectionId: string, preparationId: string | null): ModelPreparationJob {
    const now = new Date().toISOString()
    const job: ModelPreparationJob = { id: randomUUID(), taskId, kind, requestId, requestSha256: sha(input), input, inspectionId, preparationId,
      status: 'QUEUED', stage: 'queued', artifacts: [], error: null, createdAt: now, updatedAt: now }
    this.store.createJob(job)
    return job
  }
  inspect(taskId: string, input: { requestId: string; version: string; healing: boolean }) {
    const task = this.task(taskId, true)
    const source = task.requirementSnapshot.sourceModel as { sha256?: string } | undefined
    const sourceSha = source?.sha256 ?? task.requirementSnapshot.modelSha256
    if (typeof sourceSha !== 'string') throw new ModelPreparationConflict('CAD_REQUIRED', '请先上传并绑定 CAD', 400)
    const artifact = this.database.getArtifact(sourceSha)
    if (!artifact || !['.step', '.stp'].includes(extname(artifact.originalName).toLowerCase())) throw new ModelPreparationConflict('UNSUPPORTED_FORMAT', '首版转换只支持 STEP/STP，其他格式仅可归档', 400)
    if (!/^20\d{2}\.[12]$/u.test(input.version) || typeof input.healing !== 'boolean') throw new ModelPreparationConflict('INVALID_IMPORT_OPTIONS', 'AEDT 版本或修复选项无效', 400)
    const operationInput = { version: input.version, healing: input.healing, sourceSha256: sourceSha }
    const prior = this.duplicate(taskId, 'INSPECT', input.requestId, operationInput)
    if (prior) return prior
    this.available()
    if (!this.plugin.inspectCad) throw new ModelPreparationConflict('PLUGIN_UNAVAILABLE', '插件尚不支持 CAD 导入', 501)
    const inspection: CadInspection = { id: randomUUID(), taskId, sourceSha256: sourceSha, version: input.version, healing: input.healing,
      status: 'QUEUED', catalog: null, projectSha256: null, catalogSha256: null, previewSha256: null, environment: null, createdAt: new Date().toISOString() }
    this.store.createInspection(inspection)
    const job = this.newJob(taskId, 'INSPECT', input.requestId, operationInput, inspection.id, null)
    this.run(job, async (root, options, plugin) => {
      const sourcePath = await this.artifacts.materialize(sourceSha, join(root, 'input', artifact.originalName))
      const outputDir = join(root, 'plugin')
      const result = await plugin.inspectCad!({ sourcePath, sourceSha256: sourceSha, inspectionId: inspection.id, version: input.version, healing: input.healing, outputDir }, options)
      this.checkResult(result, 'inspect_cad', sourceSha)
      if (result.environment?.aedtVersion !== inspection.version) throw new ModelPreparationConflict('ENVIRONMENT_MISMATCH', '导入结果的 AEDT 版本不一致')
      const catalog = result.catalog
      if (!catalog || catalog.inspectionId !== inspection.id || catalog.sourceSha256 !== sourceSha || !catalog.objects?.length ||
        !Array.isArray(catalog.diagnostics) || !catalog.units || new Set(catalog.objects.map(o => o.key)).size !== catalog.objects.length ||
        catalog.objects.some(o => !o.key || !o.name || !['Solid', 'Sheet', 'Line'].includes(o.type) || o.boundingBox?.length !== 6 || !o.boundingBox.every(Number.isFinite))) throw new ModelPreparationConflict('CATALOG_INVALID', '导入对象清单不完整或身份不一致')
      const links = await this.archive(result, outputDir, ['IMPORTED_PROJECT', 'OBJECT_CATALOG'])
      const catalogLink = links.find(a => a.role === 'OBJECT_CATALOG')!
      const persistedCatalog = JSON.parse(await readFile(this.artifacts.resolveArtifact(catalogLink.sha256), 'utf8'))
      if (JSON.stringify(persistedCatalog) !== JSON.stringify(catalog)) throw new ModelPreparationConflict('CATALOG_MISMATCH', '对象清单文件与返回数据不一致')
      this.store.updateJob(job.id, { artifacts: [...this.store.job(job.id)!.artifacts, ...links] })
      this.store.finishInspection(inspection.id, { status: 'SUCCEEDED', catalog, projectSha256: links.find(a => a.role === 'IMPORTED_PROJECT')!.sha256,
        catalogSha256: catalogLink.sha256, previewSha256: links.find(a => a.role === 'PREVIEW')?.sha256 ?? null, environment: result.environment })
    })
    return this.store.job(job.id)!
  }
  saveDraft(taskId: string, specValue: unknown, expectedVersion: number) {
    this.task(taskId, true)
    let spec: ThermalModelSpec
    try { spec = parseThermalModelSpec(specValue) } catch (e) { throw new ModelPreparationConflict('INVALID_SPEC', String((e as Error).message), 400) }
    const inspection = this.store.inspection(spec.inspectionId)
    if (!inspection || inspection.taskId !== taskId || inspection.status !== 'SUCCEEDED' || spec.sourceSha256 !== inspection.sourceSha256 || spec.catalogSha256 !== inspection.catalogSha256) throw new ModelPreparationConflict('INSPECTION_MISMATCH', '配置未关联当前任务的成功导入')
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new ModelPreparationConflict('INVALID_VERSION', '配置版本号无效', 400)
    try { return this.store.saveDraft(taskId, spec, expectedVersion) }
    catch (e) { throw new ModelPreparationConflict('DRAFT_CONFLICT', (e as Error).message) }
  }
  initialSpec(taskId: string, inspectionId: string) {
    this.task(taskId)
    const inspection = this.store.inspection(inspectionId)
    if (!inspection || inspection.taskId !== taskId) throw new ModelPreparationConflict('INSPECTION_MISMATCH', '导入记录不属于当前任务')
    return createThermalModelSpec(inspection)
  }
  prepare(taskId: string, input: { requestId: string; draftVersion: number }) {
    this.task(taskId, true)
    const normalized = { draftVersion: input.draftVersion }
    const prior = this.duplicate(taskId, 'PREPARE', input.requestId, normalized)
    if (prior) return prior
    this.available()
    if (!this.plugin.prepareModel) throw new ModelPreparationConflict('PLUGIN_UNAVAILABLE', '插件尚不支持热模型生成', 501)
    const draft = this.store.draft(taskId)
    if (!draft || draft.version !== input.draftVersion) throw new ModelPreparationConflict('DRAFT_CONFLICT', '配置版本已变化，请刷新后重试')
    const inspection = this.store.inspection(draft.spec.inspectionId)!
    const issues = validateThermalModelSpec(draft.spec, inspection)
    if (issues.length) throw new ModelPreparationConflict('SPEC_INCOMPLETE', issues.join('；'), 400)
    const now = new Date().toISOString()
    const preparation: ModelPreparation = { id: randomUUID(), taskId, revision: this.store.preparations(taskId).length + 1, inspectionId: inspection.id,
      spec: draft.spec, specSha256: sha(draft.spec), status: 'PREPARING', projectSha256: null, validationSha256: null, createdAt: now, updatedAt: now }
    this.store.createPreparation(preparation)
    const job = this.newJob(taskId, 'PREPARE', input.requestId, normalized, inspection.id, preparation.id)
    this.run(job, async (root, options, plugin) => {
      const specArtifact = await this.artifacts.putBytes(Buffer.from(JSON.stringify(draft.spec)), 'model-spec.json', 'application/json')
      this.database.upsertArtifact(specArtifact)
      if (specArtifact.sha256 !== preparation.specSha256) throw new Error('配置身份不一致')
      const pluginInput = await this.modelInput(preparation, inspection.projectSha256!, root)
      const result = await plugin.prepareModel!(pluginInput, options)
      this.checkResult(result, 'prepare_model', inspection.projectSha256!, preparation.specSha256)
      if (result.environment?.aedtVersion !== preparation.spec.aedtVersion) throw new ModelPreparationConflict('ENVIRONMENT_MISMATCH', '生成结果的 AEDT 版本不一致')
      const links = await this.archive(result, pluginInput.outputDir, ['GENERATED_PROJECT', 'PREPARATION_EVIDENCE'])
      links.push({ role: 'MODEL_SPEC', sha256: specArtifact.sha256, originalName: specArtifact.originalName })
      this.store.updateJob(job.id, { artifacts: [...this.store.job(job.id)!.artifacts, ...links] })
      this.store.updatePreparation(preparation.id, { status: 'PREPARED', projectSha256: links.find(a => a.role === 'GENERATED_PROJECT')!.sha256 })
    })
    return this.store.job(job.id)!
  }
  validate(taskId: string, preparationId: string, requestId: string) {
    this.task(taskId, true)
    const input = { preparationId }
    const prior = this.duplicate(taskId, 'VALIDATE', requestId, input)
    if (prior) return prior
    this.available()
    const prep = this.store.preparation(preparationId)
    if (!prep || prep.taskId !== taskId || !prep.projectSha256 || !['PREPARED', 'FAILED', 'INTERRUPTED', 'CANCELLED', 'VERIFIED'].includes(prep.status)) throw new ModelPreparationConflict('MODEL_NOT_PREPARED', '请先生成当前任务的工程')
    if (!this.plugin.validateModel) throw new ModelPreparationConflict('PLUGIN_UNAVAILABLE', '插件尚不支持热模型验证', 501)
    this.store.updatePreparation(prep.id, { status: 'VALIDATING' })
    const job = this.newJob(taskId, 'VALIDATE', requestId, input, prep.inspectionId, prep.id)
    this.run(job, async (root, options, plugin) => {
      const pluginInput = await this.modelInput(prep, prep.projectSha256!, root)
      const result = await plugin.validateModel!(pluginInput, options)
      this.checkResult(result, 'validate_model', prep.projectSha256!, prep.specSha256)
      if (result.environment?.aedtVersion !== prep.spec.aedtVersion) throw new ModelPreparationConflict('ENVIRONMENT_MISMATCH', '验证结果的 AEDT 版本不一致')
      const links = await this.archive(result, pluginInput.outputDir, ['VALIDATION_EVIDENCE', 'MESH_STATS'])
      this.store.updateJob(job.id, { artifacts: [...this.store.job(job.id)!.artifacts, ...links] })
      const verification = result.validation
      if (verification?.verified !== true || verification.meshGenerated !== true || verification.selfContained !== true || !verification.design || !verification.setup || !verification.checks.includes('persistedModelSpec')) throw new ModelPreparationConflict('VALIDATION_INCOMPLETE', '工程读回、自包含或网格检查未完整通过')
      const evidence = JSON.parse(await readFile(this.artifacts.resolveArtifact(links.find(a => a.role === 'VALIDATION_EVIDENCE')!.sha256), 'utf8'))
      if (evidence.inputSha256 !== prep.projectSha256 || evidence.specSha256 !== prep.specSha256 || JSON.stringify(evidence.validation) !== JSON.stringify(verification)) throw new ModelPreparationConflict('EVIDENCE_MISMATCH', '验证文件与工程身份或返回结果不一致')
      this.store.updatePreparation(prep.id, { status: 'VERIFIED', validationSha256: links.find(a => a.role === 'VALIDATION_EVIDENCE')!.sha256, validatedDesign: verification.design, validatedSetup: verification.setup })
    })
    return this.store.job(job.id)!
  }
  async activate(taskId: string, preparationId: string, expectedVersion: number) {
    const task = this.task(taskId, true)
    this.available()
    const prep = this.store.preparation(preparationId)
    if (!prep || prep.taskId !== taskId || prep.status !== 'VERIFIED' || !prep.projectSha256 || !prep.validationSha256) throw new ModelPreparationConflict('MODEL_NOT_VERIFIED', '必须选择验证通过的当前任务模型版本')
    const artifact = this.database.getArtifact(prep.projectSha256)!
    const evidence = JSON.parse(await readFile(this.artifacts.resolveArtifact(prep.validationSha256), 'utf8')) as ModelPluginResult
    const projectPath = await this.workspace.attachArtifact(taskId, artifact, this.artifacts)
    const sourceArtifact = this.database.getArtifact(prep.spec.sourceSha256)!
    const sourceModel = { kind: 'CAD', sha256: sourceArtifact.sha256, originalName: sourceArtifact.originalName }
    const simulationInput = { preparationId: prep.id, sha256: prep.projectSha256, specSha256: prep.specSha256, validationSha256: prep.validationSha256,
      design: evidence.validation!.design, setup: evidence.validation!.setup }
    // Retain existing AEDT intake fields for downstream compatibility; sourceModel retains original CAD identity.
    this.database.saveModelCapabilityAssessment({ modelSha256: prep.projectSha256, modelKind: 'AEDT', status: 'READY_FOR_BASELINE', checkedAt: new Date().toISOString(),
      aedtVersion: prep.spec.aedtVersion, projectName: basename(artifact.originalName, '.aedt'), activeDesign: simulationInput.design, setups: [simulationInput.setup], items: [], diagnostics: ['CAD 生成模型已通过持久化配置与网格检查；求解结果尚待验证。'] })
    return this.database.updateTaskDraft(taskId, task.title, task.description, { ...task.requirementSnapshot, intakeVersion: 2, sourceModel, simulationInput,
      modelKind: 'AEDT', modelSha256: artifact.sha256, modelOriginalName: artifact.originalName, projectPath, aedtVersion: prep.spec.aedtVersion,
      targetTmaxC: prep.spec.targetTmaxC, planConfirmed: true, selectedOptimizationSkillIds: [], autoFanRatio: undefined, fanSkillId: undefined,
      capabilityAssessment: this.database.getModelCapabilityAssessment(artifact.sha256), baselineMonitoringScope: 'SELECTED_OBJECT_CENTROIDS' }, expectedVersion)
  }
  private async modelInput(prep: ModelPreparation, projectSha256: string, root: string): Promise<ModelPluginInput> {
    const inspection = this.store.inspection(prep.inspectionId)!
    return { projectPath: await this.artifacts.materialize(projectSha256, join(root, 'input', 'Model.aedt')), projectSha256,
      catalog: inspection.catalog!, spec: prep.spec, specSha256: prep.specSha256, outputDir: join(root, 'plugin') }
  }
  private checkResult(result: ModelPluginResult, operation: ModelPluginResult['operation'], inputSha: string, specSha?: string) {
    if (result.status !== 'ok' || result.operation !== operation || result.inputSha256 !== inputSha || (specSha && result.specSha256 !== specSha)) throw new ModelPreparationConflict('RESULT_IDENTITY_MISMATCH', '插件结果身份不一致')
  }
  private async archive(result: ModelPluginResult, outputDir: string, required: string[]) {
    const root = await realpath(outputDir)
    const roles = new Set<string>()
    const links = []
    for (const artifact of result.artifacts) {
      if (roles.has(artifact.role)) throw new ModelPreparationConflict('DUPLICATE_ARTIFACT', '插件返回重复产物角色')
      roles.add(artifact.role)
      const path = await realpath(artifact.path)
      const local = relative(root, path)
      if (!local || local.startsWith('..') || resolve(root, local) !== path) throw new ModelPreparationConflict('INVALID_ARTIFACT_PATH', '插件产物必须位于本次输出目录')
      const info = await stat(path)
      if (!info.isFile() || info.size <= 0 || info.size > 2 * 1024 ** 3) throw new ModelPreparationConflict('INVALID_ARTIFACT', '插件产物为空或超出大小限制')
      if (artifact.role.endsWith('PROJECT') && extname(path).toLowerCase() !== '.aedt') throw new ModelPreparationConflict('INVALID_PROJECT', '工程产物必须为 .aedt')
      const stored = await this.artifacts.importFile(path)
      this.database.upsertArtifact(stored)
      links.push({ role: artifact.role, sha256: stored.sha256, originalName: stored.originalName })
    }
    if (required.some(role => !roles.has(role))) throw new ModelPreparationConflict('ARTIFACT_MISSING', '插件缺少必要的工程或验证产物')
    return links
  }
  private run(job: ModelPreparationJob, action: (root: string, options: { signal: AbortSignal; onProgress: (stage: string) => void }, plugin: IcepakPluginPort) => Promise<void>) {
    const controller = new AbortController()
    const root = join(this.workspace.ensure(job.taskId), 'model-preparations', job.preparationId ?? job.inspectionId, job.id)
    const promise = (async () => {
      this.store.updateJob(job.id, { status: 'RUNNING', stage: 'plugin_starting' })
      if (job.kind === 'INSPECT') this.store.finishInspection(job.inspectionId, { status: 'RUNNING' })
      let pinned: PinnedIcepakPlugin | undefined
      try {
        const predecessor = this.store.jobs(job.taskId).filter(previous => previous.status === 'SUCCEEDED' &&
          (job.kind === 'PREPARE' ? previous.kind === 'INSPECT' && previous.inspectionId === job.inspectionId :
            job.kind === 'VALIDATE' ? previous.kind === 'PREPARE' && previous.preparationId === job.preparationId : false)).at(-1)
        const identityLink = predecessor?.artifacts.find(artifact => artifact.role === 'PLUGIN_RUNTIME')
        const expected = identityLink ? parsePluginExecutionIdentity(JSON.parse(await readFile(this.artifacts.resolveArtifact(identityLink.sha256), 'utf8'))) : undefined
        pinned = await pinIcepakPlugin(this.plugin, expected)
        const identity = await this.artifacts.putBytes(Buffer.from(JSON.stringify(pinned.identity)), 'plugin-runtime.json', 'application/json')
        this.database.upsertArtifact(identity)
        this.store.updateJob(job.id, { artifacts: [{ role: 'PLUGIN_RUNTIME', sha256: identity.sha256, originalName: identity.originalName }] })
        await action(root, { signal: controller.signal, onProgress: stage => this.store.updateJob(job.id, { stage }) }, pinned.port)
        if (controller.signal.aborted) throw new Error('cancelled')
        this.store.updateJob(job.id, { status: 'SUCCEEDED', stage: 'completed' })
      } catch (error) {
        const status = controller.signal.aborted ? 'CANCELLED' : 'FAILED'
        const failure = { code: controller.signal.aborted ? 'CANCELLED' : String((error as { code?: string }).code ?? 'MODEL_OPERATION_FAILED'), message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }
        const current = this.store.job(job.id)!
        try {
          const artifact = await this.artifacts.putBytes(Buffer.from(JSON.stringify({ jobId: job.id, input: job.input, stage: current.stage, status, error: failure })), 'failure.json', 'application/json')
          this.database.upsertArtifact(artifact)
          this.store.updateJob(job.id, { artifacts: [...current.artifacts, { role: 'FAILURE_EVIDENCE', sha256: artifact.sha256, originalName: artifact.originalName }] })
        } catch { /* a full disk must still produce a terminal job state */ }
        this.store.updateJob(job.id, { status, stage: status.toLowerCase(), error: failure })
        if (job.kind === 'INSPECT') this.store.finishInspection(job.inspectionId, { status })
        else if (job.preparationId) this.store.updatePreparation(job.preparationId, { status })
      } finally { pinned?.release() }
    })()
    this.active.set(job.id, { controller, promise })
    void promise.finally(() => this.active.delete(job.id))
  }
  cancel(taskId: string, jobId: string) {
    this.task(taskId)
    const job = this.store.job(jobId)
    if (!job || job.taskId !== taskId) throw new ModelPreparationConflict('JOB_NOT_FOUND', '作业不属于当前任务', 404)
    const active = this.active.get(jobId)
    if (active) { this.store.updateJob(jobId, { stage: 'cancelling' }); active.controller.abort() }
    return this.store.job(jobId)!
  }
  cancelTaskJobs(taskId: string) {
    this.task(taskId)
    for (const id of this.active.keys()) if (this.store.job(id)?.taskId === taskId) this.cancel(taskId, id)
  }
  async close() {
    for (const a of this.active.values()) a.controller.abort()
    await Promise.allSettled([...this.active.values()].map(a => a.promise))
  }
}
