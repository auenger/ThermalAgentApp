import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { terminateProcessTree } from '@thermal-agent/process-control'
import { pythonPluginArgs, pythonPluginEnv, requirePluginCapability, type PythonPluginLease } from './python-plugin-launch.js'
import type {
  IcepakEnvironmentProbe,
  IcepakProjectOperationInput,
  IcepakProjectOperationResult,
  RpcResponse,
  CadPluginInput,
  ModelPluginInput,
  ModelPluginResult,
  PluginExecutionIdentity,
} from '@thermal-agent/contracts'

export interface IcepakPluginClientOptions {
  python?: string
  pluginRoot?: string
  timeoutMs?: number
  acquireRuntime?: (expected?: PluginExecutionIdentity) => PythonPluginLease
}

export interface PluginCallOptions {
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?(stage: string): void
  /** Internal Core-owned execution identity; not accepted from HTTP request bodies. */
  operationId?: string
  onProcessStarted?(pid: number): void
  onManagedResource?(pid: number, creationTime: number): void
}

export interface IcepakPluginPort {
  /** Warm managed runtime selection before acquiring the shared engineering-process gate. */
  prepareRuntime?(): Promise<void>
  pinRuntime?(expected?: PluginExecutionIdentity): Promise<PinnedIcepakPlugin>
  inspectCad?(input: CadPluginInput, options?: PluginCallOptions): Promise<ModelPluginResult>
  prepareModel?(input: ModelPluginInput, options?: PluginCallOptions): Promise<ModelPluginResult>
  validateModel?(input: ModelPluginInput, options?: PluginCallOptions): Promise<ModelPluginResult>
  probeEnvironment(): Promise<IcepakEnvironmentProbe>
  probeLaunchability?(version?: string, options?: PluginCallOptions): Promise<IcepakEnvironmentProbe>
  inspectProject(input: IcepakProjectOperationInput & { outputDir: string }, options?: PluginCallOptions): Promise<IcepakProjectOperationResult>
  checkChanges?(input: IcepakProjectOperationInput & { outputDir: string }, options?: PluginCallOptions): Promise<IcepakProjectOperationResult>
  fanCheck(input: IcepakProjectOperationInput & { outputDir: string }, options?: PluginCallOptions): Promise<IcepakProjectOperationResult>
  solveProject(input: IcepakProjectOperationInput & { outputDir: string }, options?: PluginCallOptions): Promise<IcepakProjectOperationResult>
  fanSolve(input: IcepakProjectOperationInput & { outputDir: string }, options?: PluginCallOptions): Promise<IcepakProjectOperationResult>
}

export interface PinnedIcepakPlugin {
  identity: PluginExecutionIdentity
  port: IcepakPluginPort
  release(): void
}

export async function pinIcepakPlugin(port: IcepakPluginPort, expected?: PluginExecutionIdentity): Promise<PinnedIcepakPlugin> {
  if (port.pinRuntime) return port.pinRuntime(expected)
  if (expected?.packageDigest) throw new Error('This plugin cannot restore a managed revision')
  const probe = await port.probeEnvironment()
  const identity = { pluginId: probe.pluginId ?? 'external-icepak', pluginVersion: probe.pluginVersion ?? 'unversioned' }
  if (expected && (expected.pluginId !== identity.pluginId || expected.pluginVersion !== identity.pluginVersion)) throw new Error('Unmanaged plugin version changed')
  return { identity, port, release() {} }
}

export class IcepakPluginClient {
  private readonly acquireRuntime?: (expected?: PluginExecutionIdentity) => PythonPluginLease
  private readonly python: string
  private readonly pluginRoot: string
  private readonly timeoutMs: number

