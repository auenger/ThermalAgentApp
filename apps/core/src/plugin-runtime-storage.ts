import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

const directoryPattern = /^env-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const samePath = (first: string, second: string) => relative(resolve(first), resolve(second)) === ''
const directoryName = (path: string) => process.platform === 'win32' ? basename(path).toLowerCase() : basename(path)
export type PythonSpawner = (python: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams
export const spawnPython: PythonSpawner = (python, args, options) => {
  const child = spawn(python, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => { /* Process close/error determines call outcome. */ })
  return child
}

interface OwnedEnvironment {
  schemaVersion: 1; directory: string; key: string; packageDigest: string; createdAt: string; environmentDigest?: string
}
export interface RuntimeCollection {
  checkedAt?: string; removed: string[]; retained: Array<{ directory: string; reason: string }>; error?: string
}

function writeRecord(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(temporary, path) } finally { rmSync(temporary, { force: true }) }
}

function checkMetadataDirectory(path: string, create = false): void {
  if (create) mkdirSync(path, { recursive: true })
  try {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid runtime metadata directory')
  } catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}

/** Called only under PluginHost's exclusive directory ownership and maintenance gate. */
export class PluginRuntimeStorage {
  private readonly records: string
  private readonly uses: string
  private collection: RuntimeCollection = { removed: [], retained: [] }
  constructor(private readonly home: string) {
    this.records = join(home, 'managed-environments')
    this.uses = join(home, 'runtime-uses')
  }

  status(): RuntimeCollection { return structuredClone(this.collection) }
  collectionError(error: unknown): void {
    this.collection = { checkedAt: new Date().toISOString(), removed: [], retained: [], error: error instanceof Error ? error.message : String(error) }
  }

  private name(directory: string): string {
    const name = directoryName(directory)
    if (!directoryPattern.test(name) || !samePath(directory, join(this.home, name))) throw new Error('Invalid managed runtime directory')
    return name
  }

  own(directory: string, key: string, packageDigest: string, environmentDigest?: string): void {
    const name = this.name(directory)
    if (!digestPattern.test(key) || !digestPattern.test(packageDigest) || environmentDigest && !digestPattern.test(environmentDigest)) throw new Error('Invalid runtime ownership identity')
    checkMetadataDirectory(this.records, true)
    // Completion resets the retention clock; incomplete environments also have a creation record.
    writeRecord(join(this.records, `${name}.json`), { schemaVersion: 1, directory: name, key, packageDigest,
      createdAt: new Date().toISOString(), ...(environmentDigest ? { environmentDigest } : {}) } satisfies OwnedEnvironment)
  }

  forget(directory: string): void {
    checkMetadataDirectory(this.records)
    rmSync(join(this.records, `${this.name(directory)}.json`), { force: true })
  }

  forExecutable(python: string): PythonSpawner | undefined {
    const directory = dirname(dirname(python))
    if (!samePath(directory, join(this.home, directoryName(directory))) || !directoryPattern.test(directoryName(directory))) return undefined
    return this.forDirectory(directory)
  }

  forDirectory(directory: string): PythonSpawner {
    const name = this.name(directory)
    return (python, args, options) => {
      checkMetadataDirectory(this.uses, true)
      const path = join(this.uses, `${randomUUID()}.json`)
      const record = { schemaVersion: 1, directory: name, ownerPid: process.pid, startedAt: new Date().toISOString() }
      // Publish before spawning. A crash in the launch/PID-registration gap retains an unresolved ticket.
      writeRecord(path, record)
      let child: ChildProcessWithoutNullStreams
      try { child = spawnPython(python, args, options) }
      catch (error) { rmSync(path, { force: true }); throw error }
      child.once('close', () => { try { rmSync(path, { force: true }) } catch { /* Recovery can remove a dead PID ticket. */ } })
      try { if (child.pid) writeRecord(path, { ...record, pid: child.pid }) }
      catch { /* The pre-spawn ticket still fences this environment until close, or indefinitely after a crash. */ }
      return child
    }
  }

