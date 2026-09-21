import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createTask } from '@thermal-agent/domain'
import { parseCreateTaskInput, parseIcepakProjectOperationInput } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import type { IcepakPluginPort } from './icepak-plugin-client.js'
import type { DshBridgeAddress } from './dsh-host.js'

export class ThermalToolsBridge {
  private server?: Server
  private readonly token = randomBytes(32).toString('hex')

  constructor(
    private readonly home: string,
    private readonly database: LocalDatabase,
    private readonly icepak: IcepakPluginPort,
  ) {}

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
    if (request.method === 'GET' && url.pathname === '/v1/tasks') {
      writeJson(response, 200, { tasks: this.database.listTasks(200) })
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
      const requirementSnapshot = {
        ...(typeof value.projectPath === 'string' && value.projectPath.trim() ? { projectPath: value.projectPath.trim() } : {}),
        ...(typeof value.aedtVersion === 'string' && value.aedtVersion.trim() ? { aedtVersion: value.aedtVersion.trim() } : {}),
        ...(typeof value.cores === 'number' ? { cores: value.cores } : {}),
        ...(typeof value.targetTmaxC === 'number' ? { targetTmaxC: value.targetTmaxC } : {}),
        source: 'dsh-natural-language',
      }
      const input = parseCreateTaskInput({
        title: value.title,
        description: value.description,
        ownerNodeId: 'local-node',
        requirementSnapshot,
      })
      writeJson(response, 201, { task: this.database.createTask(createTask(input)) })
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

