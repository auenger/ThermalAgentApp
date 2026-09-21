import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { parseCreateTaskInput, parseIcepakProjectOperationInput, parseSkillReviewInput, parseTaskApprovalDecisionInput, parseTaskTransitionInput } from '@thermal-agent/contracts'
import { createTask, InvalidTaskTransitionError } from '@thermal-agent/domain'
import { LocalDatabase, SkillConflictError, SkillNotFoundError, TaskApprovalConflictError, TaskNotFoundError, VersionConflictError } from '@thermal-agent/sqlite-store'
import { IcepakPluginClient, type IcepakPluginPort } from './icepak-plugin-client.js'
import { IcepakExecutionManager } from './execution-manager.js'
import { DshRuntime } from './dsh-runtime.js'
import { SkillPublisher } from './skill-publisher.js'

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
  if (options.startAgentRuntime !== false) void agentRuntime.start()
  const webRoot = resolve(options.webRoot ?? process.env.THERMAL_AGENT_WEB_ROOT ?? 'apps/web/dist')

  const server = createServer((request, response) => {
    void route(request, response, database, pluginClient, executions, agentRuntime, skillPublisher, webRoot, home).catch(error => writeError(response, error))
  })

  return {
    server,
    database,
    artifacts,
    async close() {
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
  webRoot: string,
  home: string,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && url.pathname === '/api/health') {
    writeJson(response, 200, { status: 'ok', service: 'thermal-agent-core', version: '0.1.0' })
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
    writeJson(response, 200, { task, runs, events: database.listTaskEvents(task.id) })
    return
  }
  const transitionMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/transitions$/iu)
  if (request.method === 'POST' && transitionMatch) {
    const input = parseTaskTransitionInput(await readJsonBody(request))
    if (!['READY', 'CANCELLED'].includes(input.status)) {
      throw new RequestError(400, 'TRANSITION_REQUIRES_WORKFLOW', 'this task transition must be performed by its controlled workflow')
    }
    const task = database.transitionTask(transitionMatch[1], input.status, input.expectedVersion, input.reason)
    writeJson(response, 200, { task })
    return
  }
  const approvalMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/approval$/iu)
  if (request.method === 'POST' && approvalMatch) {
    const input = parseTaskApprovalDecisionInput(await readJsonBody(request))
    const task = database.resolveTaskApproval(approvalMatch[1], input.decision, input.expectedVersion, input.reason)
    writeJson(response, 200, { task })
    return
  }
  const baselineMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/runs\/baseline$/iu)
  if (request.method === 'POST' && baselineMatch) {
    const input = parseIcepakProjectOperationInput(await readJsonBody(request))
    const started = await executions.startBaseline(baselineMatch[1], input)
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