  async collect(input: { packages: Set<string>; environments: Set<string>; directories: Set<string>;
    allowed: () => boolean; onRemove: (directory: string) => void; now?: number }): Promise<RuntimeCollection> {
    const now = input.now ?? Date.now()
    const result: RuntimeCollection = { checkedAt: new Date(now).toISOString(), removed: [], retained: [] }
    try {
      checkMetadataDirectory(this.records)
      checkMetadataDirectory(this.uses)
      const names = await readdir(this.home).catch(error => { if (error.code === 'ENOENT') return []; throw error })
      if (names.length > 10_000) throw new Error('Runtime storage inventory exceeds 10000 entries')
      const busy = new Set<string>()
      const tickets = await readdir(this.uses).catch(error => { if (error.code === 'ENOENT') return []; throw error })
      if (tickets.length > 10_000) throw new Error('Runtime process inventory exceeds 10000 entries')
      for (const name of tickets) {
        if (!name.endsWith('.json')) throw new Error('Unresolved runtime launch metadata; collection deferred')
        const path = join(this.uses, name), ticket = await this.readRecord(path)
        if (ticket.schemaVersion !== 1 || !directoryPattern.test(ticket.directory)) throw new Error('Invalid runtime process ticket; collection deferred')
        if (ticket.pid === undefined) { busy.add(ticket.directory); continue }
        if (!Number.isSafeInteger(ticket.pid) || ticket.pid <= 0) throw new Error('Invalid runtime process PID; collection deferred')
        let alive = true
        try { process.kill(ticket.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
        if (alive) busy.add(ticket.directory)
        else await rm(path, { force: true })
      }
      // Validate the entire live index set before deleting anything. Unknown control state fails closed.
      const indices = new Map<string, { path: string; directory: string }>()
      for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/u.test(name))) {
        const path = join(this.home, name), index = await this.readRecord(path)
        if (index.key !== name.slice(0, -5) || !directoryPattern.test(index.directory)) throw new Error('Invalid runtime index; collection deferred')
        indices.set(index.key, { path, directory: index.directory })
      }
      for (const name of names.filter(name => name.startsWith('env-')).sort()) {
        if (!input.allowed()) break
        const keep = (reason: string) => result.retained.push({ directory: name, reason })
        if (!directoryPattern.test(name)) { keep('unmanaged directory'); continue }
        const directory = join(this.home, name), stat = await lstat(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink()) { keep('not a managed directory'); continue }
        let record: OwnedEnvironment
        try { record = await this.readRecord(join(this.records, `${name}.json`)) as OwnedEnvironment }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { keep('legacy or untracked environment'); continue }; throw error }
        if (record.schemaVersion !== 1 || record.directory !== name || !digestPattern.test(record.key) || !digestPattern.test(record.packageDigest) ||
          !Number.isFinite(Date.parse(record.createdAt)) || record.environmentDigest !== undefined && !digestPattern.test(record.environmentDigest)) throw new Error('Invalid runtime ownership record; collection deferred')
        if ([...indices.entries()].some(([key, index]) => index.directory === name && key !== record.key)) throw new Error('Runtime ownership and cache index disagree; collection deferred')
        if (busy.has(name)) { keep('live or unresolved Python process'); continue }
        const index = indices.get(record.key)
        if ([...input.directories].some(value => samePath(value, directory)) || input.packages.has(record.packageDigest) && index?.directory === name) { keep('active, rollback or held version'); continue }
        if (record.environmentDigest && input.environments.has(record.environmentDigest)) { keep('saved workflow or readiness reference'); continue }
        if (now - Date.parse(record.createdAt) < 7 * 24 * 60 * 60_000) { keep('seven-day retention period'); continue }
        if (result.removed.length >= 2) { keep('collection batch limit'); continue }
        if (!input.allowed()) break
        // Stop reuse before deleting. The host gate excludes new preparation, validation and execution.
        if (index?.directory === name) await rm(index.path)
        input.onRemove(directory)
        await rm(directory, { recursive: true, force: true, maxRetries: 2 })
        this.forget(directory)
        result.removed.push(name)
      }
    } catch (error) { result.error = error instanceof Error ? error.message : String(error) }
    this.collection = result
    return this.status()
  }

  private async readRecord(path: string): Promise<any> {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('Invalid runtime storage metadata')
    return JSON.parse(await readFile(path, 'utf8'))
  }
}
