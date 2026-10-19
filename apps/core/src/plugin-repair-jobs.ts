import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface RepairTarget { basePackageDigest: string; environmentDigest: string }
type Outcome = 'candidate-ready' | 'failed' | 'timed-out' | 'cancelled' | 'interrupted'
export interface RepairJob extends RepairTarget {
  id: string; sessionId: string; requestId: string; startedAt: number; deadline: number
  state: 'dispatching' | 'running' | 'stopping' | Outcome
  outcome?: Outcome; candidateId?: string; error?: string
}
export interface RepairJobInputs {
  enabled: boolean
  canDispatch?: boolean
  targets: RepairTarget[]
  candidates: Array<RepairTarget & { id: string }>
}
export interface RepairJobTransport {
  dispatch(job: Readonly<RepairJob>): Promise<void>
  stop(job: Readonly<RepairJob>): Promise<void>
}
const digest = /^[a-f0-9]{64}$/u
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const live = (job: RepairJob) => ['dispatching', 'running', 'stopping'].includes(job.state)
const identity = (target: RepairTarget) => {
  if (!digest.test(target.basePackageDigest) || !digest.test(target.environmentDigest)) throw new Error('Invalid repair job target')
  return createHash('sha256').update(`${target.basePackageDigest}:${target.environmentDigest}`).digest('hex')
}
const outcomes: Outcome[] = ['candidate-ready', 'failed', 'timed-out', 'cancelled', 'interrupted']

/** Host-owned admission ledger. Persist before IO; an ambiguous submission is never automatically retried. */
export class PluginRepairJobs {
  private jobs: RepairJob[] = []
  private pending?: Promise<void>
  private closing = false
  private sealed = false
  private error?: string

  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(path), { recursive: true })
    if (!existsSync(path)) return
    const bytes = readFileSync(path)
    if (bytes.length > 256 * 1024) throw new Error('Repair job ledger exceeds limit')
    const value = JSON.parse(bytes.toString()) as { schemaVersion: number; jobs: RepairJob[] }
    if (value.schemaVersion !== 1 || !Array.isArray(value.jobs) || value.jobs.length > 64) throw new Error('Invalid repair job ledger')
    const ids = new Set<string>()
    for (const job of value.jobs) {
      if (!job || job.id !== identity(job) || ids.has(job.id) || !new RegExp(`^session-${uuid}$`, 'u').test(job.sessionId) ||
        !new RegExp(`^repair-${uuid}$`, 'u').test(job.requestId) || !Number.isSafeInteger(job.startedAt) || job.startedAt < 0 ||
        job.deadline !== job.startedAt + 300_000 || !['dispatching', 'running', 'stopping', ...outcomes].includes(job.state) ||
        job.outcome !== undefined && !outcomes.includes(job.outcome) || job.state === 'stopping' && !job.outcome ||
        job.candidateId !== undefined && !digest.test(job.candidateId) || job.error !== undefined && (typeof job.error !== 'string' || job.error.length > 500)) throw new Error('Invalid repair job record')
      ids.add(job.id)
    }
    this.jobs = value.jobs
    if (this.jobs.some(live)) this.commit(this.jobs.map(job => live(job) ? { ...job, state: 'stopping', outcome: job.state === 'stopping' ? job.outcome : 'interrupted' } : job))
  }

  status() { return { jobs: structuredClone(this.jobs), error: this.error, capacity: 64, attemptsPerTarget: 1, timeoutMs: 300_000 } }

  reconcile(inputs: () => RepairJobInputs, transport: RepairJobTransport): Promise<void> {
    if (this.sealed) return Promise.resolve()
    if (this.pending) return this.pending
    const task = this.run(inputs, transport).catch(error => { this.error = String(error instanceof Error ? error.message : error).slice(0, 500) })
    this.pending = task
    void task.then(() => { if (this.pending === task) this.pending = undefined })
    return task
  }

  async close(transport: RepairJobTransport): Promise<void> {
    this.closing = true
    await this.pending
    await this.reconcile(() => ({ enabled: false, targets: [], candidates: [] }), transport)
  }

  async stopActive(transport: RepairJobTransport): Promise<void> {
    await this.pending
    await this.reconcile(() => ({ enabled: false, targets: [], candidates: [] }), transport)
  }

  /** The PluginHost must drain outstanding ledger writes before releasing its directory ownership. */
  async seal(): Promise<void> {
    this.closing = true
    this.sealed = true
    await this.pending
  }

  private commit(jobs: RepairJob[]): void {
    const temp = `${this.path}.${randomUUID()}.tmp`
    try {
      const fd = openSync(temp, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, jobs })); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temp, this.path)
    } finally { rmSync(temp, { force: true }) }
    this.jobs = jobs
  }
  private update(id: string, patch: Partial<RepairJob>): RepairJob {
    this.commit(this.jobs.map(job => job.id === id ? { ...job, ...patch } : job))
    return this.jobs.find(job => job.id === id)!
  }
  private async stop(job: RepairJob, outcome: Outcome, transport: RepairJobTransport, candidateId?: string): Promise<void> {
    job = this.update(job.id, { state: 'stopping', outcome, candidateId: candidateId ?? job.candidateId })
    await transport.stop(structuredClone(job))
    this.update(job.id, { state: outcome })
  }
  private async run(read: () => RepairJobInputs, transport: RepairJobTransport): Promise<void> {
    this.error = undefined
    let input = read()
    for (const job of this.jobs.filter(live)) {
      const candidate = input.candidates.find(item => identity(item) === job.id)
      if (job.state === 'stopping') await this.stop(job, job.outcome!, transport)
      else if (candidate) await this.stop(job, 'candidate-ready', transport, candidate.id)
      else if (this.closing || !input.enabled || !input.targets.some(item => identity(item) === job.id)) await this.stop(job, 'cancelled', transport)
      else if (this.now() >= job.deadline) await this.stop(job, 'timed-out', transport)
    }
    input = read()
    if (this.closing || !input.enabled || input.canDispatch === false || this.jobs.some(live)) return
    const target = input.targets.find(item => !this.jobs.some(job => job.id === identity(item)) && !input.candidates.some(candidate => identity(candidate) === identity(item)))
    if (!target) return
    if (this.jobs.length >= 64) throw new Error('Repair job capacity reached (64); retained identities prevent automatic duplicate submissions')
    const startedAt = this.now()
    const job: RepairJob = { ...target, id: identity(target), sessionId: `session-${randomUUID()}`, requestId: `repair-${randomUUID()}`,
      startedAt, deadline: startedAt + 300_000, state: 'dispatching' }
    this.commit([...this.jobs, job])
    try {
      await transport.dispatch(structuredClone(job))
    } catch (error) {
      this.update(job.id, { error: String(error instanceof Error ? error.message : error).slice(0, 500) })
      await this.stop(job, 'failed', transport)
      return
    }
    this.update(job.id, { state: 'running' })
    const latest = read()
    if (this.closing || !latest.enabled || !latest.targets.some(item => identity(item) === job.id)) await this.stop(job, 'cancelled', transport)
    else if (this.now() >= job.deadline) await this.stop(job, 'timed-out', transport)
  }
}
