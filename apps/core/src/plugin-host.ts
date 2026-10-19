import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PluginExecutionIdentity } from '@thermal-agent/contracts'
import { parseManagedPluginManifest } from '@thermal-agent/contracts'
import { PluginStore, type PluginLease } from './plugin-store.js'
import { PluginAdaptationController, type PluginAdaptationResult } from './plugin-adaptation.js'
import { managedPythonRuntime } from './plugin-python-runtime.js'
import { inspectPythonRuntime, type PythonRuntimeSnapshot } from './python-environment.js'
import { IcepakPluginClient, type IcepakPluginPort } from './icepak-plugin-client.js'
import { ReportClient, type ReportPort } from './report-client.js'
import { PluginReleaseInbox, parsePluginPublishers, type PluginPublisher } from './plugin-release.js'
import { validateReportRelease } from './plugin-report-validation.js'

type Kind = 'icepak' | 'report'
interface Policy { automaticUpdates: boolean; builtinDigests: string[]; held: Record<string, string> }
interface Runtime {
  id: string
  python: string
  source: string
  distributions: string[]
  permissions: string[]
  imported: boolean
  snapshot?: PythonRuntimeSnapshot
  inspectedAt: number
  pending?: Promise<void>
  result?: PluginAdaptationResult
  error?: string
}

/** Local Core owns installation, environment facts, policy, and activation. DSH consumes these services. */
export class PluginHost {
  readonly store: PluginStore
  readonly icepak: IcepakPluginPort
  readonly report: ReportPort
  private readonly controllers: Record<Kind, PluginAdaptationController>
  private readonly runtimes: Record<Kind, Runtime>
  private policy: Policy
  private readonly policyPath: string
  private timer?: NodeJS.Timeout
  private closed = false
  private readonly releases: PluginReleaseInbox
  private releaseStatus: ReturnType<PluginReleaseInbox['scan']> = { releases: [], errors: [] }

