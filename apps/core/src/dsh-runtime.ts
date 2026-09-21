import { resolve } from 'node:path'
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
  ) {
    this.bridge = new ThermalToolsBridge(home, database, icepak)
  }

  getStatus(): DshStatus { return { ...this.status } }

  start(): Promise<void> {
    if (this.startTask) return this.startTask
    const task = this.startInternal()
    this.startTask = task
    void task.finally(() => { if (this.startTask === task) this.startTask = undefined })
    return task
  }

  async restart(): Promise<void> {
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

