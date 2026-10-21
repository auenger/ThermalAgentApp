import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

export interface DshReleaseManifest {
  schema: 1
  version: string
  platform: string
  arch: string
  bridgeProtocol: 1
  cli: string
  node: string
  plugin: string
  files: Record<string, string>
}
export interface DshSelection { release?: string; profile: string }
interface State { schema: 1; active?: DshSelection; previous?: DshSelection; pending?: { release: string } | { rollback: true }; error?: string; bundledVersion?: string; backup?: string }
export interface DshLaunch { selection: DshSelection; cli?: string; node?: string; plugin?: string }

function relativeFile(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.includes('\\') &&
    !value.includes(':') && value.split('/').every(part => !!part && part !== '.' && part !== '..')
}
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function inventory(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = []
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name
    if (!relativeFile(path) || item.isSymbolicLink()) throw new Error(`DSH runtime contains an unsafe path: ${path}`)
    if (item.isDirectory()) files.push(...await inventory(root, path))
    else if (item.isFile()) files.push(path)
    else throw new Error(`Unsupported DSH runtime entry: ${path}`)
    if (files.length > 100_000) throw new Error('DSH runtime contains too many files')
  }
  return files
}

/** Local release import: a digest verifies transfer integrity, not publisher identity. */
export async function validateDshRelease(root: string, expected?: string): Promise<{ manifest: DshReleaseManifest; id: string }> {
  if (!(await lstat(root)).isDirectory()) throw new Error('DSH runtime must be a real directory')
  const metadata = await lstat(join(root, 'runtime.json'))
  if (!metadata.isFile() || metadata.size > 32 * 1024 ** 2) throw new Error('Invalid DSH release manifest file')
  const raw = await readFile(join(root, 'runtime.json'), 'utf8')
  const id = createHash('sha256').update(raw).digest('hex')
  if (expected && expected !== id) throw new Error('DSH release manifest changed')
  const manifest = JSON.parse(raw) as DshReleaseManifest
  if (manifest.schema !== 1 || manifest.bridgeProtocol !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(manifest.version) || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('DSH release version, platform, architecture or Bridge protocol is incompatible')
  }
  for (const key of ['cli', 'node', 'plugin'] as const) {
    if (!relativeFile(manifest[key]) || !Object.hasOwn(manifest.files, manifest[key])) throw new Error(`DSH release is missing ${key}`)
  }
  const paths = await inventory(root)
  const entries = Object.entries(manifest.files)
  if (!entries.length || entries.length > 100_000 || paths.length !== entries.length + 1 || !paths.includes('runtime.json')) throw new Error('DSH release inventory is incomplete')
  const actual = new Set(paths)
  let total = 0
  for (const [file, hash] of entries) {
    if (!relativeFile(file) || file === 'runtime.json' || !actual.has(file) || !/^[a-f0-9]{64}$/u.test(hash)) throw new Error('Invalid DSH file inventory')
    total += (await lstat(join(root, file))).size
    if (total > 4 * 1024 ** 3) throw new Error('DSH runtime exceeds 4 GiB')
    if (await digest(join(root, file)) !== hash) throw new Error(`DSH runtime integrity check failed: ${file}`)
  }
  const pkg = JSON.parse(await readFile(resolve(root, manifest.cli, '../../package.json'), 'utf8'))
  if (pkg.name !== '@deepseek-ai/dsh' || pkg.version !== manifest.version) throw new Error('DSH CLI version does not match release manifest')
  return { manifest, id }
}

