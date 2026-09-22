import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { realpath, stat } from 'node:fs/promises'
import { basename, extname, join, sep } from 'node:path'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { createTask } from '@thermal-agent/domain'
import type { ArtifactRecord } from '@thermal-agent/contracts'
import { parseCreateTaskInput, parseIcepakProjectOperationInput, parseOptimizationSkillInput, parseUpdateOptimizationSkillInput } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import type { IcepakPluginPort } from './icepak-plugin-client.js'
import type { DshBridgeAddress } from './dsh-host.js'
import { recommendOptimizationSkills } from './optimization-recommender.js'
import { CAD_EXTENSIONS } from './model-capabilities.js'
import { TaskWorkspace } from './task-workspace.js'

export class ThermalToolsBridge {
  private server?: Server
  private readonly token = randomBytes(32).toString('hex')
  private dshControlPort?: number
  private readonly artifacts: ArtifactStore
  private readonly workspace: TaskWorkspace

  clearDshControl(): void { this.dshControlPort = undefined }

  async dshSessionRequest<T>(path: 'list' | 'create' | 'archive', value: Record<string, unknown> = {}): Promise<T> {
    const deadline = Date.now() + 5_000
    while (!this.dshControlPort && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 100))
    if (!this.dshControlPort) throw new Error('DSH session control is not ready')
    const response = await fetch(`http://127.0.0.1:${this.dshControlPort}/v1/${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value), signal: AbortSignal.timeout(10_000),
    })
    const body = await response.json() as { result?: T; error?: string }
    if (!response.ok || body.result === undefined) throw new Error(body.error ?? `DSH session request failed (${response.status})`)
    return body.result
  }

  constructor(
    private readonly home: string,
    private readonly database: LocalDatabase,
    private readonly icepak: IcepakPluginPort,
    private readonly nodeId: string,
  ) {
    this.artifacts = new ArtifactStore(join(home, 'artifacts'))
    this.workspace = new TaskWorkspace(home)
  }

  async start(): Promise<DshBridgeAddress> {
    if (this.server) throw new Error('Thermal tools bridge is already running')
    const server = createServer((request, response) => {
      if (!this.authorized(request)) {
        writeJson(response, 401, { error: 'unauthorized' })
        return
      }
      void this.route(request, response).catch(error => {
        writeJson(response, 409, { error: error instanceof Error ? error.message.slice(0, 500) : 'bridge operation failed' })
      })
    })
    this.server = server
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Thermal tools bridge has no TCP address')
    return { url: `http://127.0.0.1:${address.port}`, token: this.token }
  }

  async stop(): Promise<void> {
    this.clearDshControl()
    const server = this.server
    this.server = undefined
    if (!server?.listening) return
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  }

