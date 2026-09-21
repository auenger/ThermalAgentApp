import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IcepakEnvironmentProbe, RpcResponse } from '@thermal-agent/contracts'

export interface IcepakPluginClientOptions {
  python?: string
  pluginRoot?: string
  timeoutMs?: number
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

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = randomUUID()
    const child = spawn(this.python, ['-m', 'thermal_icepak_plugin'], {
      env: {
        ...process.env,
        PYTHONPATH: [this.pluginRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1_000_000) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000) })

    const response = await new Promise<RpcResponse>((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`Icepak plugin ${method} timed out`))
      }, this.timeoutMs)
      timer.unref()
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', code => {
        clearTimeout(timer)
        const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)
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
