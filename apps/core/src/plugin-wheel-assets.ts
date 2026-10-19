import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, rename, rm, type FileHandle } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { MAX_PLUGIN_WHEEL_ASSET_BYTES, type ManagedPluginManifest } from '@thermal-agent/contracts'

export type LockedPythonWheel = NonNullable<ManagedPluginManifest['pythonRuntime']>['wheels'][number]
const CACHE_BYTES = 4 * 1024 ** 3
const partialName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.partial$/u
export interface WheelAssetCollection {
  checkedAt?: string; removed: number; removedBytes: number; retained: Record<string, number>; deferred?: boolean; error?: string
}

/** Immutable content-addressed download cache; no wheel is imported or executed here. */
export class PluginWheelAssets {
  private uses = 0
  private collecting?: Promise<WheelAssetCollection>
  private collection: WheelAssetCollection = { removed: 0, removedBytes: 0, retained: {} }
  constructor(private readonly home: string) {}

  collectionStatus(): WheelAssetCollection { return structuredClone(this.collection) }
  collectionError(error: unknown): void {
    this.collection = { checkedAt: new Date().toISOString(), removed: 0, removedBytes: 0, retained: {}, error: error instanceof Error ? error.message : String(error) }
  }

  private async use<T>(work: () => Promise<T>): Promise<T> {
    while (this.collecting) await this.collecting
    this.uses++
    try { return await work() } finally { this.uses-- }
  }

  collect(input: { keep: Set<string>; allowed: () => boolean; now?: number }): Promise<WheelAssetCollection> {
    if (this.collecting) return this.collecting
    if (this.uses) {
      this.collection = { checkedAt: new Date().toISOString(), removed: 0, removedBytes: 0, retained: {}, deferred: true }
      return Promise.resolve(this.collectionStatus())
    }
    const pending = this.collectUnused(input).finally(() => { if (this.collecting === pending) this.collecting = undefined })
    this.collecting = pending
    return pending
  }

