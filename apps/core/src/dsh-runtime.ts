import type { DynamicScriptService } from './dynamic-script-service.js'
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import { DshRuntimeStore, type DshSelection } from './dsh-runtime-store.js'
import { DshHost, describeDshRuntime, resolveDshCli, type DshStatus } from './dsh-host.js'
import type { IcepakPluginPort } from './icepak-plugin-client.js'
import { ThermalToolsBridge } from './thermal-tools-bridge.js'
import type { PluginHost } from './plugin-host.js'
import type { RepairJobTransport } from './plugin-repair-jobs.js'

export class DshRuntime {
  readonly runtimes: DshRuntimeStore
  private readonly bridge: ThermalToolsBridge
  private host?: DshHost
  private status: DshStatus = { phase: 'unconfigured', detail: 'DSH runtime has not started' }
  private startTask?: Promise<void>
  private repairTimer?: NodeJS.Timeout
  private closing = false
  private repairSuspended = false
  private readonly repairTransport: RepairJobTransport = {
    dispatch: async job => {
      if (this.closing || this.status.phase !== 'ready') throw new Error('DSH repair runtime is not ready')
      const result = await this.bridge.dshSessionRequest<{ accepted: boolean }>('run-repair', { ...job })
      if (result.accepted !== true) throw new Error('DSH repair prompt was not accepted')
    },
    stop: async job => { await this.bridge.dshSessionRequest('stop-repair', { sessionId: job.sessionId }) },
  }

  constructor(
    private readonly home: string,
    database: LocalDatabase,
    icepak: IcepakPluginPort,
    nodeId: string,
    private readonly plugins?: PluginHost,
    dynamicScripts?: DynamicScriptService,
  ) {
    this.runtimes = new DshRuntimeStore(home)
    this.bridge = new ThermalToolsBridge(home, database, icepak, nodeId, plugins, dynamicScripts)
  }

  canManageRuntime(): boolean { return !this.startTask && !this.closing }

  getStatus(): DshStatus { return { ...this.status } }

  async listSessions(): Promise<Array<{ sessionId: string; title: string; updatedAt: number }>> {
    if (this.status.phase !== 'ready') return []
    const listed = await this.bridge.dshSessionRequest<{
      items: Array<{ sessionId: string; cwd?: string; origin?: string; updatedAt: number; projections?: { values?: { title?: string } } }>
      archivedSessionIds: string[]
    }>('list')
    const archived = new Set(listed.archivedSessionIds)
    const workspace = realpathSync(resolve(this.home, 'workspace'))
    return listed.items.filter(item => item.cwd === workspace && item.origin !== 'subagent' && !archived.has(item.sessionId))
      .map(item => ({ sessionId: item.sessionId, updatedAt: item.updatedAt, title: item.projections?.values?.title?.trim() || '未命名对话' }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async createSession(): Promise<string> {
    if (this.status.phase !== 'ready') throw new Error('DSH is not ready')
    const created = await this.bridge.dshSessionRequest<{ sessionId: string }>('create')
    return created.sessionId
  }

  async createRepairSession(): Promise<{ sessionId: string; agentPreset: string }> {
    if (this.status.phase !== 'ready') throw new Error('DSH is not ready')
    const created = await this.bridge.dshSessionRequest<{ sessionId: string; agentPreset?: string }>('create-repair')
    if (created.agentPreset !== 'thermal-plugin-repair') throw new Error('DSH did not create the restricted repair preset')
    return { sessionId: created.sessionId, agentPreset: created.agentPreset }
  }

  async archiveSession(sessionId: string): Promise<void> {
    if (this.status.phase !== 'ready') throw new Error('DSH is not ready')
    await this.bridge.dshSessionRequest('archive', { sessionId })
  }

  start(): Promise<void> {
    if (this.startTask) return this.startTask
    const task = this.startInternal()
    this.startTask = task
    void task.finally(() => { if (this.startTask === task) this.startTask = undefined })
    return task
  }

  async restart(): Promise<void> {
    this.repairSuspended = true
    try {
      await this.plugins?.repairJobs.stopActive(this.repairTransport)
      this.bridge.clearDshControl()
      if (!this.host) {
        await this.start()
        return
      }
      await this.host.restart()
    } finally { this.repairSuspended = false }
  }

  async close(): Promise<void> {
    this.closing = true
    if (this.repairTimer) clearInterval(this.repairTimer)
    await this.startTask?.catch(() => undefined)
    await this.plugins?.repairJobs.close(this.repairTransport)
    await this.host?.shutdown()
    // A stopped child cannot continue a queued model request; settle any transport failure after shutdown.
    await this.plugins?.repairJobs.close({ dispatch: async () => { throw new Error('DSH closed') }, stop: async () => {} })
    await this.bridge.stop()
  }

  private async startInternal(): Promise<void> {
    this.status = { phase: 'starting', detail: 'Starting Thermal Agent runtime' }
    try {
      const bridgeAddress = await this.bridge.start()
      const bundledCli = resolveDshCli()
      const bundledVersion = bundledCli ? describeDshRuntime(bundledCli).version : undefined
      if (bundledVersion) await this.runtimes.backupBundledProfile(bundledVersion)
      const bundledPlugin = resolve(process.env.THERMAL_AGENT_DSH_PLUGIN ?? 'plugins/dsh-thermal/dist/index.js')
      const launch = async (selection: DshSelection) => {
        const selected = await this.runtimes.launch(selection)
        this.host = new DshHost(this.runtimes.profile(selection), resolve(this.home, 'workspace'), bridgeAddress,
          selected.plugin ?? bundledPlugin, status => { this.status = status }, selected)
        await this.host.start()
      }
      let current = await this.runtimes.current()
      let candidate: DshSelection | undefined
      try { ({ current, candidate } = await this.runtimes.prepare()) }
      catch (error) { await this.runtimes.failed(error) }
      if (candidate) {
        try {
          await launch(candidate)
          const deadline = Date.now() + 60_000
          while (Date.now() < deadline && this.status.phase === 'starting') await new Promise(resolveWait => setTimeout(resolveWait, 100))
          if (this.status.phase !== 'ready') throw new Error(this.status.detail ?? 'New DSH runtime did not become ready')
          await this.bridge.dshSessionRequest('list')
          await this.runtimes.commit(current, candidate)
        } catch (error) {
          await this.host?.shutdown()
          this.bridge.clearDshControl()
          await this.runtimes.failed(error)
          await launch(current)
        }
      } else await launch(current)
      if (this.plugins && !this.closing && !this.repairTimer) {
        this.repairTimer = setInterval(() => {
          if (this.status.phase === 'ready' && !this.closing && !this.repairSuspended) void this.plugins!.repairJobs.reconcile(() => this.plugins!.repairJobInputs(), this.repairTransport).then(() => this.plugins!.applyReadyRepairs()).catch(() => { /* Application failure stays in host evidence; no business replay. */ })
        }, 5_000)
        this.repairTimer.unref()
      }
    } catch (error) {
      this.status = { phase: 'failed', detail: error instanceof Error ? error.message : String(error) }
      await this.bridge.stop().catch(() => undefined)
    }
  }
}
