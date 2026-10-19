import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PluginExecutionIdentity } from '@thermal-agent/contracts'
import { parseManagedPluginManifest } from '@thermal-agent/contracts'
import { PluginStore, pluginEnvironmentDigest, type PluginLease } from './plugin-store.js'
import { PluginAdaptationController, type PluginAdaptationResult } from './plugin-adaptation.js'
import { managedPythonRuntime } from './plugin-python-runtime.js'
import { inspectPythonRuntime, type PythonRuntimeSnapshot } from './python-environment.js'
import { IcepakPluginClient, type IcepakPluginPort } from './icepak-plugin-client.js'
import { ReportClient, type ReportPort } from './report-client.js'
import { PluginReleaseInbox, parsePluginPublishers, type PluginPublisher } from './plugin-release.js'
import { validateReportRelease } from './plugin-report-validation.js'
import { PluginUpdateFeed } from './plugin-update-feed.js'
import type { ModelPreparationStore } from '@thermal-agent/sqlite-store'
import { withIcepakOperation } from './icepak-operation-lock.js'
import { ENGINEERING_CAPABILITIES, engineeringPolicyBinding, parseEngineeringValidationPolicy, validateEngineeringPlugin, type EngineeringValidationPolicy } from './plugin-engineering-validation.js'
import { realpath } from 'node:fs/promises'
import { inspectAedtEnvironment } from './aedt-environment.js'
import { PluginPythonEnvironments } from './plugin-python-environment.js'

type Kind = 'icepak' | 'report'
interface Policy { automaticUpdates: boolean; builtinDigests: string[]; held: Record<string, string> }
interface Runtime {
  id: string
  python: string
  source: string
  distributions: string[]
  permissions: string[]
  imported: boolean
  builtinDigest?: string
  engineeringPolicy?: EngineeringValidationPolicy
  engineeringDiagnostic?: string
  aedtInstallations?: Array<{ source: string; root: string; status: string; fileCount: number }>
  snapshot?: PythonRuntimeSnapshot
  baseSnapshot?: PythonRuntimeSnapshot
  snapshots: Map<string, PythonRuntimeSnapshot>
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
  private readonly updates: PluginUpdateFeed
  private engineeringStore?: ModelPreparationStore
  private validationAbort?: AbortController
  private readonly preparationAborts = new Set<AbortController>()
  private readonly preparationTasks = new Map<string, Promise<PythonRuntimeSnapshot>>()
  private readonly pythonEnvironments: PluginPythonEnvironments
  private releaseStatus: ReturnType<PluginReleaseInbox['scan']> = { releases: [], errors: [] }

