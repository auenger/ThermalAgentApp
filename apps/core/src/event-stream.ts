import type { ServerResponse } from 'node:http'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'

export class CoreEventStream {
  private readonly clients = new Set<ServerResponse>()
  private timer?: NodeJS.Timeout
  private lastPayload = ''
  private ticks = 0

  constructor(private readonly database: LocalDatabase) {}

  subscribe(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    })
    response.write('retry: 2000\n\n')
    this.clients.add(response)
    response.once('close', () => {
      this.clients.delete(response)
      if (this.clients.size === 0) this.stopTimer()
    })
    this.sendSnapshot(response)
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), 1_000)
      this.timer.unref()
    }
  }

  close(): void {
    this.stopTimer()
    for (const response of this.clients) response.end()
    this.clients.clear()
  }

  private snapshot(): string {
    return JSON.stringify({
      tasks: this.database.listTasks(500),
      activeAttempts: this.database.listActiveAttempts(),
      emittedAt: new Date().toISOString(),
    })
  }

  private sendSnapshot(response: ServerResponse): void {
    response.write(`event: snapshot\ndata: ${this.snapshot()}\n\n`)
  }

  private tick(): void {
    if (this.clients.size === 0) { this.stopTimer(); return }
    const payload = this.snapshot()
    const stateOnly = payload.replace(/,"emittedAt":"[^"]+"\}$/u, '}')
    const changed = stateOnly !== this.lastPayload
    this.ticks += 1
    if (changed) {
      this.lastPayload = stateOnly
      for (const response of this.clients) response.write(`event: snapshot\ndata: ${payload}\n\n`)
    } else if (this.ticks % 15 === 0) {
      for (const response of this.clients) response.write(': keepalive\n\n')
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
