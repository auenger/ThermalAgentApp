import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { parseCreateSkillRunInput, parseCreateTaskInput, parseExpectedVersionInput, parseIcepakCandidateInput, parseIcepakProjectOperationInput, parseSkillReviewInput, parseTaskApprovalDecisionInput, parseTaskTransitionInput } from '@thermal-agent/contracts'
import { createTask, InvalidTaskTransitionError } from '@thermal-agent/domain'
import { LocalDatabase, SkillConflictError, SkillNotFoundError, TaskApprovalConflictError, TaskNotFoundError, VersionConflictError } from '@thermal-agent/sqlite-store'
import { IcepakPluginClient, type IcepakPluginPort } from './icepak-plugin-client.js'
import { IcepakExecutionManager } from './execution-manager.js'
import { DshRuntime } from './dsh-runtime.js'
import { SkillPublisher } from './skill-publisher.js'
import { CoreEventStream } from './event-stream.js'
import { LanPublisher } from './lan-publisher.js'

export interface CoreAppOptions {
  home: string
  pluginClient?: IcepakPluginPort
  webRoot?: string
  startAgentRuntime?: boolean
}

export interface CoreApp {
  server: Server
  database: LocalDatabase
  artifacts: ArtifactStore
  close(): Promise<void>
}

export function createCoreApp(options: CoreAppOptions): CoreApp {
  const home = resolve(options.home)
  mkdirSync(home, { recursive: true })
  const database = new LocalDatabase(join(home, 'data', 'thermal.db'))
  const artifacts = new ArtifactStore(join(home, 'artifacts'))
  const pluginClient = options.pluginClient ?? new IcepakPluginClient()
  const executions = new IcepakExecutionManager(home, database, artifacts, pluginClient)
  const agentRuntime = new DshRuntime(home, database, pluginClient)
  const skillPublisher = new SkillPublisher(join(home, 'workspace'))
  const eventStream = new CoreEventStream(database)
  if (options.startAgentRuntime !== false) void agentRuntime.start()
  const webRoot = resolve(options.webRoot ?? process.env.THERMAL_AGENT_WEB_ROOT ?? 'apps/web/dist')

  let lanPublisher: LanPublisher
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void route(request, response, database, pluginClient, executions, agentRuntime, skillPublisher, eventStream, lanPublisher, webRoot, home).catch(error => writeError(response, error))
  }
  const server = createServer(handler)
  lanPublisher = new LanPublisher(handler)

  return {
    server,
    database,
    artifacts,
    async close() {
      await lanPublisher.stop()
      eventStream.close()
      await new Promise<void>((resolveClose, reject) => {
        if (!server.listening) { resolveClose(); return }
        server.close(error => error ? reject(error) : resolveClose())
      })
      await executions.close()
      await agentRuntime.close()
      database.close()
    },
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  database: LocalDatabase,
  pluginClient: IcepakPluginPort,
  executions: IcepakExecutionManager,
  agentRuntime: DshRuntime,
  skillPublisher: SkillPublisher,
  eventStream: CoreEventStream,
  lanPublisher: LanPublisher,
  webRoot: string,
  home: string,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/api/health') {
    writeJson(response, 200, { status: 'ok', service: 'thermal-agent-core', version: '0.1.0' })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/events') {
    eventStream.subscribe(response)
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/lan/status') {
    const local = isLoopbackAddress(request.socket.remoteAddress)
    writeJson(response, 200, { lan: lanPublisher.status(local) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/lan/start') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'LAN publishing can only be managed from the local App')
    const value = await readJsonBody(request)
    const port = typeof value === 'object' && value !== null && 'port' in value ? Number(value.port) : 43111
    writeJson(response, 200, { lan: await lanPublisher.start(port) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/lan/stop') {
    if (!isLoopbackAddress(request.socket.remoteAddress)) throw new RequestError(403, 'LOCAL_ONLY', 'LAN publishing can only be managed from the local App')
    await lanPublisher.stop()
    writeJson(response, 200, { lan: lanPublisher.status(false) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/agent/status') {
    writeJson(response, 200, { agent: agentRuntime.getStatus() })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/agent/restart') {
    await agentRuntime.restart()
    writeJson(response, 202, { agent: agentRuntime.getStatus() })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/skills') {
    writeJson(response, 200, { skills: database.listSkills() })
    return
  }
  const skillMatch = url.pathname.match(/^\/api\/skills\/([0-9a-f-]+)$/iu)
  if (request.method === 'GET' && skillMatch) {
    const skill = database.getSkill(skillMatch[1])
    if (!skill) throw new SkillNotFoundError(skillMatch[1])
    writeJson(response, 200, { skill })
    return
  }
  const skillRunMatch = url.pathname.match(/^\/api\/skills\/([0-9a-f-]+)\/runs$/iu)
  if (request.method === 'POST' && skillRunMatch) {
    const input = parseCreateSkillRunInput(await readJsonBody(request))
    const skill = database.getSkill(skillRunMatch[1])
    if (!skill) throw new SkillNotFoundError(skillRunMatch[1])
    if (skill.status !== 'ENABLED') throw new SkillConflictError('skill must be ENABLED before it can run')
    const probe = await pluginClient.probeEnvironment()
    if (!['LAUNCHABLE', 'PROJECT_COMPATIBLE', 'READY'].includes(probe.status)) {
      throw new RequestError(409, 'ICEPAK_NOT_LAUNCHABLE', `Icepak environment is ${probe.status}`)
    }
    const inspectOutput = join(home, 'runs', 'skill-inspect', randomUUID())
    const inspection = await pluginClient.inspectProject({
      projectPath: input.projectPath, version: input.version, outputDir: inspectOutput,
    })
    if (!inspection.validation.verified) throw new RequestError(409, 'ICEPAK_PROJECT_INVALID', 'Icepak project inspection was not verified')
    const task = createTask({
      title: input.title, description: input.description, ownerNodeId: 'local-node',
      requirementSnapshot: {
        projectPath: input.projectPath, aedtVersion: input.version ?? probe.selectedVersion ?? undefined,
        cores: input.cores ?? 4, ...(input.targetTmaxC === undefined ? {} : { targetTmaxC: input.targetTmaxC }),
        skillId: skill.id, skillVersion: skill.activeVersion,
        inspection: { inputSha256: inspection.inputSha256, design: inspection.project.activeDesign, verified: inspection.validation.verified },
      },
    })
    const created = database.createTaskFromSkill(skill.id, task, { ...input }, {
      probe: { status: probe.status, selectedVersion: probe.selectedVersion, capabilities: probe.capabilities },
      inspect: { inputSha256: inspection.inputSha256, activeDesign: inspection.project.activeDesign, verified: inspection.validation.verified },
    })
    writeJson(response, 201, created)
    return
  }
  const draftSkillMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/skill-draft$/iu)
  if (request.method === 'POST' && draftSkillMatch) {
    writeJson(response, 201, { skill: database.createSkillDraftFromTask(draftSkillMatch[1]) })
    return
  }
  const enableSkillMatch = url.pathname.match(/^\/api\/skills\/([0-9a-f-]+)\/enable$/iu)
  if (request.method === 'POST' && enableSkillMatch) {
    const input = parseSkillReviewInput(await readJsonBody(request))
    const skill = database.getSkill(enableSkillMatch[1])
    if (!skill) throw new SkillNotFoundError(enableSkillMatch[1])
    if (skill.updatedAt !== input.expectedUpdatedAt) throw new SkillConflictError('skill was changed by another operation')
    const publishedPath = skillPublisher.publish(skill)
    writeJson(response, 200, { skill: database.reviewSkill(skill.id, 'ENABLED', input.reviewer, input.expectedUpdatedAt, publishedPath) })
    return
  }
  const disableSkillMatch = url.pathname.match(/^\/api\/skills\/([0-9a-f-]+)\/disable$/iu)
  if (request.method === 'POST' && disableSkillMatch) {
    const input = parseSkillReviewInput(await readJsonBody(request))
    const skill = database.getSkill(disableSkillMatch[1])
    if (!skill) throw new SkillNotFoundError(disableSkillMatch[1])
    if (skill.updatedAt !== input.expectedUpdatedAt) throw new SkillConflictError('skill was changed by another operation')
    skillPublisher.unpublish(skill.publishedPath)
    writeJson(response, 200, { skill: database.reviewSkill(skill.id, 'DISABLED', input.reviewer, input.expectedUpdatedAt, null) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/tasks') {
    const limit = Number(url.searchParams.get('limit') ?? '100')
    writeJson(response, 200, { tasks: database.listTasks(Number.isFinite(limit) ? limit : 100) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/tasks') {
    const input = parseCreateTaskInput(await readJsonBody(request))
    const task = database.createTask(createTask(input))
    writeJson(response, 201, { task })
    return
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/iu)
  if (request.method === 'GET' && taskMatch) {
    const task = database.getTask(taskMatch[1])
    if (!task) throw new TaskNotFoundError(taskMatch[1])
    const runs = database.listTaskRuns(task.id).map(run => ({
      ...run,
      attempts: database.listRunAttempts(run.id).map(attempt => ({
        ...attempt,
        artifacts: database.listAttemptArtifacts(attempt.id),
      })),
    }))
    writeJson(response, 200, { task, runs, events: database.listTaskEvents(task.id), skillRun: database.getSkillRunForTask(task.id) })
    return
  }
  const transitionMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/transitions$/iu)
  if (request.method === 'POST' && transitionMatch) {
    const input = parseTaskTransitionInput(await readJsonBody(request))
    if (!['READY', 'CANCELLED'].includes(input.status)) {
      throw new RequestError(400, 'TRANSITION_REQUIRES_WORKFLOW', 'this task transition must be performed by its controlled workflow')
    }
    const task = database.transitionTask(transitionMatch[1], input.status, input.expectedVersion, input.reason)
    if (input.status === 'READY') database.updateSkillRunStep(task.id, 'confirm', 'COMPLETED', { taskVersion: task.version })
    writeJson(response, 200, { task })
    return
  }
  const approvalMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/approval$/iu)
  if (request.method === 'POST' && approvalMatch) {
    const input = parseTaskApprovalDecisionInput(await readJsonBody(request))
    const task = database.resolveTaskApproval(approvalMatch[1], input.decision, input.expectedVersion, input.reason)
    database.updateSkillRunStep(task.id, 'judge', input.decision === 'APPROVED' ? 'COMPLETED' : 'FAILED', {
      thermalVerdict: task.thermalVerdict, approvalStatus: task.approvalStatus,
    }, input.decision === 'REJECTED' ? { code: 'USER_REJECTED_RESULT', message: input.reason ?? '用户拒绝当前结果' } : undefined)
    const skillResult = database.finishSkillRunForTask(task.id, input.decision === 'APPROVED', input.reason ?? `结果${input.decision}`)
    if (skillResult?.skill.status === 'NEEDS_REPAIR' && skillResult.skill.publishedPath) {
      skillPublisher.unpublish(skillResult.skill.publishedPath)
      database.clearSkillPublishedPath(skillResult.skill.id)
    }
    writeJson(response, 200, { task })
    return
  }
  const baselineMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/runs\/baseline$/iu)
  if (request.method === 'POST' && baselineMatch) {
    const input = parseIcepakProjectOperationInput(await readJsonBody(request))
    const started = await executions.startBaseline(baselineMatch[1], input)
    database.updateSkillRunStep(baselineMatch[1], 'solve', 'RUNNING', { runId: started.run.id, attemptId: started.attempt.id })
    writeJson(response, 202, started)
    return
  }
  const candidateMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/runs\/candidate$/iu)
  if (request.method === 'POST' && candidateMatch) {
    const input = parseIcepakCandidateInput(await readJsonBody(request))
    const started = await executions.startCandidate(candidateMatch[1], input)
    database.updateSkillRunStep(candidateMatch[1], 'solve', 'RUNNING', { runId: started.run.id, attemptId: started.attempt.id, kind: 'CANDIDATE' })
    writeJson(response, 202, started)
    return
  }
  const retryMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/runs\/retry$/iu)
  if (request.method === 'POST' && retryMatch) {
    const input = parseExpectedVersionInput(await readJsonBody(request))
    const started = await executions.retryLatestRun(retryMatch[1], input.expectedVersion)
    database.updateSkillRunStep(retryMatch[1], 'solve', 'RUNNING', { runId: started.run.id, attemptId: started.attempt.id, retry: true })
    writeJson(response, 202, started)
    return
  }
  const cancelAttemptMatch = url.pathname.match(/^\/api\/attempts\/([0-9a-f-]+)\/cancel$/iu)
  if (request.method === 'POST' && cancelAttemptMatch) {
    executions.cancel(cancelAttemptMatch[1])
    writeJson(response, 202, { accepted: true, attemptId: cancelAttemptMatch[1] })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/plugins/icepak/probe') {
    writeJson(response, 200, { probe: await pluginClient.probeEnvironment() })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/plugins/icepak/inspect') {
    const input = parseIcepakProjectOperationInput(await readJsonBody(request))
    const outputDir = join(home, 'runs', 'icepak', randomUUID())
    writeJson(response, 200, { result: await pluginClient.inspectProject({ ...input, outputDir }) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/plugins/icepak/fan-check') {
    const input = parseIcepakProjectOperationInput(await readJsonBody(request))
    const outputDir = join(home, 'runs', 'icepak', randomUUID())
    writeJson(response, 200, { result: await pluginClient.fanCheck({ ...input, outputDir }) })
    return
  }
  if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
    await serveWeb(response, webRoot, url.pathname)
    return
  }
  writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } })
}

async function serveWeb(response: ServerResponse, webRoot: string, pathname: string): Promise<void> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    throw new RequestError(400, 'INVALID_PATH', 'request path is invalid')
  }
  const candidate = resolve(webRoot, `.${decoded === '/' ? '/index.html' : decoded}`)
  if (candidate !== webRoot && !candidate.startsWith(`${webRoot}${sep}`)) {
    throw new RequestError(400, 'INVALID_PATH', 'request path is outside the web root')
  }
  let target = candidate
  try {
    if (!(await stat(target)).isFile()) target = join(webRoot, 'index.html')
  } catch {
    target = join(webRoot, 'index.html')
  }
  let data: Buffer
  try {
    data = await readFile(target)
  } catch {
    throw new RequestError(503, 'WEB_NOT_BUILT', 'web application has not been built')
  }
  const contentTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  }
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(data.length),
    'Cache-Control': extname(target) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src http://127.0.0.1:*",
  })
  response.end(data)
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1_000_000) throw new RequestError(413, 'BODY_TOO_LARGE', 'request body exceeds 1 MB')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new RequestError(400, 'INVALID_JSON', 'request body is not valid JSON')
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body))
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(data.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(data)
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

class RequestError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message)
  }
}