  private async collectUnused(input: { keep: Set<string>; allowed: () => boolean; now?: number }): Promise<WheelAssetCollection> {
    const now = input.now ?? Date.now()
    const result: WheelAssetCollection = { checkedAt: new Date(now).toISOString(), removed: 0, removedBytes: 0, retained: {} }
    const retain = (reason: string) => { result.retained[reason] = (result.retained[reason] ?? 0) + 1 }
    try {
      try { await this.directory() } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.collection = result; return this.collectionStatus() }
      const names = await readdir(this.home)
      if (names.length > 10_000) throw new Error('Wheel asset inventory exceeds 10000 entries')
      for (const name of names.sort()) {
        if (!input.allowed()) break
        const path = join(this.home, name), stat = await lstat(path)
        const asset = /^[a-f0-9]{64}\.whl$/u.test(name), partial = partialName.test(name)
        if (!stat.isFile() || stat.isSymbolicLink() || !asset && !partial) { retain('unknown entry'); continue }
        if (asset && input.keep.has(name.slice(0, -4))) { retain('required by retained version'); continue }
        // A newly copied offline asset can carry an old mtime; its creation/change time still protects it.
        if (now - Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs) < (partial ? 1 : 7) * 24 * 60 * 60_000) { retain('retention period'); continue }
        if (result.removed >= 64) { retain('collection batch limit'); continue }
        if (!input.allowed()) break
        await rm(path)
        result.removed++; result.removedBytes += stat.size
      }
    } catch (error) { result.error = error instanceof Error ? error.message : String(error) }
    this.collection = result
    return this.collectionStatus()
  }

  private path(wheel: LockedPythonWheel): string {
    if (!wheel.asset || !Number.isSafeInteger(wheel.asset.sizeBytes) || wheel.asset.sizeBytes <= 0 || wheel.asset.sizeBytes > MAX_PLUGIN_WHEEL_ASSET_BYTES ||
      !/^[a-f0-9]{64}$/u.test(wheel.sha256)) throw new Error('Invalid external wheel identity')
    return join(this.home, `${wheel.sha256}.whl`)
  }

  private async directory(create = false): Promise<void> {
    if (create) await mkdir(this.home, { recursive: true })
    const stat = await lstat(this.home)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid wheel asset cache directory')
  }

  private async verify(path: string, wheel: LockedPythonWheel, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size !== wheel.asset!.sizeBytes) throw new Error('Wheel asset size mismatch')
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(path, { signal })) {
      size += chunk.length
      if (size > wheel.asset!.sizeBytes) throw new Error('Wheel asset size mismatch')
      hash.update(chunk)
    }
    const after = await lstat(path)
    if (size !== before.size || after.size !== before.size || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs ||
      hash.digest('hex') !== wheel.sha256) throw new Error('Wheel asset SHA-256 mismatch')
  }

  async has(wheel: LockedPythonWheel, signal?: AbortSignal): Promise<boolean> {
    return this.use(() => this.hasUnlocked(wheel, signal))
  }
  private async hasUnlocked(wheel: LockedPythonWheel, signal?: AbortSignal): Promise<boolean> {
    const path = this.path(wheel)
    try { await this.directory(); await this.verify(path, wheel, signal); return true }
    catch { signal?.throwIfAborted(); return false }
  }

  async materialize(wheel: LockedPythonWheel, directory: string, signal?: AbortSignal): Promise<string> {
    return this.use(() => this.materializeUnlocked(wheel, directory, signal))
  }
  private async materializeUnlocked(wheel: LockedPythonWheel, directory: string, signal?: AbortSignal): Promise<string> {
    const source = this.path(wheel)
    try { await this.directory(); await this.verify(source, wheel, signal) }
    catch {
      signal?.throwIfAborted()
      throw Object.assign(new Error(`Wheel asset ${wheel.name} is missing or invalid; a configured update source must supply its signed bytes`), { code: 'RUNTIME_ASSET_UNAVAILABLE' })
    }
    if (!/^wheels\/[a-zA-Z0-9_.-]+\.whl$/u.test(wheel.path) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(basename(wheel.path))) throw new Error('Invalid wheel filename')
    await mkdir(directory, { recursive: true })
    const target = join(directory, basename(wheel.path))
    // A copy avoids a writable venv mutating the shared cache through a hard link.
    await copyFile(source, target)
    await this.verify(target, wheel, signal)
    return target
  }

  async download(wheel: LockedPythonWheel, url: string, fetcher: typeof fetch, signal: AbortSignal,
    consumed: (bytes: number) => void = () => {}): Promise<void> {
    return this.use(() => this.downloadUnlocked(wheel, url, fetcher, signal, consumed))
  }
  private async downloadUnlocked(wheel: LockedPythonWheel, url: string, fetcher: typeof fetch, signal: AbortSignal, consumed: (bytes: number) => void): Promise<void> {
    const target = this.path(wheel), address = new URL(url)
    if (address.protocol !== 'https:' || address.username || address.password || address.hash) throw new Error('Wheel assets require HTTPS without credentials or fragments')
    signal.throwIfAborted()
    await this.directory(true)
    const names = await readdir(this.home)
    if (names.length >= 4000) throw new Error('Wheel asset cache is full')
    let stored = 0
    for (const name of names) {
      const path = join(this.home, name), stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid wheel asset cache entry')
      if (partialName.test(name) && Date.now() - stat.mtimeMs > 24 * 60 * 60_000) { await rm(path); continue }
      stored += stat.size
    }
    if (stored + wheel.asset!.sizeBytes > CACHE_BYTES) throw new Error('Wheel asset cache exceeds 4 GiB')
    const temporary = join(this.home, `${randomUUID()}.partial`)
    try {
      const response = await fetcher(address.href, { signal, redirect: 'error', credentials: 'omit',
        headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' } })
      const declared = response.headers.get('content-length'), encoding = response.headers.get('content-encoding')
      if (!response.ok || encoding && encoding !== 'identity' || declared !== null && (!/^\d+$/u.test(declared) || Number(declared) !== wheel.asset!.sizeBytes)) {
        await response.body?.cancel(); throw new Error('Wheel asset response status, encoding or size is invalid')
      }
      if (!response.body) throw new Error('Wheel asset response has no body')
      const reader = response.body.getReader(), hash = createHash('sha256')
      const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
      signal.addEventListener('abort', abort, { once: true })
      let file: FileHandle | undefined
      let size = 0
      try {
        file = await open(temporary, 'wx', 0o600)
        for (;;) {
          signal.throwIfAborted()
          const { value, done } = await reader.read()
          signal.throwIfAborted()
          if (done) break
          size += value.byteLength; consumed(value.byteLength)
          if (size > wheel.asset!.sizeBytes) throw new Error('Wheel asset exceeds signed size')
          hash.update(value)
          let offset = 0
          while (offset < value.byteLength) {
            const { bytesWritten } = await file.write(value, offset, value.byteLength - offset)
            if (!bytesWritten) throw new Error('Wheel asset write made no progress')
            offset += bytesWritten
          }
        }
        if (size !== wheel.asset!.sizeBytes || hash.digest('hex') !== wheel.sha256) throw new Error('Wheel asset SHA-256 or size mismatch')
        await file.sync()
      } finally {
        signal.removeEventListener('abort', abort)
        try { await file?.close() } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      }
      signal.throwIfAborted()
      await rename(temporary, target)
    } finally { await rm(temporary, { force: true }) }
  }
}
