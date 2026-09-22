import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type { SessionCreateRequest } from '@deepseek-ai/dsh-api-session-controller'

export const name = 'thermal-session-control'
export const inject = ['sessionController', 'workspaceRegistry']

export function apply(ctx: Context): void {
  const bridgeUrl = process.env.THERMAL_AGENT_BRIDGE_URL
  const token = process.env.THERMAL_AGENT_BRIDGE_TOKEN
  const workspaceId = process.env.THERMAL_AGENT_WORKSPACE_ID
  const workspaceDir = process.env.THERMAL_AGENT_WORKSPACE_DIR
  if (!bridgeUrl || new URL(bridgeUrl).hostname !== '127.0.0.1' || !token || !workspaceId || !workspaceDir) {
    throw new Error('Thermal session control environment is incomplete')
  }
  ctx.effect(async () => {
    const server = createServer((request, response) => {
      const actual = Buffer.from(request.headers.authorization?.replace(/^Bearer /u, '') ?? '')
      const expected = Buffer.from(token)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { response.writeHead(401).end(); return }
      if (request.method !== 'POST' || !['/v1/list', '/v1/create', '/v1/archive'].includes(request.url ?? '')) { response.writeHead(404).end(); return }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk; if (body.length > 4096) request.destroy() })
      request.on('end', () => {
        void Promise.resolve().then(async () => {
          const input = body ? JSON.parse(body) as Record<string, unknown> : {}
          if (request.url === '/v1/list') {
            const listed = await ctx.sessionController.list({}, new AbortController().signal)
            return { ...listed, archivedSessionIds: ctx.workspaceRegistry.archivedSessionIds }
          }
          if (request.url === '/v1/create') return ctx.sessionController.create({ workspaceId: workspaceId as NonNullable<SessionCreateRequest['workspaceId']> })
          if (typeof input.sessionId !== 'string' || !/^session-[0-9a-f-]{36}$/iu.test(input.sessionId)) throw new Error('Invalid session ID')
          const listed = await ctx.sessionController.list({}, new AbortController().signal)
          if (!listed.items.some(item => item.sessionId === input.sessionId && item.cwd === workspaceDir && item.origin !== 'subagent')) throw new Error('Session is not in the active workspace')
          await ctx.workspaceRegistry.archiveSession(input.sessionId as Parameters<typeof ctx.workspaceRegistry.archiveSession>[0])
          return { archivedSessionIds: ctx.workspaceRegistry.archivedSessionIds }
        }).then(result => {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ result }))
        }).catch(error => {
          response.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 500) : 'DSH session control failed' }))
        })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Thermal session control address unavailable')
    try {
      const registration = await fetch(`${bridgeUrl}/v1/dsh-control/register`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: address.port }),
      })
      if (!registration.ok) throw new Error(`Thermal control registration returned ${registration.status}`)
    } catch (error) {
      await new Promise<void>(resolve => server.close(() => resolve()))
      throw error
    }
    return () => new Promise<void>(resolve => server.close(() => resolve()))
  }, 'thermal:session-control')
}

export default { name, inject, apply }
