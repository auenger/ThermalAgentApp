import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'

export interface LanStatus {
  enabled: boolean
  port?: number
  addresses: string[]
  pairingCode?: string
  pairingExpiresAt?: string
  sessionCount: number
}

export class LanPublisher {
  private server?: Server
  private pairingCode = ''
  private pairingExpiresAt = 0
  private readonly sessions = new Map<string, number>()
  private readonly failures = new Map<string, { count: number; resetAt: number }>()
  private readonly peerAttempts = new Map<string, { count: number; resetAt: number }>()
  private port?: number

  constructor(private readonly application: RequestListener) {}

  async start(port: number, host = '0.0.0.0'): Promise<LanStatus> {
    if (this.server) throw new Error('LAN publishing is already enabled')
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('LAN port is invalid')
    this.pairingCode = String(randomInt(10_000_000, 100_000_000))
    this.pairingExpiresAt = Date.now() + 10 * 60_000
    const server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(port, host, resolveListen)
    })
    this.server = server
    const address = server.address()
    this.port = address && typeof address !== 'string' ? address.port : port
    return this.status(true)
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.port = undefined
    this.pairingCode = ''
    this.pairingExpiresAt = 0
    this.sessions.clear()
    this.peerAttempts.clear()
    if (!server?.listening) return
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  }

  status(includePairingCode = false): LanStatus {
    this.pruneSessions()
    return {
      enabled: Boolean(this.server?.listening),
      ...(this.port ? { port: this.port } : {}),
      addresses: this.port ? localAddresses().map(address => `http://${formatHost(address)}:${this.port}`) : [],
      ...(includePairingCode && this.pairingCode ? {
        pairingCode: this.pairingCode,
        pairingExpiresAt: new Date(this.pairingExpiresAt).toISOString(),
      } : {}),
      sessionCount: this.sessions.size,
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://lan.local')
    if (request.method === 'POST' && url.pathname === '/api/lan/pair') {
      await this.pair(request, response)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/peer/v1/challenge') {
      const remote = request.socket.remoteAddress ?? 'unknown'
      const now = Date.now()
      if (this.peerAttempts.size > 1_024) {
        for (const [address, attempt] of this.peerAttempts) if (attempt.resetAt <= now) this.peerAttempts.delete(address)
        if (this.peerAttempts.size > 1_024) this.peerAttempts.delete(this.peerAttempts.keys().next().value as string)
      }
      const prior = this.peerAttempts.get(remote)
      const current = prior && prior.resetAt > now ? prior : { count: 0, resetAt: now + 60_000 }
      current.count += 1
      this.peerAttempts.set(remote, current)
      if (current.count > 120) {
        writeJson(response, 429, { error: { code: 'PEER_RATE_LIMITED', message: 'too many peer challenges' } })
        return
      }
      this.application(request, response)
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      this.application(request, response)
      return
    }
    if (!this.authorized(request)) {
      writeJson(response, 401, { error: { code: 'LAN_AUTH_REQUIRED', message: 'LAN pairing is required' } })
      return
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET') && !this.sameOrigin(request)) {
      writeJson(response, 403, { error: { code: 'LAN_ORIGIN_REJECTED', message: 'request origin does not match this LAN service' } })
      return
    }
    this.application(request, response)
  }

  private async pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const remote = request.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    const failures = this.failures.get(remote)
    if (failures && failures.resetAt > now && failures.count >= 5) {
      writeJson(response, 429, { error: { code: 'PAIRING_RATE_LIMITED', message: 'too many pairing attempts' } })
      return
    }
    let body = ''
    for await (const chunk of request) {
      body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      if (body.length > 2_000) { writeJson(response, 413, { error: { code: 'BODY_TOO_LARGE', message: 'pairing request is too large' } }); return }
    }
    let code = ''
    try { code = String((JSON.parse(body) as { code?: unknown }).code ?? '') } catch { /* invalid is treated as a failed code */ }
    if (now > this.pairingExpiresAt || !safeEqual(code, this.pairingCode)) {
      const current = failures && failures.resetAt > now ? failures : { count: 0, resetAt: now + 60_000 }
      current.count += 1
      this.failures.set(remote, current)
      writeJson(response, 401, { error: { code: 'PAIRING_CODE_INVALID', message: 'pairing code is invalid or expired' } })
      return
    }
    this.failures.delete(remote)
    const token = randomBytes(32).toString('base64url')
    const expiresAt = now + 12 * 60 * 60_000
    this.sessions.set(token, expiresAt)
    response.setHeader('Set-Cookie', `thermal_lan_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`)
    writeJson(response, 200, { paired: true, expiresAt: new Date(expiresAt).toISOString() })
  }

  private authorized(request: IncomingMessage): boolean {
    this.pruneSessions()
    const cookie = request.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('thermal_lan_session='))
    const token = cookie?.slice('thermal_lan_session='.length) ?? ''
    return Boolean(token && this.sessions.has(token))
  }

  private sameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin
    if (!origin) return false
    try { return new URL(origin).host === request.headers.host } catch { return false }
  }

  private pruneSessions(): void {
    const now = Date.now()
    for (const [token, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(token)
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function localAddresses(): string[] {
  const addresses = new Set<string>()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (!entry.internal && (entry.family === 'IPv4' || entry.family === 'IPv6')) addresses.add(entry.address)
  }
  return [...addresses]
}

function formatHost(address: string): string { return address.includes(':') ? `[${address}]` : address }

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}
