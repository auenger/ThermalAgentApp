import { resolveScriptParameters, type ScriptDefinition } from './dynamic-script-library.js'
import type { PluginExecutionIdentity } from '@thermal-agent/contracts'
export interface ScriptIterationPlan {
  scriptId: string
  parameters: Record<string, unknown>
  adjustable: Array<{ name: string; minimum: number; maximum: number; step: number; minimumStep: number }>
  targetTmaxC: number
  maxRounds: number
  maxDurationMs: number
  setup: string
  design?: string
  cores?: number
}
export interface ScriptIterationRound {
  number: number
  parameters: Record<string, unknown>
  status: 'APPLYING' | 'SOLVING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  startedAt: string
  finishedAt?: string
  scriptRunId?: string
  scriptProjectSha256?: string
  solvedProjectSha256?: string
  resultSha256?: string
  executionKind?: 'native-aedt' | 'test-double'
  tmaxC?: number
  error?: string
}
export interface ScriptIteration {
  id: string
  taskId: string
  projectSha256: string
  aedtVersion: string
  plan: ScriptIterationPlan
  revision: number
  status: 'DRAFT' | 'RUNNING' | 'STOPPED'
  stopReason?: 'TARGET_REACHED' | 'ROUND_LIMIT' | 'TIME_LIMIT' | 'SEARCH_EXHAUSTED' | 'EXECUTION_FAILED' | 'CANCELLED' | 'INTERRUPTED'
  runtime?: PluginExecutionIdentity
  createdAt: string
  startedAt?: string
  finishedAt?: string
  approvedTaskVersion?: number
  rounds: ScriptIterationRound[]
  bestRound?: number
  error?: string
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Iteration plan must be an object')
  return value as Record<string, unknown>
}
function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${label}`)
  return value
}
export function parseIterationPlan(value: unknown, script: ScriptDefinition & { id: string }): ScriptIterationPlan {
  const input = record(value)
  if (input.scriptId !== script.id) throw new Error('Iteration script identity mismatch')
  const parameters = resolveScriptParameters(script, input.parameters)
  if (!Array.isArray(input.adjustable) || input.adjustable.length < 1 || input.adjustable.length > 16) throw new Error('Choose 1 to 16 adjustable numeric parameters')
  const names = new Set<string>()
  const adjustable = input.adjustable.map(item => {
    const rule = record(item)
    if (typeof rule.name !== 'string' || names.has(rule.name)) throw new Error('Invalid or repeated adjustable parameter')
    names.add(rule.name)
    const spec = script.parameters[rule.name]
    if (!spec || !['number', 'integer'].includes(spec.type) || spec.enum) throw new Error('Adjustable parameters must have continuous numeric ranges (integer supported)')
    const minimum = number(rule.minimum, 'minimum'), maximum = number(rule.maximum, 'maximum')
    const step = number(rule.step, 'step'), minimumStep = number(rule.minimumStep, 'minimum step')
    const initial = parameters[rule.name]
    if (minimum >= maximum || minimumStep <= 0 || step < minimumStep || step > maximum - minimum ||
      typeof initial !== 'number' || initial < minimum || initial > maximum || spec.type === 'integer' && ![minimum, maximum, step, minimumStep].every(Number.isInteger)) throw new Error('Invalid iteration bounds or initial value')
    resolveScriptParameters(script, { ...parameters, [rule.name]: minimum })
    resolveScriptParameters(script, { ...parameters, [rule.name]: maximum })
    return { name: rule.name, minimum, maximum, step, minimumStep }
  })
  const maxRounds = number(input.maxRounds, 'round limit'), maxDurationMs = number(input.maxDurationMs, 'time limit')
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 64 || !Number.isInteger(maxDurationMs) || maxDurationMs < 1000 || maxDurationMs > 24 * 60 * 60_000) throw new Error('Iteration budget exceeds supported limits')
  if (typeof input.setup !== 'string' || !input.setup.trim() || input.setup.length > 200 || input.setup.includes('\0')) throw new Error('A specific solver setup is required')
  if (input.design !== undefined && (typeof input.design !== 'string' || !input.design.trim() || input.design.length > 200)) throw new Error('Invalid design')
  if (input.cores !== undefined && (typeof input.cores !== 'number' || !Number.isInteger(input.cores) || input.cores < 1 || input.cores > 256)) throw new Error('Invalid core count')
  return { scriptId: script.id, parameters, adjustable, targetTmaxC: number(input.targetTmaxC, 'temperature target'), maxRounds, maxDurationMs,
    setup: input.setup.trim(), ...(input.design ? { design: input.design as string } : {}), ...(input.cores ? { cores: input.cores as number } : {}) }
}
const key = (parameters: Record<string, unknown>) => JSON.stringify(Object.keys(parameters).sort().map(name => [name, parameters[name]]))
/** Bounded coordinate search around the best converged point; never assumes monotonic thermal response. */
export function nextIterationParameters(plan: ScriptIterationPlan, rounds: ScriptIterationRound[]): Record<string, unknown> | null {
  if (!rounds.length) return structuredClone(plan.parameters)
  const successful = rounds.filter(round => round.status === 'SUCCEEDED' && Number.isFinite(round.tmaxC))
  if (!successful.length) return null
  const best = successful.reduce((a, b) => a.tmaxC! <= b.tmaxC! ? a : b)
  const visited = new Set(rounds.map(round => key(round.parameters)))
  for (let level = 0; level <= 32; level++) {
    let hasStep = false
    for (const bound of plan.adjustable) {
      const step = Math.max(bound.minimumStep, bound.step / 2 ** level)
      hasStep ||= step > bound.minimumStep
      for (const direction of [1, -1]) {
        // Integer minimum steps make every generated point integral; round finer fractional levels to that grid.
        const delta = Math.max(bound.minimumStep, Math.floor(step / bound.minimumStep) * bound.minimumStep)
        const value = Math.min(bound.maximum, Math.max(bound.minimum, Number((Number(best.parameters[bound.name]) + direction * delta).toPrecision(14))))
        const candidate = { ...best.parameters, [bound.name]: value }
        if (!visited.has(key(candidate))) return candidate
      }
    }
    if (!hasStep) break
  }
  return null
}
