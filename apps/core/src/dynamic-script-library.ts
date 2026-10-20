import type { ScriptIteration } from './dynamic-script-search.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parsePluginExecutionIdentity, type PluginExecutionIdentity } from '@thermal-agent/contracts'

export interface ScriptParameter {
  type: 'number' | 'integer' | 'string' | 'boolean'
  description: string
  unit?: string
  required?: boolean
  default?: string | number | boolean
  minimum?: number
  maximum?: number
  enum?: Array<string | number | boolean>
}
export interface ScriptDefinition {
  name: string
  version: string
  description: string
  source: string
  parameters: Record<string, ScriptParameter>
  applicability: { aedtVersions: string[]; requiredObjects: string[] }
  tags: string[]
}
export interface ScriptRevision extends ScriptDefinition {
  id: string
  sourceSha256: string
  createdAt: string
  disabled: boolean
}
export interface ScriptRun {
  id: string
  taskId: string
  coreInstanceId?: string
  scriptId: string
  parameters: Record<string, unknown>
  projectSha256: string
  aedtVersion: string
  runtime: PluginExecutionIdentity
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'
  startedAt: string
  finishedAt?: string
  evidence?: { kind: 'test-double' | 'native-aedt'; level: 'script-reported-readback'; projectSha256: string; artifactSha256: string }
  error?: string
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const digest = /^[a-f0-9]{64}$/u
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}`)
  return value.trim()
}
function strings(value: unknown, label: string, limit = 128): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`Invalid ${label}`)
  return [...new Set(value.map(v => text(v, label)))].sort()
}
function checkValue(value: unknown, rule: ScriptParameter, name: string): void {
  if (rule.type === 'number' || rule.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || rule.type === 'integer' && !Number.isInteger(value)) throw new Error(`Invalid parameter ${name}`)
    if (rule.minimum !== undefined && value < rule.minimum || rule.maximum !== undefined && value > rule.maximum) throw new Error(`Parameter ${name} is out of range`)
  } else if (typeof value !== rule.type || typeof value === 'string' && (value.length > 4096 || value.includes('\0'))) throw new Error(`Invalid parameter ${name}`)
  if (rule.enum && !rule.enum.includes(value as string | number | boolean)) throw new Error(`Parameter ${name} is not an allowed value`)
}
export function parseScriptDefinition(value: unknown): ScriptDefinition {
  const input = object(value)
  if (typeof input.source !== 'string' || !input.source.trim() || Buffer.byteLength(input.source) > 128 * 1024 || input.source.includes('\0')) throw new Error('Invalid Python source')
  const raw = object(input.parameters)
  if (Object.keys(raw).length > 128) throw new Error('Too many script parameters')
  const parameters: Record<string, ScriptParameter> = Object.create(null)
  for (const name of Object.keys(raw).sort()) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/u.test(name) || ['constructor', 'prototype', '__proto__'].includes(name)) throw new Error('Invalid parameter name')
    const spec = object(raw[name])
    if (!['number', 'integer', 'string', 'boolean'].includes(String(spec.type))) throw new Error(`Invalid type for ${name}`)
    if (spec.required !== undefined && typeof spec.required !== 'boolean') throw new Error('Invalid required flag')
    const rule: ScriptParameter = { type: spec.type as ScriptParameter['type'], description: text(spec.description, 'parameter description', 1000), required: spec.required === true }
    if (spec.unit !== undefined) rule.unit = text(spec.unit, 'unit', 80)
    for (const bound of ['minimum', 'maximum'] as const) if (spec[bound] !== undefined) {
      if (!['number', 'integer'].includes(rule.type) || typeof spec[bound] !== 'number' || !Number.isFinite(spec[bound])) throw new Error('Invalid parameter bound')
      rule[bound] = spec[bound]
    }
    if (rule.minimum !== undefined && rule.maximum !== undefined && rule.minimum > rule.maximum) throw new Error('Inverted parameter range')
    if (spec.enum !== undefined) {
      if (!Array.isArray(spec.enum) || !spec.enum.length || spec.enum.length > 128) throw new Error('Invalid parameter enum')
      for (const item of spec.enum) checkValue(item, rule, name)
      rule.enum = spec.enum as ScriptParameter['enum']
    }
    if (spec.default !== undefined) { checkValue(spec.default, rule, name); rule.default = spec.default as ScriptParameter['default'] }
    parameters[name] = rule
  }
  const applicability = object(input.applicability)
  const aedtVersions = strings(applicability.aedtVersions, 'AEDT versions', 32)
  if (!aedtVersions.length) throw new Error('At least one explicit AEDT version is required')
  return { name: text(input.name, 'script name'), version: text(input.version, 'script version', 80),
    description: text(input.description, 'script description', 4000), source: input.source, parameters,
    applicability: { aedtVersions, requiredObjects: strings(applicability.requiredObjects, 'required objects') }, tags: strings(input.tags ?? [], 'tags', 32) }
}
export function resolveScriptParameters(script: ScriptDefinition, value: unknown): Record<string, unknown> {
  const supplied = object(value)
  for (const name of Object.keys(supplied)) if (!Object.hasOwn(script.parameters, name)) throw new Error(`Unknown parameter ${name}`)
  const resolved: Record<string, unknown> = Object.create(null)
  for (const [name, rule] of Object.entries(script.parameters)) {
    const value = Object.hasOwn(supplied, name) ? supplied[name] : rule.default
    if (value === undefined) { if (rule.required) throw new Error(`Missing parameter ${name}`); continue }
    checkValue(value, rule, name)
    resolved[name] = value
  }
  return resolved
}

/** Core-owned local library. Run receipts are accepted from the execution manager, never request bodies. */
export class DynamicScriptLibrary {
  private readonly db: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS dynamic_scripts(id TEXT PRIMARY KEY, definition TEXT NOT NULL, created_at TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS dynamic_script_runs(id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES dynamic_scripts(id), task_id TEXT NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dynamic_script_run_task ON dynamic_script_runs(task_id);
      CREATE TABLE IF NOT EXISTS dynamic_script_submissions(script_id TEXT NOT NULL REFERENCES dynamic_scripts(id), channel TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(script_id, channel, session_id));
      CREATE TABLE IF NOT EXISTS dynamic_script_iterations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL);`)
  }
  close(): void { this.db.close() }
  stage(value: unknown, provenance: { channel: 'app' | 'agent' | 'internal'; sessionId?: string } = { channel: 'internal' }): ScriptRevision {
    if (!['app', 'agent', 'internal'].includes(provenance.channel) || provenance.sessionId !== undefined && !/^[a-z0-9_-]{1,200}$/iu.test(provenance.sessionId)) throw new Error('Invalid script submission provenance')
    const definition = parseScriptDefinition(value)
    const json = JSON.stringify(definition)
    const id = hash(json)
    this.db.prepare('INSERT OR IGNORE INTO dynamic_scripts(id, definition, created_at) VALUES (?, ?, ?)').run(id, json, new Date().toISOString())
    this.db.prepare('INSERT OR IGNORE INTO dynamic_script_submissions VALUES (?, ?, ?, ?)').run(id, provenance.channel, provenance.sessionId ?? '', new Date().toISOString())
    return this.get(id)
  }
  get(id: string): ScriptRevision {
    const row = this.db.prepare('SELECT * FROM dynamic_scripts WHERE id = ?').get(id)
    if (!row) throw new Error('Script revision not found')
    const serialized = String(row.definition)
    if (hash(serialized) !== id) throw new Error('Script revision integrity check failed')
    const definition = parseScriptDefinition(JSON.parse(serialized))
    return { ...definition, id, sourceSha256: hash(definition.source), createdAt: String(row.created_at), disabled: row.disabled === 1 }
  }
  list(query = ''): ScriptRevision[] {
    const words = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
    return this.db.prepare('SELECT id FROM dynamic_scripts ORDER BY created_at DESC, id').all().map(row => this.get(String(row.id)))
      .filter(script => words.every(word => `${script.name} ${script.description} ${script.tags.join(' ')}`.toLocaleLowerCase().includes(word)))
  }
  disable(id: string, disabled: boolean): ScriptRevision {
    this.get(id)
    this.db.prepare('UPDATE dynamic_scripts SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id)
    return this.get(id)
  }
  beginRun(input: { taskId: string; coreInstanceId?: string; scriptId: string; parameters: unknown; projectSha256: string; aedtVersion: string; runtime: PluginExecutionIdentity }): ScriptRun {
    const script = this.get(input.scriptId)
    if (script.disabled) throw new Error('Script revision is disabled')
    if (!digest.test(input.projectSha256)) throw new Error('Invalid project digest')
    if (!script.applicability.aedtVersions.includes(input.aedtVersion)) throw new Error('Script does not support requested AEDT version')
    const run: ScriptRun = { id: randomUUID(), taskId: text(input.taskId, 'task id'), ...(input.coreInstanceId ? { coreInstanceId: text(input.coreInstanceId, 'Core instance') } : {}), scriptId: script.id,
      parameters: resolveScriptParameters(script, input.parameters), projectSha256: input.projectSha256, aedtVersion: input.aedtVersion,
      runtime: parsePluginExecutionIdentity(input.runtime) ?? (() => { throw new Error('Missing runtime identity') })(), status: 'RUNNING', startedAt: new Date().toISOString() }
    this.db.prepare('INSERT INTO dynamic_script_runs(id, script_id, task_id, status, record) VALUES (?, ?, ?, ?, ?)')
      .run(run.id, script.id, run.taskId, run.status, JSON.stringify(run))
    return run
  }
  getRun(id: string): ScriptRun {
    const row = this.db.prepare('SELECT record FROM dynamic_script_runs WHERE id = ?').get(id)
    if (!row) throw new Error('Script run not found')
    return JSON.parse(String(row.record)) as ScriptRun
  }
  runs(taskId?: string): ScriptRun[] {
    const rows = taskId === undefined ? this.db.prepare('SELECT record FROM dynamic_script_runs ORDER BY rowid').all()
      : this.db.prepare('SELECT record FROM dynamic_script_runs WHERE task_id = ? ORDER BY rowid').all(taskId)
    return rows.map(row => JSON.parse(String(row.record)) as ScriptRun)
  }
  finish(id: string, outcome: { status: 'SUCCEEDED'; evidence: NonNullable<ScriptRun['evidence']> } | { status: 'FAILED' | 'CANCELLED' | 'INTERRUPTED'; error: string }): ScriptRun {
    const run = this.getRun(id)
    if (outcome.status === 'SUCCEEDED' && (!digest.test(outcome.evidence.projectSha256) || !digest.test(outcome.evidence.artifactSha256) ||
      !['native-aedt', 'test-double'].includes(outcome.evidence.kind) || outcome.evidence.level !== 'script-reported-readback')) throw new Error('Invalid run evidence')
    const next: ScriptRun = { ...run, ...structuredClone(outcome), finishedAt: new Date().toISOString() }
    if ('error' in next) next.error = String(next.error).slice(0, 2000)
    const change = this.db.prepare("UPDATE dynamic_script_runs SET status = ?, record = ? WHERE id = ? AND status = 'RUNNING'")
      .run(next.status, JSON.stringify(next), id)
    if (change.changes !== 1) throw new Error('Script run is already terminal')
    return next
  }
  /** Caller must first establish exclusive Core ownership and reconcile live engineering processes. */
  recoverInterrupted(): number {
    let count = 0
    for (const run of this.runs()) if (run.status === 'RUNNING') {
      this.finish(run.id, { status: 'INTERRUPTED', error: 'Core stopped before a terminal execution receipt was saved' }); count++
    }
    return count
  }
  createIteration(value: Omit<ScriptIteration, 'id' | 'createdAt' | 'revision' | 'status' | 'rounds'>): ScriptIteration {
    this.get(value.plan.scriptId)
    const iteration: ScriptIteration = { ...structuredClone(value), id: randomUUID(), createdAt: new Date().toISOString(), revision: 1, status: 'DRAFT', rounds: [] }
    this.db.prepare('INSERT INTO dynamic_script_iterations VALUES (?, ?, ?, ?)').run(iteration.id, iteration.taskId, 1, JSON.stringify(iteration))
    return iteration
  }
  iteration(id: string): ScriptIteration {
    const row = this.db.prepare('SELECT record FROM dynamic_script_iterations WHERE id = ?').get(id)
    if (!row) throw new Error('Iteration not found')
    return JSON.parse(String(row.record)) as ScriptIteration
  }
  iterations(taskId?: string): ScriptIteration[] {
    const rows = taskId === undefined ? this.db.prepare('SELECT record FROM dynamic_script_iterations ORDER BY rowid').all()
      : this.db.prepare('SELECT record FROM dynamic_script_iterations WHERE task_id = ? ORDER BY rowid').all(taskId)
    return rows.map(row => JSON.parse(String(row.record)) as ScriptIteration)
  }
  saveIteration(value: ScriptIteration): ScriptIteration {
    const saved = this.iteration(value.id)
    if (saved.status === 'STOPPED' || value.taskId !== saved.taskId || value.projectSha256 !== saved.projectSha256 ||
      value.aedtVersion !== saved.aedtVersion || JSON.stringify(value.plan) !== JSON.stringify(saved.plan)) throw new Error('Iteration definition is immutable or already terminal')
    const next = { ...structuredClone(value), revision: value.revision + 1 }
    const change = this.db.prepare('UPDATE dynamic_script_iterations SET revision = ?, record = ? WHERE id = ? AND revision = ?')
      .run(next.revision, JSON.stringify(next), value.id, value.revision)
    if (change.changes !== 1) throw new Error('Iteration revision conflict')
    return next
  }
  submissions(id: string): Array<{ channel: string; sessionId?: string; recordedAt: string }> {
    this.get(id)
    return this.db.prepare('SELECT * FROM dynamic_script_submissions WHERE script_id = ? ORDER BY created_at').all(id)
      .map(row => ({ channel: String(row.channel), ...(row.session_id ? { sessionId: String(row.session_id) } : {}), recordedAt: String(row.created_at) }))
  }
  validationSummary(id: string, matchesCurrent: (identity: PluginExecutionIdentity) => boolean = () => false) {
    const script = this.get(id), runs = this.runs().filter(run => run.scriptId === id)
    const readbacks = runs.filter(run => run.status === 'SUCCEEDED' && run.evidence?.kind === 'native-aedt')
    const solves = this.iterations().filter(job => job.plan.scriptId === id).flatMap(job => job.rounds
      .filter(round => round.status === 'SUCCEEDED' && round.executionKind === 'native-aedt' && round.resultSha256 && round.solvedProjectSha256)
      .map(round => ({ iterationId: job.id, round: round.number, taskId: job.taskId, aedtVersion: job.aedtVersion, runtime: job.runtime, resultSha256: round.resultSha256 })))
    return { state: script.disabled ? 'disabled' : solves.length ? 'solve-recorded' : readbacks.length ? 'readback-recorded' : 'unverified',
      nativeReadbacks: readbacks.length, nativeSolves: solves.length,
      currentRuntimeReadbacks: readbacks.filter(run => matchesCurrent(run.runtime)).length,
      currentRuntimeSolves: solves.filter(run => run.runtime && matchesCurrent(run.runtime)).length,
      simulatedRuns: runs.filter(run => run.evidence?.kind === 'test-double').length,
      scopes: [...new Set(readbacks.map(run => run.aedtVersion))].sort(),
      submissions: this.submissions(id),
      latestFailure: runs.filter(run => run.status === 'FAILED').at(-1)?.error,
      evidenceScope: 'Historical receipts only; current project objects, parameters and engineering behavior still require checking' }
  }
  reusableEvidence(id: string, runtime: PluginExecutionIdentity, aedtVersion: string): ScriptRun[] {
    if (this.get(id).disabled || !runtime.packageDigest || !runtime.environmentDigest) return []
    return this.runs().filter(run => run.scriptId === id && run.status === 'SUCCEEDED' && run.evidence?.kind === 'native-aedt' &&
      run.aedtVersion === aedtVersion && run.runtime.packageDigest === runtime.packageDigest && run.runtime.environmentDigest === runtime.environmentDigest &&
      run.runtime.pluginId === runtime.pluginId && run.runtime.pluginVersion === runtime.pluginVersion)
  }
}
