import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { terminateProcessTree } from '@thermal-agent/process-control'
import type { RpcResponse } from '@thermal-agent/contracts'

export interface ReportRenderInput {
  outputPath: string
  generatedAt: string
  task: Record<string, unknown>
  runs: Array<Record<string, unknown>>
  events: Array<Record<string, unknown>>
}

export interface ReportRenderResult {
  outputPath: string
  pageCount: number
  sizeBytes: number
  sha256: string
  font: string
}

export interface ReportPort {
  renderTaskReport(input: ReportRenderInput): Promise<ReportRenderResult>
}

export interface ReportClientOptions {
  python?: string
  pluginRoot?: string
  timeoutMs?: number
}

export class ReportClient implements ReportPort {
  private readonly python: string
  private readonly pluginRoot: string
  private readonly timeoutMs: number

  constructor(options: ReportClientOptions = {}) {
    const pluginRoot = resolve(options.pluginRoot ?? process.env.THERMAL_REPORT_PLUGIN_ROOT ?? 'plugins/report-reportlab/python')
    const pluginParent = resolve(pluginRoot, '..')
    const localPython = process.platform === 'win32'
      ? resolve(pluginParent, '.venv', 'Scripts', 'python.exe')
      : resolve(pluginParent, '.venv', 'bin', 'python')
    this.python = options.python ?? process.env.THERMAL_REPORT_PYTHON ?? (existsSync(localPython) ? localPython : (process.platform === 'win32' ? 'python' : 'python3'))
    this.pluginRoot = pluginRoot
    this.timeoutMs = options.timeoutMs ?? 60_000
  }

  async renderTaskReport(input: ReportRenderInput): Promise<ReportRenderResult> {
    const result = await this.call('render_task_report', input)
    return result as ReportRenderResult
  }

  private async call(method: string, params: object): Promise<unknown> {
    const id = randomUUID()
    const child = spawn(this.python, ['-m', 'thermal_report_plugin'], {
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
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-2_000_000) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000) })
    const response = await new Promise<RpcResponse>((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        terminateProcessTree(child, { force: true })
        reject(new Error(`Report plugin ${method} timed out`))
      }, this.timeoutMs)
      timer.unref()
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => {
        clearTimeout(timer)
        const line = stdout.trim().split(/\r?\n/u).at(-1) ?? ''
        if (!line) {
          reject(new Error(`Report plugin exited without a response (${code}): ${stderr.trim().slice(-500)}`))
          return
        }
        try { resolveResponse(JSON.parse(line) as RpcResponse) }
        catch { reject(new Error(`Report plugin returned invalid JSON: ${line.slice(0, 500)}`)) }
      })
      child.stdin.end(`${JSON.stringify({ id, method, params })}\n`)
    })
    if (response.id !== id) throw new Error('Report plugin response id mismatch')
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    return response.result
  }
}
