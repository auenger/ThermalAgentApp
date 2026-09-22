import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import { DshHost, type DshStatus } from './dsh-host.js'
import type { IcepakPluginPort } from './icepak-plugin-client.js'
import { ThermalToolsBridge } from './thermal-tools-bridge.js'

export class DshRuntime {
  private readonly bridge: ThermalToolsBridge
  private host?: DshHost
  private status: DshStatus = { phase: 'unconfigured', detail: 'DSH runtime has not started' }
  private startTask?: Promise<void>

  constructor(
    private readonly home: string,
    database: LocalDatabase,
    icepak: IcepakPluginPort,
    nodeId: string,
  ) {
    this.bridge = new ThermalToolsBridge(home, database, icepak, nodeId)
  }

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
    this.bridge.clearDshControl()
    if (!this.host) {
      await this.start()
      return
    }
    await this.host.restart()
  }

  async close(): Promise<void> {
    await this.startTask?.catch(() => undefined)
    await this.host?.shutdown()
    await this.bridge.stop()
  }

  private async startInternal(): Promise<void> {
    this.status = { phase: 'starting', detail: 'Starting Thermal Agent runtime' }
    try {
      const bridgeAddress = await this.bridge.start()
      const dshHome = resolve(this.home, 'dsh')
      const workspace = resolve(this.home, 'workspace')
      const pluginPath = resolve(
        process.env.THERMAL_AGENT_DSH_PLUGIN ?? 'plugins/dsh-thermal/dist/index.js',
      )
      this.host = new DshHost(dshHome, workspace, bridgeAddress, pluginPath, status => { this.status = status })
      await this.host.start()
    } catch (error) {
      this.status = { phase: 'failed', detail: error instanceof Error ? error.message : String(error) }
      await this.bridge.stop().catch(() => undefined)
    }
  }
}
