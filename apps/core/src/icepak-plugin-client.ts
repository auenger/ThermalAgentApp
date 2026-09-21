import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { terminateProcessTree } from '@thermal-agent/process-control'
import type {
  IcepakEnvironmentProbe,
  IcepakProjectOperationInput,
  IcepakProjectOperationResult,
  RpcResponse,
} from '@thermal-agent/contracts'

export interface IcepakPluginClientOptions {
  python?: string
  pluginRoot?: string
  timeoutMs?: number
}

export interface PluginCallOptions {
  timeoutMs?: number
  signal?: AbortSignal
  onProgress?(stage: string): void
}

export interface IcepakPluginPort {
  probeEnvironment(): Promise<IcepakEnvironmentProbe>
  inspectProject(input: IcepakProjectOperationInput & { outputDir: string }): Promise<IcepakProjectOperationResult>
  fanCheck(input: IcepakProjectOperationInput & { outputDir: string }): Promise<IcepakProjectOperationResult>
  solveProject(input: IcepakProjectOperationInput & { outputDir: string }, options?: PluginCallOptions): Promise<IcepakProjectOperationResult>
  fanSolve(input: IcepakProjectOperationInput & { outputDir: string }, options?: PluginCallOptions): Promise<IcepakProjectOperationResult>
}

export class IcepakPluginClient {
  private readonly python: string
  private readonly pluginRoot: string
  private readonly timeoutMs: number

  constructor(options: IcepakPluginClientOptions = {}) {
    this.python = options.python ?? process.env.THERMAL_ICEPAK_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
    this.pluginRoot = resolve(options.pluginRoot ?? process.env.THERMAL_ICEPAK_PLUGIN_ROOT ?? 'plugins/icepak-pyaedt/python')
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  async probeEnvironment(): Promise<IcepakEnvironmentProbe> {
    return this.call('probe_environment') as Promise<IcepakEnvironmentProbe>
  }

  async health(): Promise<unknown> {
    return this.call('health')
  }

  async inspectProject(input: IcepakProjectOperationInput & { outputDir: string }): Promise<IcepakProjectOperationResult> {
    return this.call('inspect_project', input, { timeoutMs: 10 * 60_000 }) as Promise<IcepakProjectOperationResult>
  }

  async fanCheck(input: IcepakProjectOperationInput & { outputDir: string }): Promise<IcepakProjectOperationResult> {
    return this.call('fan_check', input, { timeoutMs: 10 * 60_000 }) as Promise<IcepakProjectOperationResult>
  }

  async solveProject(input: IcepakProjectOperationInput & { outputDir: string }, options: PluginCallOptions = {}): Promise<IcepakProjectOperationResult> {
    return this.call('solve_project', input, { timeoutMs: 4 * 60 * 60_000, ...options }) as Promise<IcepakProjectOperationResult>
  }

  async fanSolve(input: IcepakProjectOperationInput & { outputDir: string }, options: PluginCallOptions = {}): Promise<IcepakProjectOperationResult> {
    return this.call('fan_solve', input, { timeoutMs: 4 * 60 * 60_000, ...options }) as Promise<IcepakProjectOperationResult>
  }

  async call(method: string, params: object = {}, options: PluginCallOptions = {}): Promise<unknown> {
    const id = randomUUID()
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const child = spawn(this.python, ['-m', 'thermal_icepak_plugin'], {
      env: {
        ...process.env,
        PYTHONPATH: [this.pluginRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let lineBuffer = ''
    let responseLine = ''
    let stderr = ''
    let stdoutBytes = 0
    let stdoutOverflow = false
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
            const event = JSON.parse(line) as { id?: string; event?: string; stage?: string }
            if (event.id === id && event.event === 'progress' && typeof event.stage === 'string') {
              options.onProgress?.(event.stage)
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
      const timer = setTimeout(() => {
        terminateProcessTree(child, { force: true })
        reject(new Error(`Icepak plugin ${method} timed out`))
      }, timeoutMs)
      timer.unref()
      const abort = () => {
        aborted = true
        terminateProcessTree(child, { force: true })
      }
      if (options.signal?.aborted) abort()
      options.signal?.addEventListener('abort', abort, { once: true })
      child.once('error', error => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        reject(error)
      })
      child.once('close', code => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
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
      child.stdin.end(`${JSON.stringify({ id, method, params })}\n`)
    })

    if (response.id !== id) throw new Error('Icepak plugin response id mismatch')
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result
  }
}