/** Packages and profiles are versioned separately; old data is never migrated in place by a new engine. */
export class DshRuntimeStore {
  private busy = false
  readonly root: string
  constructor(private readonly home: string) { this.root = join(home, 'dsh-runtimes') }
  private async read(): Promise<State> {
    let raw: string
    try { raw = await readFile(join(this.root, 'state.json'), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 1 }; throw error }
    const state = JSON.parse(raw) as State
    const valid = (v: DshSelection) => v && (v.release === undefined || /^[a-f0-9]{64}$/u.test(v.release)) &&
      (v.profile === 'dsh' || /^dsh-profiles\/[a-f0-9-]{36}$/u.test(v.profile))
    if (state.schema !== 1 || (state.active && !valid(state.active)) || (state.previous && !valid(state.previous)) ||
      (state.pending && !('rollback' in state.pending ? state.pending.rollback === true : /^[a-f0-9]{64}$/u.test(state.pending.release)))) throw new Error('DSH runtime selection is damaged')
    return state
  }
  private async write(state: State): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const temporary = join(this.root, `${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 })
    await rename(temporary, join(this.root, 'state.json'))
  }
  /** Preserve pre-upgrade data before a newer bundled engine can migrate it. */
  async backupBundledProfile(version: string): Promise<void> {
    const state = await this.read()
    if (state.bundledVersion === version || state.active?.release) return
    const selected = state.active ?? { profile: 'dsh' }
    const backup = `bundled-backups/${randomUUID()}`
    let exists = true
    try { await lstat(this.profile(selected)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false
      else throw error
    }
    if (exists) await cp(this.profile(selected), join(this.root, backup), { recursive: true, errorOnExist: true, force: false })
    await this.write({ ...state, bundledVersion: version, backup: exists ? backup : state.backup })
  }
  async status() {
    const state = await this.read()
    return { active: state.active?.release ?? 'bundled', previous: state.previous ? state.previous.release ?? 'bundled' : undefined,
      pending: state.pending, busy: this.busy, error: state.error, backup: state.backup }
  }
  async stage(source: string): Promise<string> {
    if (this.busy) throw new Error('DSH runtime operation is already running')
    this.busy = true
    const temporary = join(this.root, `import-${randomUUID()}`)
    try {
      const { id } = await validateDshRelease(resolve(source))
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      await cp(resolve(source), temporary, { recursive: true, errorOnExist: true, force: false })
      await validateDshRelease(temporary, id)
      const target = join(this.root, id)
      try { await rename(temporary, target) }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await validateDshRelease(target, id)
      }
      const state = await this.read()
      if (state.active?.release === id) throw new Error('This DSH runtime is already active')
      await this.write({ ...state, pending: { release: id }, error: undefined })
      return id
    } finally { await rm(temporary, { recursive: true, force: true }); this.busy = false }
  }
  async scheduleRollback(): Promise<void> {
    if (this.busy) throw new Error('DSH runtime operation is already running')
    const state = await this.read()
    if (!state.previous) throw new Error('No previous DSH runtime is available')
    await this.write({ ...state, pending: { rollback: true }, error: undefined })
  }
  async launch(selection: DshSelection): Promise<DshLaunch> {
    if (!selection.release) return { selection }
    const root = join(this.root, selection.release)
    const { manifest } = await validateDshRelease(root, selection.release)
    return { selection, cli: join(root, manifest.cli), node: join(root, manifest.node), plugin: join(root, manifest.plugin) }
  }
  profile(selection: DshSelection): string { return join(this.home, selection.profile) }
  async prepare(): Promise<{ current: DshSelection; candidate?: DshSelection }> {
    const state = await this.read()
    const current = state.active ?? { profile: 'dsh' }
    if (!state.pending) return { current }
    // Consume before attempting: a crash cannot repeatedly attempt an unproven upgrade.
    await this.write({ ...state, pending: undefined, error: 'DSH upgrade did not finish; previous runtime retained' })
    if ('rollback' in state.pending) return { current, candidate: state.previous }
    const candidate = { release: state.pending.release, profile: `dsh-profiles/${randomUUID()}` }
    await this.launch(candidate)
    await mkdir(this.profile(current), { recursive: true })
    await cp(this.profile(current), this.profile(candidate), { recursive: true, errorOnExist: true, force: false })
    return { current, candidate }
  }
  async commit(current: DshSelection, candidate: DshSelection): Promise<void> {
    const state = await this.read()
    await this.write({ ...state, active: candidate, previous: current, error: undefined })
  }
  async failed(error: unknown): Promise<void> {
    const state = await this.read()
    await this.write({ ...state, error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000) })
  }
  async current(): Promise<DshSelection> { return (await this.read()).active ?? { profile: 'dsh' } }
}
