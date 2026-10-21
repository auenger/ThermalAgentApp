import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, realpathSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { prepareDshProfile } from './dsh-profile.js'
import { terminateProcessTree } from '@thermal-agent/process-control'

export interface DshStatus {
  phase: 'unconfigured' | 'starting' | 'ready' | 'stopped' | 'failed'
  url?: string
  detail?: string
  workspacePath?: string
  version?: string
  releaseChannel?: 'stable' | 'prerelease' | 'unknown'
}

export interface DshBridgeAddress { url: string; token: string }

export function parseDshReadyUrl(output: string, port: number): string | undefined {
  const expected = `http://127.0.0.1:${port}`
  for (const match of output.matchAll(/^dsh web: (https?:\/\/\S+)/gmu)) {
    try {
      const url = new URL(match[1])
      if (url.origin === expected && url.searchParams.has('token')) return url.href
    } catch { /* startup output may contain an incomplete line */ }
  }
  return undefined
}

export function resolveDshCli(override = process.env.THERMAL_AGENT_DSH_CLI): string | undefined {
  if (override) return existsSync(override) ? resolve(override) : undefined
  try {
    const manifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
    const cli = join(dirname(manifest), 'lib', 'bin.js')
    if (existsSync(cli)) return cli
  } catch { /* dependency may not be installed yet */ }
  return undefined
}

/** Read the package owning the selected CLI, including an external runtime override. */
export function describeDshRuntime(cli: string): Pick<DshStatus, 'version' | 'releaseChannel'> {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8'))
    if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version)) return { releaseChannel: 'unknown' }
    return { version: manifest.version, releaseChannel: manifest.version.split('+')[0].includes('-') ? 'prerelease' : 'stable' }
  } catch { return { releaseChannel: 'unknown' } }
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No loopback port')); return }
      server.close(() => resolvePort(address.port))
    })
  })
}

export class DshHost {
  private child?: ChildProcess
  private state: DshStatus = { phase: 'unconfigured' }
  private stopping = false
  private closed = false
  private generation = 0

  constructor(
    private readonly home: string,
    private readonly workspace: string,
    private readonly bridge: DshBridgeAddress,
    private readonly pluginPath: string,
    private readonly onStatus: (status: DshStatus) => void = () => undefined,
    private readonly runtime?: { cli?: string; node?: string },
  ) {}

  getStatus(): DshStatus { return { ...this.state } }

  private update(status: DshStatus): void {
    this.state = { version: this.state.version, releaseChannel: this.state.releaseChannel, ...status }
    this.onStatus({ ...this.state })
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('DSH Host is closed')
    if (this.child || this.state.phase === 'starting') return
    const generation = ++this.generation
    this.stopping = false
    this.update({ phase: 'starting', detail: 'Starting DSH Host', workspacePath: this.workspace })
    const cli = resolveDshCli(this.runtime?.cli ?? process.env.THERMAL_AGENT_DSH_CLI)
    if (!cli) {
      this.update({ phase: 'unconfigured', detail: 'Pinned DSH runtime was not found' })
      return
    }
    this.update({ ...this.state, ...describeDshRuntime(cli) })
    if (!existsSync(this.pluginPath)) {
      this.update({ phase: 'failed', detail: `Thermal DSH plugin is missing: ${this.pluginPath}` })
      return
    }
    const port = await availablePort()
    if (generation !== this.generation || this.closed) return
    mkdirSync(this.home, { recursive: true })
    mkdirSync(this.workspace, { recursive: true })
    const patch = prepareDshProfile(this.home, this.pluginPath)
    const node = this.runtime?.node || process.env.THERMAL_AGENT_NODE_BIN || process.execPath
    const runAsNode = node === process.execPath && Boolean(process.versions.electron)
    const launcher = join(dirname(this.pluginPath), 'launcher.mjs')
    const structured = existsSync(launcher)
    const args = structured ? [launcher, patch, String(port)] : [cli, 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', String(port)]
    const child = spawn(node, ['--expose-internals', ...args], {
      cwd: this.workspace,
      env: {
        ...process.env,
        ...(runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        DSH_HOME: this.home,
        THERMAL_AGENT_DSH_CLI: cli,
        THERMAL_AGENT_BRIDGE_URL: this.bridge.url,
        THERMAL_AGENT_BRIDGE_TOKEN: this.bridge.token,
        THERMAL_AGENT_WORKSPACE_DIR: realpathSync(this.workspace),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    })
    this.child = child
    let stdoutTail = ''
    let stderrTail = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (data: string) => {
      if (generation !== this.generation || this.child !== child || this.stopping) return
      stdoutTail = (stdoutTail + data).slice(-8_000)
      const url = parseDshReadyUrl(stdoutTail, port)
      if (!structured && url && this.state.phase !== 'ready') this.update({ phase: 'ready', url, workspacePath: this.workspace })
    })
    child.on('message', message => {
      if (generation !== this.generation || this.child !== child || this.stopping || !message || typeof message !== 'object') return
      const value = message as { type?: string; protocol?: number; url?: string }
      if (value.type !== 'thermal-dsh-ready' || value.protocol !== 1 || typeof value.url !== 'string') return
      const url = parseDshReadyUrl(`dsh web: ${value.url}`, port)
      if (url) this.update({ phase: 'ready', url, workspacePath: this.workspace })
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (data: string) => { stderrTail = (stderrTail + data).slice(-12_000) })
    child.once('close', () => { if (this.child === child) this.child = undefined })
    child.once('error', error => {
      if (generation === this.generation && !this.stopping) this.update({ phase: 'failed', detail: error.message })
    })
    child.once('exit', code => {
      if (this.child === child) this.child = undefined
      if (generation === this.generation && !this.stopping) {
        const diagnostic = stderrTail.trim().slice(-2_000)
        this.update({ phase: 'failed', detail: diagnostic || `DSH Host exited with code ${code}` })
      }
    })
  }

  async restart(): Promise<void> {
    await this.stop()
    if (!this.closed) await this.start()
  }

  async shutdown(): Promise<void> {
    this.closed = true
    await this.stop()
  }

  private async stop(): Promise<void> {
    ++this.generation
    this.stopping = true
    this.update({ phase: 'stopped', workspacePath: this.workspace })
    const child = this.child
    if (!child) return
    await new Promise<void>(resolveStop => {
      const timeout = setTimeout(() => terminateProcessTree(child, { force: true }), 5_000)
      timeout.unref()
      child.once('close', () => { clearTimeout(timeout); resolveStop() })
      terminateProcessTree(child)
    })
    if (this.child === child) this.child = undefined
  }
}