  private authorized(request: IncomingMessage): boolean {
    const provided = request.headers.authorization?.replace(/^Bearer /u, '') ?? ''
    const expectedBuffer = Buffer.from(this.token)
    const providedBuffer = Buffer.from(provided)
    return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer)
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'POST' && url.pathname === '/v1/dsh-control/register') {
      const input = await readJson(request, 256)
      if (!isObject(input) || !Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535) throw new Error('Invalid DSH control port')
      this.dshControlPort = Number(input.port)
      writeJson(response, 200, { registered: true })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/tasks') {
      writeJson(response, 200, { tasks: this.database.listTasks(200) })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/skills') {
      writeJson(response, 200, { skills: this.database.listSkills().filter(skill => skill.kind === 'WORKFLOW' && skill.status === 'ENABLED') })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/optimization/skills/create') {
      const input = parseOptimizationSkillInput(await readJson(request, 32_000))
      writeJson(response, 201, { skill: this.database.createOptimizationSkill(input, 'agent') })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/optimization/skills/update') {
      const value = await readJson(request, 32_000)
      if (!isObject(value) || typeof value.skillId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value.skillId)) throw new Error('skillId must be a UUID')
      const input = parseUpdateOptimizationSkillInput(value)
      writeJson(response, 200, { skill: this.database.updateOptimizationSkill(value.skillId, input) })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/optimization/recommendations') {
      const input = await readJson(request, 16_000)
      if (!isObject(input) || typeof input.requirement !== 'string' || input.requirement.length > 12_000) throw new Error('Invalid optimization requirement')
      writeJson(response, 200, { recommendations: recommendOptimizationSkills(this.database, input.requirement), basis: 'keyword-pre-screening; all diagnostics and temperature drops are unverified' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/tasks/detail') {
      const taskId = url.searchParams.get('id') ?? ''
      const task = this.database.getTask(taskId)
      if (!task) throw new Error('task was not found')
      const runs = this.database.listTaskRuns(task.id).map(run => ({
        ...run,
        attempts: this.database.listRunAttempts(run.id).map(attempt => ({
          ...attempt,
          artifacts: this.database.listAttemptArtifacts(attempt.id),
        })),
      }))
      writeJson(response, 200, { task, runs, events: this.database.listTaskEvents(task.id) })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/tasks') {
      const value = await readJson(request, 32_000)
      if (!isObject(value)) throw new Error('task input must be an object')
      const files = await this.importConversationFiles(value.uploadedFiles)
      const modelFiles = files.filter(file => file.modelKind)
      const selectedModel = modelFiles.length === 1 ? modelFiles[0] : undefined
      const taskId = randomUUID()
      const taskWorkspacePath = this.workspace.ensure(taskId)
      const conversationAttachments = await Promise.all(files.map(async file => ({
        sha256: file.sha256, originalName: file.originalName, sizeBytes: file.sizeBytes,
        taskPath: await this.workspace.attachArtifact(taskId, file, this.artifacts),
      })))
      const modelPath = selectedModel && conversationAttachments.find(file => file.sha256 === selectedModel.sha256)?.taskPath
      const requirementSnapshot = {
        intakeVersion: 2,
        ...Object.fromEntries(['customer', 'projectName', 'productModel', 'workCondition', 'criticalPoints', 'adjustmentBounds']
          .filter(key => typeof value[key] === 'string' && String(value[key]).trim())
          .map(key => [key, String(value[key]).trim().slice(0, 4_000)])),
        ...(typeof value.aedtVersion === 'string' && value.aedtVersion.trim() ? { aedtVersion: value.aedtVersion.trim() } : {}),
        ...(typeof value.targetTmaxC === 'number' ? { targetTmaxC: value.targetTmaxC } : {}),
        selectedOptimizationSkillIds: [],
        planConfirmed: false,
        source: 'dsh-natural-language',
        taskWorkspacePath,
        ...(typeof value.sourceSessionId === 'string' && /^[0-9a-z_-]{1,100}$/iu.test(value.sourceSessionId) ? { sourceSessionId: value.sourceSessionId } : {}),
        conversationAttachments,
        ...(selectedModel && modelPath ? {
          modelSha256: selectedModel.sha256, modelOriginalName: selectedModel.originalName,
          modelKind: selectedModel.modelKind, projectPath: selectedModel.modelKind === 'AEDT' ? modelPath : undefined,
          cadSourcePath: selectedModel.modelKind === 'CAD' ? modelPath : undefined,
          capabilityAssessment: this.database.getModelCapabilityAssessment(selectedModel.sha256),
        } : {}),
      }
      const input = parseCreateTaskInput({
        title: value.title,
        description: value.description,
        ownerNodeId: this.nodeId,
        requirementSnapshot,
      })
      const hypotheses = recommendOptimizationSkills(this.database, `${input.title}\n${input.description}`).filter(item => item.suggested)
      writeJson(response, 201, { task: this.database.createTask(createTask({ ...input, requirementSnapshot: {
        ...input.requirementSnapshot,
        optimizationHypotheses: hypotheses.map(item => ({ skillKey: item.key, matchedSignals: item.matchedSignals, evidenceStatus: item.evidenceStatus })),
        optimizationSuggestions: hypotheses,
      } }, undefined, taskId)) })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/icepak/probe') {
      writeJson(response, 200, { probe: await this.icepak.probeEnvironment() })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/icepak/inspect') {
      const input = parseIcepakProjectOperationInput(await readJson(request, 32_000))
      const outputDir = join(this.home, 'runs', 'dsh-inspect', randomUUID())
      writeJson(response, 200, { result: await this.icepak.inspectProject({ ...input, outputDir }) })
      return
    }
    writeJson(response, 404, { error: 'route not found' })
  }

  private async importConversationFiles(value: unknown) {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 16) throw new Error('uploadedFiles must contain at most 16 files')
    const imported: Array<ArtifactRecord & { modelKind?: 'AEDT' | 'CAD' }> = []
    const attachmentRoot = join(this.home, 'dsh', 'attachments', 'v1', 'files')
    for (const ref of value) {
      if (!isObject(ref) || typeof ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(ref.attachmentId) ||
        typeof ref.name !== 'string' || !ref.name || ref.name !== basename(ref.name) || /[/\\\0]/u.test(ref.name) ||
        typeof ref.bytes !== 'number' || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > 2 * 1024 * 1024 * 1024) {
        throw new Error('uploaded file reference is invalid')
      }
      const sha = ref.attachmentId.slice(7)
      const path = join(attachmentRoot, sha.slice(0, 2), sha, ref.name)
      const actual = await realpath(path)
      const root = await realpath(attachmentRoot)
      if (!actual.startsWith(`${root}${sep}`)) throw new Error('uploaded file is outside the DSH attachment store')
      const info = await stat(actual)
      if (!info.isFile() || info.size !== ref.bytes) throw new Error('uploaded file size does not match its reference')
      const artifact = await this.artifacts.importFile(actual, ref.name)
      if (artifact.sha256 !== sha || artifact.sizeBytes !== ref.bytes) throw new Error('uploaded file hash does not match its reference')
      this.database.upsertArtifact(artifact)
      const extension = extname(ref.name).toLowerCase()
      const modelKind = extension === '.aedt' ? 'AEDT' : CAD_EXTENSIONS.has(extension) ? 'CAD' : undefined
      imported.push({ ...artifact, modelKind })
    }
    return imported
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch {
    throw new Error('request body is not valid JSON')
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}
