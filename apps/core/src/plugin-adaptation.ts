import { pluginCompatibility, type PluginEnvironment } from '@thermal-agent/contracts'
import { PluginStore, pluginEnvironmentDigest, type PluginLease, type PluginValidation, type PluginRevision } from './plugin-store.js'

/** Supplied by the host's trust policy, never by an Agent tool call. */
export interface PluginAdaptationPolicy {
  enabled: boolean
  trustedDigests: readonly string[]
  permissions: readonly string[]
}
export interface PluginAdaptationResult {
  status: 'disabled' | 'busy' | 'unchanged' | 'activated' | 'unavailable'
  digest?: string
  diagnostics: string[]
}

/** An automatic selection cycle. Call at startup and after environment/catalog changes. */
export class PluginAdaptationController {
  private running = false
  constructor(private readonly store: PluginStore) {}

  async reconcile(id: string, environment: PluginEnvironment, policy: PluginAdaptationPolicy,
    validator: (lease: PluginLease, environment: PluginEnvironment) => Promise<PluginValidation['checks']>,
    resolveEnvironment?: (revision: PluginRevision) => Promise<PluginEnvironment>): Promise<PluginAdaptationResult> {
    if (!policy.enabled) return { status: 'disabled', diagnostics: [] }
    if (this.running || this.store.isBusy(id)) return { status: 'busy', diagnostics: ['Active work retains its plugin revision'] }
    this.running = true
    try {
      // Capture host facts; mutable caller objects must not change a cycle while validation is running.
      const captured = structuredClone(environment)
      const allowed = [...policy.permissions], trusted = new Set(policy.trustedDigests)
      const snapshot = this.store.list()
      const current = snapshot.active[id]?.current
      const diagnostics: string[] = []
      const candidates = snapshot.revisions.filter(revision => {
        if (revision.manifest.id !== id || !trusted.has(revision.digest)) return false
        if (revision.manifest.version.includes('-')) return false // Prereleases require explicit activation.
        const problems = pluginCompatibility(resolveEnvironment ? { ...revision.manifest, compatibility: { ...revision.manifest.compatibility, versions: {} } } : revision.manifest, captured)
        if (revision.manifest.permissions.some(permission => !allowed.includes(permission))) problems.push('Additional permissions required')
        if (problems.length) diagnostics.push(`${revision.manifest.version}: ${problems.join('; ')}`)
        return !problems.length
      }).sort((a, b) => {
        const left = a.manifest.version.split('.').map(Number), right = b.manifest.version.split('.').map(Number)
        return right[0] - left[0] || right[1] - left[1] || right[2] - left[2]
      })
      for (const candidate of candidates) {
        let selected = captured
        try {
          if (resolveEnvironment) selected = structuredClone(await resolveEnvironment(candidate))
          const problems = pluginCompatibility(candidate.manifest, selected)
          if (problems.length) { diagnostics.push(`${candidate.manifest.version}: ${problems.join('; ')}`); continue }
        } catch (error) {
          if ((error as { code?: string })?.code === 'VALIDATION_DEFERRED') return { status: 'busy', diagnostics }
          diagnostics.push(`${candidate.manifest.version}: ${error instanceof Error ? error.message : String(error)}`); continue
        }
        const envDigest = pluginEnvironmentDigest(selected)
        const receipt = snapshot.validations.find(item => item.packageDigest === candidate.digest && item.environmentDigest === envDigest)
        // Failed revisions are quarantined for this exact environment until explicitly revalidated.
        if (receipt?.passed === false) { diagnostics.push(`${candidate.manifest.version}: Previous validation failed`); continue }
        try {
          const validation = receipt ?? await this.store.validate(candidate.digest, selected, lease => validator(lease, selected))
          if (!validation.passed) { diagnostics.push(`${candidate.manifest.version}: Validation failed`); continue }
          this.store.activate(candidate.digest, selected, allowed)
          return { status: candidate.digest === current ? 'unchanged' : 'activated', digest: candidate.digest, diagnostics }
        } catch (error) {
          if (this.store.isBusy(id) || (error as { code?: string })?.code === 'VALIDATION_DEFERRED') return { status: 'busy', diagnostics }
          diagnostics.push(`${candidate.manifest.version}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return { status: 'unavailable', diagnostics }
    } finally { this.running = false }
  }
}