function writeError(response: ServerResponse, error: unknown): void {
  if (error instanceof TaskNotFoundError) {
    writeJson(response, 404, { error: { code: 'TASK_NOT_FOUND', message: error.message } })
    return
  }
  if (error instanceof VersionConflictError) {
    writeJson(response, 409, { error: { code: 'VERSION_CONFLICT', message: error.message } })
    return
  }
  if (error instanceof SkillNotFoundError) {
    writeJson(response, 404, { error: { code: 'SKILL_NOT_FOUND', message: error.message } })
    return
  }
  if (error instanceof SkillConflictError) {
    writeJson(response, 409, { error: { code: 'SKILL_CONFLICT', message: error.message } })
    return
  }
  if (error instanceof TaskApprovalConflictError) {
    writeJson(response, 409, { error: { code: 'TASK_APPROVAL_CONFLICT', message: error.message } })
    return
  }
  if (error instanceof InvalidTaskTransitionError) {
    writeJson(response, 409, { error: { code: 'INVALID_TASK_TRANSITION', message: error.message } })
    return
  }
  if (error instanceof RequestError) {
    writeJson(response, error.statusCode, { error: { code: error.code, message: error.message } })
    return
  }
  if (error instanceof Error && /is required|must be|is invalid|is not active|exceeds/u.test(error.message)) {
    writeJson(response, 400, { error: { code: 'VALIDATION_ERROR', message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : 'unknown error'
  writeJson(response, 500, { error: { code: 'INTERNAL_ERROR', message: message.slice(0, 500) } })
}