  constructor(private readonly home: string, options: {
    icepak?: { python: string; pluginRoot: string }
    report?: { python: string; pluginRoot: string }
    inspect?: typeof inspectPythonRuntime
    refreshMs?: number
    publishers?: () => PluginPublisher[]
    updateSources?: () => unknown
    fetchUpdates?: typeof fetch
  } = {}) {
    this.inspect = options.inspect ?? inspectPythonRuntime
    this.refreshMs = options.refreshMs ?? 5 * 60_000
    mkdirSync(home, { recursive: true })
    this.store = new PluginStore(join(home, 'registry'))
    this.pythonEnvironments = new PluginPythonEnvironments(join(home, 'python-environments'))
    this.releases = new PluginReleaseInbox(home, this.store, options.publishers ?? (() => {
      const path = join(home, 'publishers.json')
      return existsSync(path) ? parsePluginPublishers(JSON.parse(readFileSync(path, 'utf8'))) : []
    }))
    this.updates = new PluginUpdateFeed(this.releases, options.updateSources ?? (() => {
      const path = join(home, 'update-sources.json')
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
    }), options.fetchUpdates)
    this.controllers = { icepak: new PluginAdaptationController(this.store), report: new PluginAdaptationController(this.store) }
    this.policyPath = join(home, 'policy.json')
    this.policy = existsSync(this.policyPath) ? this.readPolicy() : { automaticUpdates: true, builtinDigests: [], held: {} }
    const icepak = options.icepak ?? new IcepakPluginClient().runtimeConfiguration()
    const report = options.report ?? new ReportClient().runtimeConfiguration()
    this.runtimes = {
      icepak: { id: 'icepak-pyaedt', python: icepak.python, source: icepak.pluginRoot, distributions: ['pyaedt'],
        permissions: ['engineering-copy-write', 'aedt-launch'], imported: false, inspectedAt: 0, snapshots: new Map() },
      report: { id: 'report-reportlab', python: report.python, source: report.pluginRoot, distributions: ['reportlab', 'pypdf'],
        permissions: ['report-write'], imported: false, inspectedAt: 0, snapshots: new Map() },
    }
    const icepakClient = new IcepakPluginClient({ acquireRuntime: expected => this.acquire('icepak', expected) })
    this.icepak = new Proxy(icepakClient, { get: (target, key) => {
      if (key === 'prepareRuntime') return () => this.ensure('icepak')
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        await this.ensure('icepak')
        if (key === 'pinRuntime' && (args[0] as PluginExecutionIdentity | undefined)?.packageDigest) {
          await this.prepareSnapshot('icepak', (args[0] as PluginExecutionIdentity).packageDigest!)
        }
        return value.apply(target, args)
      }
    } })
    const reporter = new ReportClient({ acquireRuntime: () => this.acquire('report') })
    this.report = { renderTaskReport: async input => { await this.ensure('report'); return reporter.renderTaskReport(input) } }
  }

  private readonly inspect: typeof inspectPythonRuntime
  private readonly refreshMs: number

  attachEngineeringStore(store: ModelPreparationStore): void {
    if (this.engineeringStore && this.engineeringStore !== store) throw new Error('Engineering validation store is already attached')
    this.engineeringStore = store
  }

  /** Invalidate cached capability advertisements as soon as a managed runtime changes. */
  isCurrentIcepakRuntime(identity?: PluginExecutionIdentity): boolean {
    const runtime = this.runtimes.icepak
    const registry = this.store.list()
    return !!identity?.packageDigest && !this.closed && !runtime.error && !runtime.pending && !!runtime.snapshot &&
      identity.pluginId === runtime.id && registry.active[runtime.id]?.current === identity.packageDigest &&
      registry.revisions.find(revision => revision.digest === identity.packageDigest)?.manifest.version === identity.pluginVersion &&
      identity.environmentDigest === pluginEnvironmentDigest(runtime.snapshot.environment) && this.trustedDigests().includes(identity.packageDigest)
  }

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
    if (!enabled) this.updates.cancel()
    if (!enabled) this.validationAbort?.abort()
    if (!enabled) for (const controller of this.preparationAborts) controller.abort()
  }

  status() {
    const registry = this.store.list()
    return { automaticUpdates: this.policy.automaticUpdates, held: { ...this.policy.held }, releases: this.releaseStatus, updates: this.updates.status(),
      runtimes: Object.entries(this.runtimes).map(([kind, runtime]) => ({ kind, id: runtime.id,
        phase: runtime.pending ? 'checking' : runtime.error ? 'unavailable' : runtime.snapshot ? 'ready' : 'pending',
        environment: runtime.snapshot?.environment, inspectedAt: runtime.inspectedAt || null,
        pythonExecutable: runtime.snapshot?.executable,
        dependencyMode: registry.revisions.find(item => item.digest === registry.active[runtime.id]?.current)?.manifest.pythonRuntime ? 'isolated' : 'base',
        aedtInstallations: runtime.aedtInstallations,
        busy: this.store.isBusy(runtime.id), result: runtime.result, error: runtime.error,
        engineeringValidation: kind === 'icepak' ? { configured: !!runtime.engineeringPolicy, diagnostic: runtime.engineeringDiagnostic,
          supportedCapabilities: ENGINEERING_CAPABILITIES } : undefined })), ...registry }
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
    // Make local versions available first; an unreachable update server must not hold startup hostage.
    if (this.closed) return this.status()
    const updates = await this.updates.poll(this.policy.automaticUpdates)
    if (updates.downloaded && !this.closed) {
      for (const kind of ['icepak', 'report'] as const) {
        try { await this.ensure(kind, true) }
        catch { /* A rejected update keeps diagnostics and the last usable trusted version. */ }
      }
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
    const revisions = this.store.list().revisions
    return [...this.policy.builtinDigests, ...this.releaseStatus.releases.filter(release => {
      if (release.id === 'report-reportlab') return true
      if (release.id !== 'icepak-pyaedt' || !this.runtimes.icepak.engineeringPolicy || !this.engineeringStore) return false
      const manifest = revisions.find(revision => revision.digest === release.digest)?.manifest
      return manifest?.kind === 'icepak' && ENGINEERING_CAPABILITIES.every(capability => manifest.capabilities.includes(capability)) &&
        manifest.capabilities.every(capability => (ENGINEERING_CAPABILITIES as readonly string[]).includes(capability))
    }).map(release => release.digest)]
  }

  async rollback(id: string): Promise<void> {
    const kind = this.kindFor(id), runtime = this.runtimes[kind]
    await this.ensure(kind)
    const previous = this.store.list().active[id]?.previous
    if (!previous || !this.trustedDigests().includes(previous)) throw new Error('No trusted previous plugin revision')
    const snapshot = await this.prepareSnapshot(kind, previous)
    const oldPolicy = this.policy
    this.savePolicy({ ...this.policy, held: { ...this.policy.held, [id]: previous } })
    try { this.store.rollback(id, snapshot.environment, runtime.permissions); runtime.snapshot = snapshot }
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
    this.validationAbort?.abort()
    for (const controller of this.preparationAborts) controller.abort()
    await this.updates.close()
    await Promise.allSettled(Object.values(this.runtimes).flatMap(runtime => runtime.pending ? [runtime.pending] : []))
    await Promise.allSettled([...this.preparationTasks.values()])
  }

  private acquire(kind: Kind, expected?: PluginExecutionIdentity) {
    const runtime = this.runtimes[kind]
    if (this.closed || !runtime.snapshot || runtime.error) throw new Error(runtime.error ?? 'Plugin runtime is unavailable')
    const digest = expected?.packageDigest ?? this.store.list().active[runtime.id]?.current
    if (!digest || !this.trustedDigests().includes(digest)) throw new Error('Plugin release is no longer trusted')
    const snapshot = runtime.snapshots.get(digest)
    if (!snapshot) throw new Error('Plugin dependency runtime has not been prepared')
    return managedPythonRuntime(this.store, runtime.id, kind, snapshot.executable, () => snapshot.environment)(expected)
  }

  private prepareSnapshot(kind: Kind, digest: string): Promise<PythonRuntimeSnapshot> {
    const base = this.runtimes[kind].baseSnapshot
    const key = `${kind}:${digest}:${base ? pluginEnvironmentDigest(base.environment) : 'uninitialized'}`
    const existing = this.preparationTasks.get(key)
    if (existing) return existing
    const pending = this.prepareSnapshotWork(kind, digest).finally(() => {
      if (this.preparationTasks.get(key) === pending) this.preparationTasks.delete(key)
    })
    this.preparationTasks.set(key, pending)
    return pending
  }

  private async prepareSnapshotWork(kind: Kind, digest: string): Promise<PythonRuntimeSnapshot> {
    const runtime = this.runtimes[kind], base = runtime.baseSnapshot
    if (this.closed || !base || !this.trustedDigests().includes(digest)) throw new Error('No trusted runtime preparation context')
    const revision = this.store.verify(digest)
    if (revision.manifest.id !== runtime.id) throw new Error('Runtime package identity mismatch')
    const controller = new AbortController()
    this.preparationAborts.add(controller)
    try {
      const snapshot = await this.pythonEnvironments.prepare({ digest, root: join(this.home, 'registry', 'packages', digest, revision.manifest.entry.root),
        manifest: revision.manifest, base, distributions: runtime.distributions, signal: controller.signal })
      this.store.verify(digest)
      if (this.closed || controller.signal.aborted) throw Object.assign(new Error('Runtime preparation cancelled'), { code: 'VALIDATION_DEFERRED' })
      runtime.snapshots.set(digest, snapshot)
      return snapshot
    } finally { this.preparationAborts.delete(controller) }
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
    // A deferred cycle may have sampled new facts without validating the retained version.
    // Never cache it as ready: the next call must reconcile before acquiring a lease.
    if (!force && runtime.snapshot && !runtime.error && runtime.result?.status !== 'busy' && Date.now() - runtime.inspectedAt < this.refreshMs) return
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
      runtime.builtinDigest = revision.digest
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
      let aedtInstallations: Runtime['aedtInstallations']
      if (this.closed) throw new Error('Plugin host is closed')
      // A workflow may have started while the environment scan was in flight. Never change its facts.
      if (this.store.isBusy(runtime.id)) { runtime.result = { status: 'busy', diagnostics: [] }; return }
      if (kind === 'icepak') {
        // Busy engineering work keeps both the old runtime facts and its process fence.
        if (this.engineeringStore?.reconcileRecoveredOperation()) {
          runtime.result = { status: 'busy', diagnostics: ['Waiting for the shared AEDT operation gate'] }
          if (!runtime.snapshot) throw new Error('Engineering operation is busy before plugin initialization')
          return
        }
        runtime.engineeringPolicy = undefined
        runtime.engineeringDiagnostic = undefined
        const aedt = await inspectAedtEnvironment(snapshot.environment.platform)
        snapshot.environment.versions['aedt-installations'] = aedt.digest
        aedtInstallations = aedt.installations.map(item => ({ source: item.source, root: item.resolvedRoot ?? item.root,
          status: item.status, fileCount: item.files.length }))
        const path = join(this.home, 'engineering-validation.json')
        if (existsSync(path)) {
          try {
            const policy = parseEngineeringValidationPolicy(JSON.parse(readFileSync(path, 'utf8')))
            if (!this.engineeringStore || snapshot.environment.platform !== 'win32') throw new Error('Engineering upgrades require the Windows Core operation gate')
            const match = /^(20\d{2})\.([1-9])$/u.exec(policy.aedtVersion)
            const install = match ? process.env[`ANSYSEM_ROOT${match[1].slice(2)}${match[2]}`] : undefined
            if (!install || (await realpath(join(install, 'ansysedt.exe'))).toLowerCase() !== (await realpath(policy.aedtExecutablePath)).toLowerCase()) throw new Error('Configured AEDT executable must match the selected ANSYSEM_ROOT installation')
            snapshot.environment.versions['engineering-validation'] = await engineeringPolicyBinding(policy, runtime.builtinDigest!)
            runtime.engineeringPolicy = policy
          } catch (error) { runtime.engineeringDiagnostic = error instanceof Error ? error.message : String(error) }
        }
      }
      // Filesystem hashing and fixture binding can yield while pinned work acquires a lease.
      if (this.store.isBusy(runtime.id) || kind === 'icepak' && this.engineeringStore?.reconcileRecoveredOperation()) {
        runtime.result = { status: 'busy', diagnostics: ['Environment refresh deferred until current work finishes'] }
        if (!runtime.snapshot) throw new Error('Engineering operation is busy before plugin initialization')
        return
      }
      if (this.closed) throw new Error('Plugin host is closed')
      runtime.snapshot = snapshot
      runtime.baseSnapshot = snapshot
      runtime.aedtInstallations = aedtInstallations
      const registry = this.store.list(), active = registry.active[runtime.id]?.current
      const held = this.policy.held[runtime.id]
      const trusted = this.trustedDigests().filter(digest => !held || digest === held)
      const selected = !this.policy.automaticUpdates && active ? trusted.filter(digest => digest === active) : trusted
      runtime.result = await this.controllers[kind].reconcile(runtime.id, snapshot.environment,
        { enabled: true, trustedDigests: selected, permissions: runtime.permissions },
        lease => this.validateRelease(kind, lease, runtime.snapshots.get(lease.revision.digest)!),
        async revision => (await this.prepareSnapshot(kind, revision.digest)).environment)
      const current = this.store.list().active[runtime.id]?.current
      if (current && runtime.snapshots.has(current)) runtime.snapshot = runtime.snapshots.get(current)
      if (runtime.result.status === 'unavailable') throw new Error(runtime.result.diagnostics.join('; ') || 'No compatible trusted plugin')
      runtime.error = undefined
      runtime.inspectedAt = Date.now()
    } catch (error) {
      runtime.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private async validateRelease(kind: Kind, lease: PluginLease, snapshot: PythonRuntimeSnapshot) {
    const checkPolicy = () => {
      if (this.closed || !this.policy.automaticUpdates && this.store.list().active[this.runtimes[kind].id]?.current !== lease.revision.digest) {
        throw Object.assign(new Error('Plugin validation deferred by host policy'), { code: 'VALIDATION_DEFERRED' })
      }
    }
    // Initial bundled activation remains available when automatic discovery is disabled.
    if (!this.policy.builtinDigests.includes(lease.revision.digest)) checkPolicy()
    // Signed reports have a host fixture; external engineering adapters still require an engineering validator.
    if (!this.trustedDigests().includes(lease.revision.digest)) throw new Error('Plugin is not a trusted executable release')
    const acquireRuntime = () => ({ python: snapshot.executable, pluginRoot: lease.root, module: lease.revision.manifest.entry.module, release() {} })
    const client = kind === 'icepak' ? new IcepakPluginClient({ acquireRuntime }) : new ReportClient({ acquireRuntime })
    const health = await client.health() as { pluginId?: string; pluginVersion?: string; protocolVersion?: string; status?: string }
    const passed = health.pluginId === lease.revision.manifest.id && health.pluginVersion === lease.revision.manifest.version && health.protocolVersion === '1.0.0' && health.status === 'ok'
    const checks = [{ name: 'release-protocol', passed, detail: 'Code identity and protocol only; engineering compatibility and solve readiness require separate evidence' }]
    if (passed && kind === 'report' && !this.policy.builtinDigests.includes(lease.revision.digest)) {
      checks.push(...await validateReportRelease(client as ReportClient, this.runtimes.report.baseSnapshot!.executable, this.home))
    }
    if (passed && kind === 'icepak' && !this.policy.builtinDigests.includes(lease.revision.digest)) {
      if (this.closed || !this.policy.automaticUpdates) throw Object.assign(new Error('Engineering validation deferred by host policy'), { code: 'VALIDATION_DEFERRED' })
      const runtime = this.runtimes.icepak
      if (!runtime.engineeringPolicy || !this.engineeringStore) throw new Error('Engineering validation is not configured')
      const reference = this.store.acquireValidationReference(runtime.builtinDigest!)
      const controller = new AbortController()
      this.validationAbort = controller
      try {
        const referenceClient = new IcepakPluginClient({ acquireRuntime: () => {
          this.store.verify(reference.revision.digest)
          return { python: runtime.baseSnapshot!.executable, pluginRoot: reference.root, module: reference.revision.manifest.entry.module, release() {} }
        } })
        const results = await withIcepakOperation(this.engineeringStore, 'plugin-upgrade-validation', options => validateEngineeringPlugin({
          home: this.home, policy: runtime.engineeringPolicy!, candidate: client as IcepakPluginClient, reference: referenceClient,
          candidateIdentity: { pluginId: lease.revision.manifest.id, pluginVersion: lease.revision.manifest.version, packageDigest: lease.revision.digest, environmentDigest: pluginEnvironmentDigest(snapshot.environment) },
          referenceIdentity: { pluginId: reference.revision.manifest.id, pluginVersion: reference.revision.manifest.version, packageDigest: reference.revision.digest, environmentDigest: pluginEnvironmentDigest(runtime.baseSnapshot!.environment) },
          options: { ...options, signal: controller.signal },
        }))
        this.store.verify(reference.revision.digest)
        if (controller.signal.aborted) throw Object.assign(new Error('Engineering validation cancelled'), { code: 'VALIDATION_DEFERRED' })
        checks.push(...results)
      } catch (error) {
        if ((error as { code?: string })?.code === 'ICEPAK_BUSY') throw Object.assign(new Error('Engineering validation waits for idle AEDT'), { code: 'VALIDATION_DEFERRED' })
        throw error
      } finally { reference.release(); if (this.validationAbort === controller) this.validationAbort = undefined }
    }
    if (!this.policy.builtinDigests.includes(lease.revision.digest)) checkPolicy()
    return checks
  }
}
