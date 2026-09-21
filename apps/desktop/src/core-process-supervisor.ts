import type { ChildProcess } from 'node:child_process'
import { terminateProcessTree } from '@thermal-agent/process-control'

export type CoreProcessState = 'restarting' | 'restarted' | 'failed'

export class CoreProcessSupervisor {
  private child?: ChildProcess
  private restartTimer?: NodeJS.Timeout
  private stopping = false
  private failed = false
  private restarts = 0
  private spawnedAt = 0

  constructor(
    private readonly spawnCore: () => ChildProcess,
    private readonly onState: (state: CoreProcessState, detail?: string) => void,
    private readonly options: { maxRestarts?: number; restartDelayMs?: number; stableMs?: number } = {},
  ) {}

  start(): void {
    if (this.stopping || this.child || this.restartTimer) return
    const retry = this.failed
    if (retry) { this.failed = false; this.restarts = 0 }
    this.launch(retry)
  }

  stop(): void {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    const child = this.child
    this.child = undefined
    if (child) terminateProcessTree(child)
  }

  private launch(restarted: boolean): void {
    this.spawnedAt = Date.now()
    let child: ChildProcess
    try { child = this.spawnCore() }
    catch (error) { this.scheduleRestart(error instanceof Error ? error.message : String(error)); return }
    this.child = child
    let settled = false
    const ended = (detail: string) => {
      if (settled) return
      settled = true
      if (this.child !== child) return
      this.child = undefined
      if (!this.stopping) this.scheduleRestart(detail)
    }
    child.once('error', error => ended(error.message))
    child.once('exit', (code, signal) => ended(`Core exited (${signal ?? code ?? 'unknown'})`))
    if (restarted) this.onState('restarted')
  }

  private scheduleRestart(detail: string): void {
    if (this.stopping) return
    if (Date.now() - this.spawnedAt >= (this.options.stableMs ?? 120_000)) this.restarts = 0
    if (this.restarts >= (this.options.maxRestarts ?? 3)) {
      this.failed = true
      this.onState('failed', detail)
      return
    }
    const delay = (this.options.restartDelayMs ?? 1_000) * 2 ** this.restarts
    this.restarts++
    this.onState('restarting', detail)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (!this.stopping) this.launch(true)
    }, delay)
    this.restartTimer.unref()
  }
}