  constructor(options: IcepakPluginClientOptions = {}) {
    this.acquireRuntime = options.acquireRuntime
    this.python = options.python ?? process.env.THERMAL_ICEPAK_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
    this.pluginRoot = resolve(options.pluginRoot ?? process.env.THERMAL_ICEPAK_PLUGIN_ROOT ?? 'plugins/icepak-pyaedt/python')
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async pinRuntime(expected?: PluginExecutionIdentity): Promise<PinnedIcepakPlugin> {
    const runtime = this.acquireRuntime?.(expected)
    try {
      const identity = runtime?.identity
      const probe = identity ? undefined : await this.probeEnvironment()
      const actual = identity ?? { pluginId: probe!.pluginId, pluginVersion: probe!.pluginVersion }
      if (expected && (actual.pluginId !== expected.pluginId || actual.pluginVersion !== expected.pluginVersion || actual.packageDigest !== expected.packageDigest || actual.environmentDigest !== expected.environmentDigest)) throw new Error('Pinned plugin identity mismatch')
      let released = false
      let calls = 0
      const port = new IcepakPluginClient({ python: this.python, pluginRoot: this.pluginRoot, timeoutMs: this.timeoutMs,
        ...(runtime ? { acquireRuntime: () => {
          if (released) throw new Error('Plugin execution lease has ended')
          calls++
          let ended = false
          return { ...runtime, release() {
            if (ended) return
            ended = true
            calls--
            if (released && calls === 0) runtime.release()
          } }
        } } : {}) })
      return { identity: actual, port, release: () => { if (!released) { released = true; if (calls === 0) runtime?.release() } } }
    } catch (error) { runtime?.release(); throw error }
  }

  async probeEnvironment(): Promise<IcepakEnvironmentProbe> {
    return this.call('probe_environment') as Promise<IcepakEnvironmentProbe>
  }

  runtimeConfiguration(): { python: string; pluginRoot: string } { return { python: this.python, pluginRoot: this.pluginRoot } }

  async inspectCad(input: CadPluginInput, options: PluginCallOptions = {}): Promise<ModelPluginResult> {
    return this.call('inspect_cad', input, { timeoutMs: 20 * 60_000, ...options }) as Promise<ModelPluginResult>
  }

  async prepareModel(input: ModelPluginInput, options: PluginCallOptions = {}): Promise<ModelPluginResult> {
    return this.call('prepare_model', input, { timeoutMs: 20 * 60_000, ...options }) as Promise<ModelPluginResult>
  }

  async validateModel(input: ModelPluginInput, options: PluginCallOptions = {}): Promise<ModelPluginResult> {
    return this.call('validate_model', input, { timeoutMs: 60 * 60_000, ...options }) as Promise<ModelPluginResult>
  }

  async probeLaunchability(version?: string, options: PluginCallOptions = {}): Promise<IcepakEnvironmentProbe> {
    return this.call('probe_launchability', version ? { version } : {}, { timeoutMs: 5 * 60_000, ...options }) as Promise<IcepakEnvironmentProbe>
  }

  async health(): Promise<unknown> {
    return this.call('health')
  }

  async inspectProject(input: IcepakProjectOperationInput & { outputDir: string }, options?: PluginCallOptions): Promise<IcepakProjectOperationResult> {
    return this.call('inspect_project', input, { timeoutMs: 10 * 60_000, ...options }) as Promise<IcepakProjectOperationResult>
  }

  async checkChanges(input: IcepakProjectOperationInput & { outputDir: string }, options: PluginCallOptions = {}): Promise<IcepakProjectOperationResult> {
    return this.call('check_changes', input, { timeoutMs: 10 * 60_000, ...options }) as Promise<IcepakProjectOperationResult>
  }

  async fanCheck(input: IcepakProjectOperationInput & { outputDir: string }, options: PluginCallOptions = {}): Promise<IcepakProjectOperationResult> {
    return this.call('fan_check', input, { timeoutMs: 10 * 60_000, ...options }) as Promise<IcepakProjectOperationResult>
  }

  async solveProject(input: IcepakProjectOperationInput & { outputDir: string }, options: PluginCallOptions = {}): Promise<IcepakProjectOperationResult> {
    return this.call('solve_project', input, { timeoutMs: 4 * 60 * 60_000, ...options }) as Promise<IcepakProjectOperationResult>
  }

  async fanSolve(input: IcepakProjectOperationInput & { outputDir: string }, options: PluginCallOptions = {}): Promise<IcepakProjectOperationResult> {
    return this.call('fan_solve', input, { timeoutMs: 4 * 60 * 60_000, ...options }) as Promise<IcepakProjectOperationResult>
  }

  async call(method: string, params: object = {}, options: PluginCallOptions = {}): Promise<unknown> {
    const runtime = this.acquireRuntime?.()
    try {
      const result = await this.callWithRuntime(method, params, options, runtime)
      if ((method === 'probe_environment' || method === 'probe_launchability') && result && typeof result === 'object') {
        const probe = result as IcepakEnvironmentProbe
        // Strip self-reported provenance even for legacy/unmanaged clients.
        const { pluginRuntime: _reported, ...facts } = probe
        if (runtime?.identity && facts.status === 'READY') {
          facts.status = facts.platform === 'win32' && facts.pyaedtAvailable ? 'DETECTED' : 'DEGRADED'
          facts.licenseStatus = 'UNKNOWN'
          delete facts.readinessVerifiedAt
          delete facts.readinessExpiresAt
        }
        return runtime?.identity ? { ...facts, pluginId: runtime.identity.pluginId, pluginVersion: runtime.identity.pluginVersion,
          pluginRuntime: { ...runtime.identity } } : facts
      }
      return result
    }
    finally { runtime?.release() }
  }

  private async callWithRuntime(method: string, params: object, options: PluginCallOptions, runtime?: PythonPluginLease): Promise<unknown> {
    const capabilities: Record<string, string[]> = {
      probe_environment: ['environment_probe'], probe_launchability: ['environment_probe'],
      inspect_cad: ['cad_inspect'], prepare_model: ['model_prepare'], validate_model: ['model_validate'],
      inspect_project: ['project_inspect'], check_changes: ['parameter_check'],
      fan_check: ['fan_check', 'fan_solve'], solve_project: ['baseline_solve'], fan_solve: ['fan_solve'],
    }
    requirePluginCapability(runtime, method, capabilities[method] ?? [])
    if (options.signal?.aborted) throw new Error(`Icepak plugin ${method} was cancelled before launch`)
    const id = randomUUID()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const child = spawn(runtime?.python ?? this.python, pythonPluginArgs(runtime?.pluginRoot ?? this.pluginRoot, runtime?.module ?? 'thermal_icepak_plugin'), {
      env: { ...pythonPluginEnv(), ...(options.operationId ? { THERMAL_ICEPAK_PARENT_PID: String(process.pid), THERMAL_ICEPAK_MANAGED_ONESHOT: '1' } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let lineBuffer = ''
    let responseLine = ''
    let stderr = ''
    let stdoutBytes = 0
    let stdoutOverflow = false
    child.stdin.on('error', () => { /* EPIPE during cancellation/exit is handled by the process close event. */ })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      if (stdoutOverflow) return
      stdoutBytes += Buffer.byteLength(chunk, 'utf8')
      lineBuffer += chunk
      if (stdoutBytes > 64 * 1024 * 1024) {
        stdoutOverflow = true
        terminateProcessTree(child, { force: true })
        return
      }
      let newline = lineBuffer.indexOf('\n')
      while (newline >= 0) {
        const line = lineBuffer.slice(0, newline).trim()
        lineBuffer = lineBuffer.slice(newline + 1)
        if (line) {
          try {
            const event = JSON.parse(line) as { id?: string; event?: string; stage?: string; pid?: number; creationTime?: number }
            if (event.id === id && event.event === 'progress' && typeof event.stage === 'string') {
              options.onProgress?.(event.stage)
            } else if (event.id === id && event.event === 'managed_process' && Number.isInteger(event.pid) && typeof event.creationTime === 'number') {
              options.onManagedResource?.(event.pid!, event.creationTime)
            } else {
              responseLine = line
            }
          } catch {
            responseLine = line
          }
        }
        newline = lineBuffer.indexOf('\n')
      }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000) })

    const response = await new Promise<RpcResponse>((resolveResponse, reject) => {
      let aborted = false
      let timedOut = false
      let forceTimer: NodeJS.Timeout | undefined
      const stop = () => {
        if (forceTimer) return
        // Let the plugin clean up explicitly registered AEDT sessions before forcibly reaping it.
        if (options.operationId) {
          if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(`${JSON.stringify({ event: 'cancel' })}\n`)
          forceTimer = setTimeout(() => terminateProcessTree(child, { force: true }), 10_000)
          forceTimer.unref()
        } else terminateProcessTree(child, { force: true })
      }
      const timer = setTimeout(() => {
        timedOut = true
        stop()
        // Hold the shared operation lock until the managed process has actually closed.
      }, timeoutMs)
      timer.unref()
      const abort = () => {
        aborted = true
        stop()
      }
      if (options.signal?.aborted) abort()
      options.signal?.addEventListener('abort', abort, { once: true })
      child.once('error', error => {
        clearTimeout(timer)
        if (forceTimer) clearTimeout(forceTimer)
        options.signal?.removeEventListener('abort', abort)
        reject(error)
      })
      child.once('close', code => {
        clearTimeout(timer)
        if (forceTimer) clearTimeout(forceTimer)
        options.signal?.removeEventListener('abort', abort)
        if (timedOut) {
          reject(Object.assign(new Error(`Icepak plugin ${method} timed out`), { code: 'PLUGIN_TIMEOUT' }))
          return
        }
        if (aborted) {
          reject(new Error(`Icepak plugin ${method} was cancelled`))
          return
        }
        if (stdoutOverflow) {
          reject(new Error(`Icepak plugin ${method} response exceeded 64 MB`))
          return
        }
        const line = lineBuffer.trim() || responseLine
        if (!line) {
          reject(new Error(`Icepak plugin exited without a response (${code}): ${stderr.trim().slice(-500)}`))
          return
        }
        try {
          resolveResponse(JSON.parse(line) as RpcResponse)
        } catch {
          reject(new Error(`Icepak plugin returned invalid JSON: ${line.slice(0, 500)}`))
        }
      })
      try {
        if (child.pid) options.onProcessStarted?.(child.pid)
        if (options.operationId) child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
        else child.stdin.end(`${JSON.stringify({ id, method, params })}\n`)
      } catch (error) {
        aborted = true
        terminateProcessTree(child, { force: true })
        child.once('close', () => reject(error))
      }
    })

    if (response.id !== id) throw new Error('Icepak plugin response id mismatch')
    if (!response.ok) throw Object.assign(new Error(`${response.error.code}: ${response.error.message}`), { code: response.error.code })
    return response.result
  }
}
