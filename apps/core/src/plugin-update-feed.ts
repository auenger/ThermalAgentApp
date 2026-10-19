import { createHash } from 'node:crypto'
import { MAX_PLUGIN_RELEASE_BYTES, type PluginReleaseInbox } from './plugin-release.js'

export interface PluginUpdateSource { id: string; url: string }
export interface PluginUpdateStatus {
  phase: 'idle' | 'checking' | 'disabled' | 'ready' | 'error' | 'cancelled'
  checkedAt: string | null
  downloaded: number
  cached: number
  sources: Array<{ id: string; downloaded: number; cached: number; errors: string[] }>
  error?: string
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid update feed object')
  return value as Record<string, unknown>
}
function httpsUrl(value: unknown, base?: string): URL {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid update URL')
  const url = new URL(value, base)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Updates require HTTPS without URL credentials or fragments')
  return url
}
export function parsePluginUpdateSources(value: unknown): PluginUpdateSource[] {
  if (!Array.isArray(value) || value.length > 5) throw new Error('Configure at most five plugin update sources')
  const ids = new Set<string>()
  return value.map(item => {
    const source = object(item)
    if (typeof source.id !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/u.test(source.id) || ids.has(source.id)) throw new Error('Invalid or duplicate update source ID')
    ids.add(source.id)
    return { id: source.id, url: httpsUrl(source.url).href }
  })
}
function parseCatalog(bytes: Buffer, source: PluginUpdateSource) {
  const catalog = object(JSON.parse(bytes.toString('utf8')))
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.releases) || catalog.releases.length > 50) throw new Error('Unsupported or oversized update catalog')
  const seen = new Set<string>()
  return catalog.releases.map(item => {
    const entry = object(item), url = httpsUrl(entry.url, source.url)
    if (url.origin !== new URL(source.url).origin) throw new Error('Release URL must stay on the configured source origin')
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256) || seen.has(entry.sha256)) throw new Error('Invalid or duplicate release digest')
    seen.add(entry.sha256)
    return { url: url.href, sha256: entry.sha256 }
  })
}

/** Catalogs locate packages; only the existing publisher/signature verifier can confer trust. */
export class PluginUpdateFeed {
  private state: PluginUpdateStatus = { phase: 'idle', checkedAt: null, downloaded: 0, cached: 0, sources: [] }
  private pending?: Promise<PluginUpdateStatus>
  private controller?: AbortController
  private closed = false
  private readonly retryAfter = new Map<string, number>()
  constructor(private readonly inbox: PluginReleaseInbox, private readonly sources: () => unknown,
    private readonly fetcher: typeof fetch = fetch, private readonly requestTimeoutMs = 15_000) {}

  status(): PluginUpdateStatus { return structuredClone(this.state) }
  cancel(): void { this.controller?.abort(new Error('Plugin update cancelled')) }
  async close(): Promise<void> { this.closed = true; this.cancel(); await this.pending }

  poll(enabled: boolean): Promise<PluginUpdateStatus> {
    if (this.pending) return this.pending
    if (!enabled || this.closed) {
      this.state = { ...this.state, phase: 'disabled' }
      return Promise.resolve(this.status())
    }
    const controller = new AbortController()
    this.controller = controller
    const pending = this.run(controller.signal).finally(() => {
      if (this.pending === pending) this.pending = undefined
      if (this.controller === controller) this.controller = undefined
    })
    this.pending = pending
    return pending
  }

  private async bytes(url: string, limit: number, signal: AbortSignal, consumed?: (bytes: number) => void): Promise<Buffer> {
    const response = await this.fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]),
      redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' } })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Update server returned HTTP ${response.status}`) }
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
      await response.body?.cancel(); throw new Error('Update response exceeds size limit')
    }
    if (!response.body) throw new Error('Update response has no body')
    const reader = response.body.getReader(), chunks: Buffer[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) break
        size += value.byteLength
        consumed?.(value.byteLength)
        if (size > limit) throw new Error('Update response exceeds size limit')
        chunks.push(Buffer.from(value))
      }
      return Buffer.concat(chunks, size)
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  }

  private async run(cancellation: AbortSignal): Promise<PluginUpdateStatus> {
    this.state = { phase: 'checking', checkedAt: new Date().toISOString(), downloaded: 0, cached: 0, sources: [] }
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(60_000)])
    let attempts = 0, downloadedBytes = 0
    try {
      const sources = parsePluginUpdateSources(this.sources())
      for (const source of sources) {
        signal.throwIfAborted()
        const status = { id: source.id, downloaded: 0, cached: 0, errors: [] as string[] }
        this.state.sources.push(status)
        try {
          const catalog = parseCatalog(await this.bytes(source.url, 64 * 1024, signal), source)
          for (const release of catalog) {
            signal.throwIfAborted()
            if (this.inbox.restoreEnvelope(release.sha256)) { status.cached++; this.state.cached++; continue }
            if ((this.retryAfter.get(release.sha256) ?? 0) > Date.now()) {
              status.errors.push(`Release ${release.sha256.slice(0, 12)} is waiting for its retry window`); continue
            }
            if (++attempts > 10 || downloadedBytes >= 96 * 1024 * 1024) { status.errors.push('Update cycle download budget reached'); break }
            try {
              const bytes = await this.bytes(release.url, Math.min(MAX_PLUGIN_RELEASE_BYTES, 96 * 1024 * 1024 - downloadedBytes), signal, size => { downloadedBytes += size })
              if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Downloaded release digest mismatch')
              signal.throwIfAborted()
              this.inbox.accept(bytes)
              this.retryAfter.delete(release.sha256)
              status.downloaded++; this.state.downloaded++
            } catch (error) {
              if (!signal.aborted) {
                if (this.retryAfter.size >= 500) this.retryAfter.delete(this.retryAfter.keys().next().value!)
                this.retryAfter.set(release.sha256, Date.now() + 15 * 60_000)
              }
              status.errors.push(this.diagnostic(error))
            }
          }
        } catch (error) { status.errors.push(this.diagnostic(error)) }
      }
      this.state.phase = this.state.sources.some(source => source.errors.length) ? 'error' : sources.length ? 'ready' : 'idle'
    } catch (error) { this.state.phase = 'error'; this.state.error = this.diagnostic(error) }
    if (signal.aborted) this.state.phase = 'cancelled'
    return this.status()
  }

  private diagnostic(error: unknown): string {
    // Fetch errors may contain credential-bearing URLs. Configured URLs are deliberately absent from diagnostics.
    if (error instanceof TypeError) return 'Network or update URL error'
    return error instanceof Error ? error.message.replace(/https?:\/\/\S+/gu, '[update URL]').slice(0, 300) : 'Plugin update failed'
  }
}