  constructor(private readonly home: string, options: {
    icepak?: { python: string; pluginRoot: string }
    report?: { python: string; pluginRoot: string }
    inspect?: typeof inspectPythonRuntime
    refreshMs?: number
    publishers?: () => PluginPublisher[]
  } = {}) {
    this.inspect = options.inspect ?? inspectPythonRuntime
    this.refreshMs = options.refreshMs ?? 5 * 60_000
    mkdirSync(home, { recursive: true })
    this.store = new PluginStore(join(home, 'registry'))
    this.releases = new PluginReleaseInbox(home, this.store, options.publishers ?? (() => {
      const path = join(home, 'publishers.json')
      return existsSync(path) ? parsePluginPublishers(JSON.parse(readFileSync(path, 'utf8'))) : []
    }))
    this.controllers = { icepak: new PluginAdaptationController(this.store), report: new PluginAdaptationController(this.store) }
    this.policyPath = join(home, 'policy.json')
    this.policy = existsSync(this.policyPath) ? this.readPolicy() : { automaticUpdates: true, builtinDigests: [], held: {} }
    const icepak = options.icepak ?? new IcepakPluginClient().runtimeConfiguration()
    const report = options.report ?? new ReportClient().runtimeConfiguration()
    this.runtimes = {
      icepak: { id: 'icepak-pyaedt', python: icepak.python, source: icepak.pluginRoot, distributions: ['pyaedt'],
        permissions: ['engineering-copy-write', 'aedt-launch'], imported: false, inspectedAt: 0 },
      report: { id: 'report-reportlab', python: report.python, source: report.pluginRoot, distributions: ['reportlab', 'pypdf'],
        permissions: ['report-write'], imported: false, inspectedAt: 0 },
    }
    const icepakClient = new IcepakPluginClient({ acquireRuntime: expected => this.acquire('icepak', expected) })
    this.icepak = new Proxy(icepakClient, { get: (target, key) => {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        await this.ensure('icepak')
        return value.apply(target, args)
      }
    } })
    const reporter = new ReportClient({ acquireRuntime: () => this.acquire('report') })
    this.report = { renderTaskReport: async input => { await this.ensure('report'); return reporter.renderTaskReport(input) } }
  }

  private readonly inspect: typeof inspectPythonRuntime
  private readonly refreshMs: number

  private readPolicy(): Policy {
    const value = JSON.parse(readFileSync(this.policyPath, 'utf8')) as Policy
    if (typeof value.automaticUpdates !== 'boolean' || !Array.isArray(value.builtinDigests) ||
      value.builtinDigests.some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) ||
      !value.held || typeof value.held !== 'object' || Array.isArray(value.held) ||
      Object.entries(value.held).some(([id, digest]) => !['icepak-pyaedt', 'report-reportlab'].includes(id) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest))) throw new Error('Invalid plugin update policy')
    return value
  }

  private savePolicy(policy: Policy): void {
    const path = join(this.home, `policy-${randomUUID()}.tmp`)
    writeFileSync(path, JSON.stringify(policy), { flag: 'wx', mode: 0o600 })
    try { renameSync(path, this.policyPath) }
    catch (error) { rmSync(path, { force: true }); throw error }
    this.policy = policy
  }

  setAutomaticUpdates(enabled: boolean): void {
    this.savePolicy({ ...this.policy, automaticUpdates: enabled })
  }

  status() {
    const registry = this.store.list()
    return { automaticUpdates: this.policy.automaticUpdates, held: { ...this.policy.held }, releases: this.releaseStatus,
      runtimes: Object.entries(this.runtimes).map(([kind, runtime]) => ({ kind, id: runtime.id,
        phase: runtime.pending ? 'checking' : runtime.error ? 'unavailable' : runtime.snapshot ? 'ready' : 'pending',
        environment: runtime.snapshot?.environment, inspectedAt: runtime.inspectedAt || null,
        busy: this.store.isBusy(runtime.id), result: runtime.result, error: runtime.error })), ...registry }
  }

  /** The CLI starts this loop; embedded Core users can rely on lazy first-call initialization. */
  start(): void {
    if (this.timer || this.closed) return
    void this.reconcile()
    this.timer = setInterval(() => void this.reconcile(), this.refreshMs)
    this.timer.unref()
  }

  async reconcile(): Promise<ReturnType<PluginHost['status']>> {
    for (const kind of ['icepak', 'report'] as const) {
      try { await this.ensure(kind, true) }
      catch { /* Runtime-specific diagnostics are exposed in status; one unavailable solver must not hide the other. */ }
    }
    return this.status()
  }

  installRelease(bytes: Buffer) {
    if (this.closed) throw new Error('Plugin host is closed')
    const release = this.releases.accept(bytes)
    this.releaseStatus = this.releases.scan()
    // Registration never activates a candidate or executes its code.
    for (const runtime of Object.values(this.runtimes)) runtime.inspectedAt = 0
    return release
  }

  private trustedDigests(): string[] {
    return [...this.policy.builtinDigests, ...this.releaseStatus.releases.filter(release => release.id === 'report-reportlab').map(release => release.digest)]
  }

  async rollback(id: string): Promise<void> {
    const kind = this.kindFor(id), runtime = this.runtimes[kind]
    await this.ensure(kind)
    const previous = this.store.list().active[id]?.previous
    if (!previous || !this.trustedDigests().includes(previous)) throw new Error('No trusted previous plugin revision')
    const oldPolicy = this.policy
    this.savePolicy({ ...this.policy, held: { ...this.policy.held, [id]: previous } })
    try { this.store.rollback(id, runtime.snapshot!.environment, runtime.permissions) }
    catch (error) { this.savePolicy(oldPolicy); throw error }
  }

  resume(id: string): void {
    this.kindFor(id)
    const held = { ...this.policy.held }; delete held[id]
    this.savePolicy({ ...this.policy, held })
  }

  private kindFor(id: string): Kind {
    if (id === 'icepak-pyaedt') return 'icepak'
    if (id === 'report-reportlab') return 'report'
    throw new Error('Unknown managed plugin')
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    await Promise.allSettled(Object.values(this.runtimes).flatMap(runtime => runtime.pending ? [runtime.pending] : []))
  }

  private acquire(kind: Kind, expected?: PluginExecutionIdentity) {
    const runtime = this.runtimes[kind]
    if (this.closed || !runtime.snapshot || runtime.error) throw new Error(runtime.error ?? 'Plugin runtime is unavailable')
    const digest = expected?.packageDigest ?? this.store.list().active[runtime.id]?.current
    if (!digest || !this.trustedDigests().includes(digest)) throw new Error('Plugin release is no longer trusted')
    return managedPythonRuntime(this.store, runtime.id, kind, runtime.snapshot.executable, () => runtime.snapshot!.environment)(expected)
  }

  private async ensure(kind: Kind, force = false): Promise<void> {
    if (this.closed) throw new Error('Plugin host is closed')
    const runtime = this.runtimes[kind]
    if (runtime.pending) return runtime.pending
    if (this.store.isBusy(runtime.id)) {
      runtime.result = { status: 'busy', diagnostics: ['Waiting for current engineering work to finish'] }
      if (!runtime.snapshot) throw new Error('Plugin runtime is busy before initialization')
      return
    }
    if (!force && runtime.snapshot && !runtime.error && Date.now() - runtime.inspectedAt < this.refreshMs) return
    const pending = this.refresh(kind)
    runtime.pending = pending
    try { await pending }
    finally { if (runtime.pending === pending) runtime.pending = undefined }
  }

  private importBuiltin(kind: Kind): void {
    const runtime = this.runtimes[kind]
    const manifest = parseManagedPluginManifest(JSON.parse(readFileSync(join(runtime.source, 'plugin.json'), 'utf8')))
    if (manifest.id !== runtime.id || manifest.kind !== kind) throw new Error('Bundled plugin identity mismatch')
    const staging = mkdtempSync(join(this.home, 'builtin-'))
    try {
      writeFileSync(join(staging, 'plugin.json'), JSON.stringify(manifest))
      cpSync(runtime.source, join(staging, manifest.entry.root), { recursive: true, dereference: false,
        filter: source => source === runtime.source || !['__pycache__', 'plugin.json', '.DS_Store'].includes(basename(source)) && !/\.py[co]$/u.test(source) })
      const revision = this.store.install(staging)
      if (!this.policy.builtinDigests.includes(revision.digest)) this.savePolicy({ ...this.policy, builtinDigests: [...this.policy.builtinDigests, revision.digest] })
      runtime.imported = true
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }

  private async refresh(kind: Kind): Promise<void> {
    const runtime = this.runtimes[kind]
    try {
      if (!runtime.imported) this.importBuiltin(kind)
      this.releaseStatus = this.releases.scan()
      const snapshot = await this.inspect(runtime.python, runtime.distributions)
      if (this.closed) throw new Error('Plugin host is closed')
      // A workflow may have started while the environment scan was in flight. Never change its facts.
      if (this.store.isBusy(runtime.id)) { runtime.result = { status: 'busy', diagnostics: [] }; return }
      runtime.snapshot = snapshot
      const registry = this.store.list(), active = registry.active[runtime.id]?.current
      const held = this.policy.held[runtime.id]
      const trusted = this.trustedDigests().filter(digest => !held || digest === held)
      const selected = !this.policy.automaticUpdates && active ? trusted.filter(digest => digest === active) : trusted
      runtime.result = await this.controllers[kind].reconcile(runtime.id, snapshot.environment,
        { enabled: true, trustedDigests: selected, permissions: runtime.permissions }, lease => this.validateRelease(kind, lease, snapshot))
      if (runtime.result.status === 'unavailable') throw new Error(runtime.result.diagnostics.join('; ') || 'No compatible trusted plugin')
      runtime.error = undefined
      runtime.inspectedAt = Date.now()
    } catch (error) {
      runtime.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private async validateRelease(kind: Kind, lease: PluginLease, snapshot: PythonRuntimeSnapshot) {
    // Signed reports have a host fixture; external engineering adapters still require an engineering validator.
    if (!this.trustedDigests().includes(lease.revision.digest)) throw new Error('Plugin is not a trusted executable release')
    const acquireRuntime = () => ({ python: snapshot.executable, pluginRoot: lease.root, module: lease.revision.manifest.entry.module, release() {} })
    const client = kind === 'icepak' ? new IcepakPluginClient({ acquireRuntime }) : new ReportClient({ acquireRuntime })
    const health = await client.health() as { pluginId?: string; pluginVersion?: string; protocolVersion?: string; status?: string }
    const passed = health.pluginId === lease.revision.manifest.id && health.pluginVersion === lease.revision.manifest.version && health.protocolVersion === '1.0.0' && health.status === 'ok'
    const checks = [{ name: 'release-protocol', passed, detail: 'Code identity and protocol only; engineering compatibility and solve readiness require separate evidence' }]
    if (passed && kind === 'report' && !this.policy.builtinDigests.includes(lease.revision.digest)) {
      checks.push(...await validateReportRelease(client as ReportClient, snapshot.executable, this.home))
    }
    return checks
  }
}
