import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseManagedPluginManifest, pluginCompatibility, type PluginEnvironment, type ManagedPluginManifest } from '@thermal-agent/contracts'

type FileDigest = { path: string; sha256: string; bytes: number }
export interface PluginRevision {
  digest: string
  manifest: ManagedPluginManifest
  files: FileDigest[]
  installedAt: string
}
export interface PluginValidation {
  packageDigest: string
  environmentDigest: string
  passed: boolean
  checks: Array<{ name: string; passed: boolean; detail: string }>
  validatedAt: string
}
export interface PluginActivation { current: string; previous?: string }
interface PluginState {
  schemaVersion: 1
  revisions: Record<string, PluginRevision>
  validations: Record<string, PluginValidation>
  active: Record<string, PluginActivation>
  events: Array<{ at: string; action: string; id: string; digest: string; detail: string }>
}
export interface PluginLease {
  revision: PluginRevision
  root: string
  release(): void
}

function hash(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export function pluginEnvironmentDigest(environment: PluginEnvironment): string { return hash(stable(environment)) }

/** Copy bytes, not symlinks; reject ambiguous Windows paths even on the author's Mac. */
function collect(root: string): Array<FileDigest & { content: Buffer }> {
  const result: Array<FileDigest & { content: Buffer }> = []
  const folded = new Set<string>()
  let bytes = 0
  function walk(directory: string, prefix: string) {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Plugin directories must not be symlinks')
    for (const name of readdirSync(directory).sort()) {
      if (!/^[a-zA-Z0-9_.-]+$/u.test(name) || name.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) throw new Error(`Unsafe plugin path: ${name}`)
      const path = prefix ? `${prefix}/${name}` : name
      if (path.length > 220 || folded.has(path.toLowerCase())) throw new Error('Ambiguous or overlong plugin path')
      folded.add(path.toLowerCase())
      if (folded.size > 4000) throw new Error('Too many plugin package entries')
      const absolute = join(directory, name), stat = lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error('Plugin packages cannot contain symlinks')
      if (stat.isDirectory()) { walk(absolute, path); continue }
      if (!stat.isFile()) throw new Error('Plugin packages contain only regular files')
      bytes += stat.size
      if (result.length >= 2000 || bytes > 32 * 1024 * 1024) throw new Error('Plugin package exceeds 2000 files or 32 MiB')
      const content = readFileSync(absolute)
      if (content.length !== stat.size) throw new Error('Plugin source changed while reading')
      result.push({ path, bytes: content.length, sha256: hash(content), content })
    }
  }
  walk(root, '')
  return result.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

/** One Core process owns this store. Revisions are immutable; one atomic state replacement commits a mutation. */
export class PluginStore {
  private state: PluginState
  private readonly packages: string
  private readonly statePath: string
  private readonly leases = new Map<string, number>()
  private readonly validating = new Set<string>()

  constructor(private readonly home: string) {
    this.packages = join(home, 'packages')
    this.statePath = join(home, 'state.json')
    mkdirSync(this.packages, { recursive: true })
    this.state = existsSync(this.statePath) ? this.readState() : { schemaVersion: 1, revisions: {}, validations: {}, active: {}, events: [] }
  }

  private readState(): PluginState {
    const state = JSON.parse(readFileSync(this.statePath, 'utf8')) as PluginState
    if (state.schemaVersion !== 1 || !state.revisions || !state.active || !state.validations || !Array.isArray(state.events)) throw new Error('Invalid plugin registry state')
    for (const [digest, revision] of Object.entries(state.revisions)) {
      if (!/^[a-f0-9]{64}$/u.test(digest) || revision.digest !== digest) throw new Error('Invalid plugin revision digest')
      parseManagedPluginManifest(revision.manifest)
    }
    for (const [id, activation] of Object.entries(state.active)) {
      if (state.revisions[activation.current]?.manifest.id !== id ||
        (activation.previous && state.revisions[activation.previous]?.manifest.id !== id)) throw new Error('Invalid plugin activation state')
    }
    return state
  }

  private commit(next: PluginState): void {
    const temp = join(this.home, `state-${randomUUID()}.tmp`)
    const fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd) } finally { closeSync(fd) }
    try { renameSync(temp, this.statePath) }
    catch (error) { rmSync(temp, { force: true }); throw error }
    this.state = next
  }

  private event(state: PluginState, action: string, revision: PluginRevision, detail = ''): void {
    state.events.push({ at: new Date().toISOString(), action, id: revision.manifest.id, digest: revision.digest, detail })
  }

  list(): { revisions: PluginRevision[]; active: Record<string, PluginActivation>; validations: PluginValidation[]; events: PluginState['events'] } {
    return structuredClone({ revisions: Object.values(this.state.revisions), active: this.state.active,
      validations: Object.values(this.state.validations), events: this.state.events })
  }

  isBusy(id: string): boolean { return this.validating.has(id) || (this.leases.get(id) ?? 0) > 0 }

  install(source: string): PluginRevision {
    const collected = collect(resolve(source))
    const manifestFile = collected.find(file => file.path === 'plugin.json')
    if (!manifestFile || manifestFile.bytes > 64 * 1024) throw new Error('Missing or oversized plugin.json')
    const manifest = parseManagedPluginManifest(JSON.parse(manifestFile.content.toString('utf8')))
    const modulePath = `${manifest.entry.root}/${manifest.entry.module.replaceAll('.', '/')}`
    if (!collected.some(file => file.path === `${modulePath}.py` || file.path === `${modulePath}/__main__.py`)) throw new Error('Plugin Python entry is missing')
    const files = collected.map(({ content: _content, ...file }) => file)
    const digest = hash(stable(files))
    const existing = this.state.revisions[digest]
    if (existing) { this.verify(digest); return structuredClone(existing) }
    if (Object.values(this.state.revisions).some(item => item.manifest.id === manifest.id && item.manifest.version === manifest.version)) {
      throw new Error('A plugin version cannot be replaced with different bytes; increment its version')
    }
    const staging = join(this.home, `staging-${randomUUID()}`), destination = join(this.packages, digest)
    mkdirSync(staging)
    try {
      for (const file of collected) {
        const path = join(staging, file.path)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, file.content, { flag: 'wx', mode: 0o600 })
      }
      // An orphan directory can remain after a crash between package publication and state commit.
      if (existsSync(destination)) {
        if (hash(stable(collect(destination).map(({ content: _content, ...file }) => file))) !== digest) throw new Error('Orphan plugin package failed integrity check')
      } else renameSync(staging, destination)
      const revision: PluginRevision = { digest, manifest, files, installedAt: new Date().toISOString() }
      const next = structuredClone(this.state)
      next.revisions[digest] = revision
      this.event(next, 'installed', revision)
      this.commit(next)
      return structuredClone(revision)
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }

  verify(digest: string): PluginRevision {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Invalid plugin revision digest')
    const revision = this.state.revisions[digest]
    if (!revision) throw new Error('Unknown plugin revision')
    const files = collect(join(this.packages, digest)).map(({ content: _content, ...file }) => file)
    if (hash(stable(files)) !== digest) throw new Error('Plugin package integrity check failed')
    const actualManifest = parseManagedPluginManifest(JSON.parse(readFileSync(join(this.packages, digest, 'plugin.json'), 'utf8')))
    if (stable(actualManifest) !== stable(revision.manifest)) throw new Error('Plugin manifest does not match registry')
    return structuredClone(revision)
  }

  /** Only a host-owned validator may call this; never accept model-supplied validation receipts. */
  async validate(digest: string, environment: PluginEnvironment,
    validator: (lease: PluginLease) => Promise<PluginValidation['checks']>): Promise<PluginValidation> {
    const revision = this.verify(digest), id = revision.manifest.id
    const problems = pluginCompatibility(revision.manifest, environment)
    if (problems.length) throw new Error(problems.join('; '))
    if (this.validating.has(id) || (this.leases.get(id) ?? 0) > 0) throw new Error('Plugin is busy')
    this.validating.add(id)
    const lease = this.acquireRevision(digest)
    const environmentDigest = pluginEnvironmentDigest(environment)
    try {
      let checks: PluginValidation['checks']
      try {
        checks = await validator(lease)
        this.verify(digest)
        if (!Array.isArray(checks) || !checks.length || checks.some(check => typeof check.name !== 'string' || !check.name ||
          typeof check.passed !== 'boolean' || typeof check.detail !== 'string')) throw new Error('Validator returned invalid checks')
      } catch (error) { checks = [{ name: 'host-validation', passed: false, detail: error instanceof Error ? error.message : String(error) }] }
      const receipt: PluginValidation = { packageDigest: digest, environmentDigest,
        passed: checks.every(check => check.passed), checks, validatedAt: new Date().toISOString() }
      const next = structuredClone(this.state)
      next.validations[`${digest}:${receipt.environmentDigest}`] = receipt
      this.event(next, receipt.passed ? 'validated' : 'validation-failed', revision)
      this.commit(next)
      return structuredClone(receipt)
    } finally { lease.release(); this.validating.delete(id) }
  }

  activate(digest: string, environment: PluginEnvironment, approvedPermissions: readonly string[]): void {
    const revision = this.verify(digest), id = revision.manifest.id
    if ((this.leases.get(id) ?? 0) > 0 || this.validating.has(id)) throw new Error('Plugin is busy')
    const problems = pluginCompatibility(revision.manifest, environment)
    if (problems.length) throw new Error(problems.join('; '))
    const validation = this.state.validations[`${digest}:${pluginEnvironmentDigest(environment)}`]
    if (!validation?.passed) throw new Error('Plugin has no passing validation for this environment')
    if (revision.manifest.permissions.some(permission => !approvedPermissions.includes(permission))) throw new Error('Plugin requires additional permissions')
    const old = this.state.active[id]
    if (old?.current === digest) return
    const next = structuredClone(this.state)
    next.active[id] = { current: digest, ...(old ? { previous: old.current } : {}) }
    this.event(next, 'activated', revision)
    this.commit(next)
  }

  rollback(id: string, environment: PluginEnvironment, approvedPermissions: readonly string[]): void {
    const previous = this.state.active[id]?.previous
    if (!previous) throw new Error('No previous plugin revision')
    this.activate(previous, environment, approvedPermissions)
  }

  acquire(id: string, environment: PluginEnvironment, pinnedDigest?: string): PluginLease {
    if (this.validating.has(id)) throw new Error('Plugin validation is in progress')
    const digest = pinnedDigest ?? this.state.active[id]?.current
    if (!digest) throw new Error('Plugin is not active')
    const revision = this.verify(digest)
    if (revision.manifest.id !== id) throw new Error('Pinned plugin identity mismatch')
    const problems = pluginCompatibility(revision.manifest, environment)
    if (problems.length) throw new Error(problems.join('; '))
    if (!this.state.validations[`${digest}:${pluginEnvironmentDigest(environment)}`]?.passed) throw new Error('Plugin environment changed; validation required')
    return this.acquireRevision(digest)
  }

  private acquireRevision(digest: string): PluginLease {
    const revision = this.verify(digest), id = revision.manifest.id
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1)
    let released = false
    return { revision, root: join(this.packages, digest, revision.manifest.entry.root), release: () => {
      if (released) return
      released = true
      this.leases.set(id, (this.leases.get(id) ?? 1) - 1)
    } }
  }
}
