import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseManagedPluginManifest } from '@thermal-agent/contracts'
import { PluginStore, type PluginRevision, type PluginValidation } from './plugin-store.js'

export const MAX_REPAIR_PROPOSAL_BYTES = 2 * 1024 * 1024
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const digestPattern = /^[a-f0-9]{64}$/u
export interface RepairProposal {
  schemaVersion: 1; basePackageDigest: string; environmentDigest: string; version: string; reason: string
  files: Array<{ path: string; content: string | null }>
}
export interface RepairCandidate {
  schemaVersion: 1; id: string; status: 'awaiting-isolated-validation'; createdAt: string
  basePackageDigest: string; environmentDigest: string; packageDigest: string; pluginId: string; version: string; reason: string
  changes: Array<{ path: string; sha256: string | null }>
  evidence: PluginValidation
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function parseRepairProposal(value: unknown): RepairProposal {
  if (!object(value) || Object.keys(value).some(key => !['schemaVersion', 'basePackageDigest', 'environmentDigest', 'version', 'reason', 'files'].includes(key)) ||
    value.schemaVersion !== 1 || typeof value.basePackageDigest !== 'string' || !digestPattern.test(value.basePackageDigest) ||
    typeof value.environmentDigest !== 'string' || !digestPattern.test(value.environmentDigest) || typeof value.version !== 'string' || value.version.length > 80 ||
    typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000 || !Array.isArray(value.files) || !value.files.length || value.files.length > 128) throw new Error('Invalid repair proposal')
  const paths = new Set<string>()
  let bytes = 0
  for (const file of value.files) {
    if (!object(file) || Object.keys(file).some(key => !['path', 'content'].includes(key)) || typeof file.path !== 'string' || file.path.length > 220 ||
      !file.path.split('/').every(part => /^[a-zA-Z0-9_.-]+$/u.test(part) && part !== '.' && part !== '..' && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) ||
      !/\.(py|json)$/u.test(file.path) || paths.has(file.path.toLowerCase()) || file.content !== null && typeof file.content !== 'string') throw new Error('Invalid repair source change')
    paths.add(file.path.toLowerCase())
    bytes += typeof file.content === 'string' ? Buffer.byteLength(file.content) : 0
  }
  if (bytes > 1024 * 1024) throw new Error('Repair source changes exceed 1 MiB')
  return structuredClone(value) as unknown as RepairProposal
}

/** Untrusted source storage only. Its private registries are never queried by the executable PluginHost store. */
export class PluginRepairCandidates {
  constructor(private readonly home: string) { mkdirSync(home, { recursive: true }) }

  list(): { candidates: RepairCandidate[]; errors: string[] } {
    const result: { candidates: RepairCandidate[]; errors: string[] } = { candidates: [], errors: [] }
    const names = readdirSync(this.home)
    if (names.length > 64) return { candidates: [], errors: ['Repair candidate inventory exceeds 64 entries'] }
    for (const name of names.sort()) {
      if (!digestPattern.test(name)) continue
      try { result.candidates.push(this.read(name)) }
      catch (error) { result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    return result
  }

  private read(id: string): RepairCandidate {
    const directory = join(this.home, id), path = join(directory, 'candidate.json')
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Invalid candidate directory')
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPAIR_PROPOSAL_BYTES) throw new Error('Invalid candidate record')
    const value = JSON.parse(readFileSync(path, 'utf8')) as RepairCandidate
    if (value.schemaVersion !== 1 || value.id !== id || value.status !== 'awaiting-isolated-validation' || !digestPattern.test(value.packageDigest) ||
      !digestPattern.test(value.basePackageDigest) || !digestPattern.test(value.environmentDigest) || !value.evidence ||
      value.evidence.packageDigest !== value.basePackageDigest || value.evidence.environmentDigest !== value.environmentDigest || !Array.isArray(value.changes)) throw new Error('Invalid candidate evidence')
    return value
  }

  stage(proposal: RepairProposal, base: PluginRevision, baseRoot: string, evidence: PluginValidation): RepairCandidate {
    proposal = parseRepairProposal(proposal)
    if (base.digest !== proposal.basePackageDigest || evidence.packageDigest !== base.digest || evidence.environmentDigest !== proposal.environmentDigest) throw new Error('Repair evidence does not match its base')
    const manifest = parseManagedPluginManifest({ ...base.manifest, version: proposal.version })
    if (manifest.version === base.manifest.version) throw new Error('Repair candidate requires a distinct version')
    for (const file of proposal.files) if (!file.path.startsWith(`${manifest.entry.root}/`)) throw new Error('Repair changes must stay inside the existing Python entry root')
    const changes = [...proposal.files].sort((a, b) => a.path.localeCompare(b.path, 'en'))
    const id = sha(JSON.stringify({ base: base.digest, environment: proposal.environmentDigest, version: manifest.version, reason: proposal.reason, changes }))
    const destination = join(this.home, id)
    if (existsSync(destination)) {
      const record = this.read(id)
      new PluginStore(join(destination, 'registry')).verify(record.packageDigest)
      return record
    }
    if (readdirSync(this.home).length >= 32) throw new Error('Repair candidate storage is full (32 entries)')
    const temporary = mkdtempSync(join(this.home, 'staging-')), source = join(temporary, 'source')
    try {
      for (const file of base.files) {
        const bytes = readFileSync(join(baseRoot, file.path))
        if (sha(bytes) !== file.sha256) throw new Error('Repair base changed while copying')
        const path = join(source, file.path)
        mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes)
      }
      let changed = false
      for (const file of changes) {
        const path = join(source, file.path), original = base.files.find(item => item.path === file.path)
        if (file.content === null) {
          if (!original) throw new Error('Cannot remove a missing repair source file')
          rmSync(path); changed = true
        } else {
          if (!original || sha(file.content) !== original.sha256) changed = true
          mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.content)
        }
      }
      if (!changed) throw new Error('Repair proposal has no source changes')
      writeFileSync(join(source, 'plugin.json'), JSON.stringify(manifest))
      const revision = new PluginStore(join(temporary, 'registry')).install(source)
      rmSync(source, { recursive: true })
      const record: RepairCandidate = { schemaVersion: 1, id, status: 'awaiting-isolated-validation', createdAt: new Date().toISOString(),
        basePackageDigest: base.digest, environmentDigest: proposal.environmentDigest, packageDigest: revision.digest,
        pluginId: manifest.id, version: manifest.version, reason: proposal.reason,
        changes: changes.map(file => ({ path: file.path, sha256: file.content === null ? null : sha(file.content) })), evidence: structuredClone(evidence) }
      writeFileSync(join(temporary, 'candidate.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, destination)
      return record
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  }
}
