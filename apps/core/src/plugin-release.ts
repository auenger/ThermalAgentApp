import { createPublicKey, verify, createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, lstatSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parseManagedPluginManifest } from '@thermal-agent/contracts'
import { PluginStore } from './plugin-store.js'

export interface PluginPublisher { id: string; publicKey: string; pluginIds: string[] }
export const MAX_PLUGIN_RELEASE_BYTES = 48 * 1024 * 1024
const identifier = /^[a-z][a-z0-9-]{0,79}$/u
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected release object')
  return value as Record<string, unknown>
}
function decode(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(value)) throw new Error('Invalid release base64')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('Invalid release base64')
  return bytes
}

/** Publisher keys are provisioned by the local administrator, never accepted from a release or DSH tool. */
export function parsePluginPublishers(value: unknown): PluginPublisher[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid plugin publisher policy')
  const seen = new Set<string>()
  return value.map(item => {
    const p = object(item)
    if (typeof p.id !== 'string' || !identifier.test(p.id) || seen.has(p.id) || typeof p.publicKey !== 'string' || p.publicKey.length > 4096 ||
      !Array.isArray(p.pluginIds) || !p.pluginIds.length || p.pluginIds.some(id => typeof id !== 'string' || !identifier.test(id))) throw new Error('Invalid plugin publisher')
    if (createPublicKey(p.publicKey).asymmetricKeyType !== 'ed25519') throw new Error('Plugin publisher must use Ed25519')
    seen.add(p.id)
    return { id: p.id, publicKey: p.publicKey, pluginIds: p.pluginIds as string[] }
  })
}

/** Verify all signed bytes before materializing any package. No source path or key comes from the payload. */
export function verifyPluginRelease(bytes: Buffer, publishers: readonly PluginPublisher[]) {
  if (bytes.length > MAX_PLUGIN_RELEASE_BYTES) throw new Error('Plugin release is too large')
  const envelope = object(JSON.parse(bytes.toString('utf8')))
  if (envelope.schemaVersion !== 1 || typeof envelope.publisherId !== 'string') throw new Error('Unsupported plugin release')
  const publisher = publishers.find(p => p.id === envelope.publisherId)
  if (!publisher) throw new Error('Unknown or revoked plugin publisher')
  const payloadBytes = decode(envelope.payload), signature = decode(envelope.signature)
  if (signature.length !== 64 || createPublicKey(publisher.publicKey).asymmetricKeyType !== 'ed25519' ||
    !verify(null, payloadBytes, publisher.publicKey, signature)) throw new Error('Plugin release signature failed')
  const payload = object(JSON.parse(payloadBytes.toString('utf8')))
  if (payload.schemaVersion !== 1 || typeof payload.publishedAt !== 'string' || !Number.isFinite(Date.parse(payload.publishedAt))) throw new Error('Invalid signed release metadata')
  const entries = Object.entries(object(payload.files))
  if (!entries.length || entries.length > 2000) throw new Error('Invalid release file count')
  const files: Array<{ path: string; bytes: Buffer }> = [], folded = new Set<string>()
  let total = 0
  for (const [path, encoded] of entries) {
    if (path.length > 220 || path.split('/').some(part => !/^[a-zA-Z0-9_.-]+$/u.test(part) || part === '.' || part === '..' || part.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) || folded.has(path.toLowerCase())) throw new Error('Unsafe release path')
    folded.add(path.toLowerCase())
    const content = decode(encoded)
    total += content.length
    if (total > 32 * 1024 * 1024) throw new Error('Release package exceeds 32 MiB')
    files.push({ path, bytes: content })
  }
  const manifestBytes = files.find(file => file.path === 'plugin.json')?.bytes
  if (!manifestBytes || manifestBytes.length > 64 * 1024) throw new Error('Missing or oversized release manifest')
  const manifest = parseManagedPluginManifest(JSON.parse(manifestBytes.toString('utf8')))
  if (!publisher.pluginIds.includes(manifest.id)) throw new Error('Publisher is not authorized for this plugin')
  return { publisherId: publisher.id, manifest, files }
}

/** Persistent offline inbox; signature policy is rechecked every scan, including after restart/revocation. */
export class PluginReleaseInbox {
  private readonly inbox: string
  constructor(private readonly home: string, private readonly store: PluginStore, private readonly publishers: () => PluginPublisher[]) {
    this.inbox = join(home, 'releases')
    mkdirSync(this.inbox, { recursive: true })
  }
  private install(bytes: Buffer) {
    const release = verifyPluginRelease(bytes, this.publishers())
    const staging = mkdtempSync(join(this.home, 'release-'))
    try {
      for (const file of release.files) {
        const path = join(staging, file.path)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, file.bytes, { flag: 'wx', mode: 0o600 })
      }
      const revision = this.store.install(staging)
      return { digest: revision.digest, publisherId: release.publisherId, id: revision.manifest.id }
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }
  accept(bytes: Buffer) {
    const target = join(this.inbox, `${createHash('sha256').update(bytes).digest('hex')}.json`)
    if (!existsSync(target) && readdirSync(this.inbox).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).length >= 200) throw new Error('Plugin release inbox is full; archive obsolete release envelopes first')
    const release = this.install(bytes)
    const temporary = join(this.inbox, `${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
      renameSync(temporary, target)
    } finally { rmSync(temporary, { force: true }) }
    return release
  }
  restoreEnvelope(sha256: string): boolean {
    if (!/^[a-f0-9]{64}$/u.test(sha256)) return false
    try {
      const path = join(this.inbox, `${sha256}.json`), stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PLUGIN_RELEASE_BYTES) return false
      const bytes = readFileSync(path)
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) return false
      this.install(bytes) // Recheck publisher policy and immutable package integrity, including after restart.
      return true
    } catch { return false }
  }
  scan() {
    const releases: Array<{ digest: string; publisherId: string; id: string }> = [], errors: string[] = []
    for (const name of readdirSync(this.inbox).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).sort().slice(0, 200)) {
      try {
        const path = join(this.inbox, name), stat = lstatSync(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PLUGIN_RELEASE_BYTES) throw new Error('Invalid release file')
        const release = this.install(readFileSync(path))
        if (!releases.some(item => item.digest === release.digest)) releases.push(release)
      }
      catch (error) { errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    return { releases, errors }
  }
}
