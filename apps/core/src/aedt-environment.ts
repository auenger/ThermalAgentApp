import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

export interface AedtInstallationEvidence {
  source: string
  root: string
  resolvedRoot?: string
  status: 'present' | 'missing'
  files: Array<{ path: string; size: number; sha256: string }>
}
export interface AedtEnvironmentSnapshot { digest: string; installations: AedtInstallationEvidence[] }

export interface AedtLaunchBindings {
  digest: string
  environment: Record<string, string>
  repairs: Array<{ variable: string; previous?: string; path: string }>
  diagnostics: string[]
}

/** Derive process-local launch settings from host inventory, without writing machine/user settings. */
export function aedtLaunchBindings(snapshot: AedtEnvironmentSnapshot, automatic: boolean): AedtLaunchBindings {
  const environment: Record<string, string> = {}, repairs: AedtLaunchBindings['repairs'] = [], diagnostics: string[] = []
  const candidates = new Map<string, Set<string>>()
  const explicit = new Map<string, AedtInstallationEvidence>()
  for (const record of snapshot.installations) {
    if (/^ANSYSEM(?:SV|_PY_CLIENT)?_ROOT\d{3}$/u.test(record.source)) {
      environment[record.source] = record.root
      explicit.set(record.source, record)
    }
    const version = /^ANSYSEM_ROOT(\d{2}[1-9])$/u.exec(record.source)?.[1]
      ?? /^ProgramFiles\/(?:AnsysEM|ANSYS Inc)\/v(\d{2}[1-9])$/iu.exec(record.source)?.[1]
    if (!version || !record.resolvedRoot || record.status !== 'present') continue
    const paths = candidates.get(`ANSYSEM_ROOT${version}`) ?? new Set<string>()
    for (const file of record.files) {
      if (/^(?:Win64\/)?ansysedt\.exe$/iu.test(file.path)) paths.add(resolve(record.resolvedRoot, file.path, '..'))
    }
    candidates.set(`ANSYSEM_ROOT${version}`, paths)
  }
  if (automatic) for (const [variable, paths] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    // A working explicitly configured installation wins over other installations of the same release.
    if (explicit.get(variable)?.files.some(file => /^ansysedt\.exe$/iu.test(file.path))) continue
    const unique = [...paths].filter((path, index, all) => all.findIndex(other => other.toLowerCase() === path.toLowerCase()) === index)
    if (unique.length !== 1) { diagnostics.push(`${variable}: multiple installation paths; automatic binding deferred`); continue }
    const previous = environment[variable], path = unique[0]
    if (previous !== path) {
      environment[variable] = path
      repairs.push({ variable, previous, path })
    }
  }
  const ordered = Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)))
  return { digest: createHash('sha256').update(JSON.stringify({ schemaVersion: 1, environment: ordered })).digest('hex'), environment: ordered, repairs, diagnostics }
}

/** Host-only filesystem inventory. Does not load DLLs, execute AEDT, or consume a license. */
export async function inspectAedtEnvironment(platform: string, environment: NodeJS.ProcessEnv = process.env,
  limits = { maxFiles: 5000, maxBytes: 4 * 1024 ** 3, timeoutMs: 60_000 }): Promise<AedtEnvironmentSnapshot> {
  const installations: AedtInstallationEvidence[] = []
  const digest = () => createHash('sha256').update(JSON.stringify({ schemaVersion: 1, platform, installations })).digest('hex')
  if (platform !== 'win32') return { digest: digest(), installations }
  const deadline = Date.now() + limits.timeoutMs
  const checkTime = () => { if (Date.now() > deadline) throw new Error('AEDT environment inventory timed out') }
  const roots = new Map<string, string>()
  for (const [key, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) {
    if (/^ANSYSEM(?:SV|_PY_CLIENT)?_ROOT\d{3}$/iu.test(key) && value) {
      if (!isAbsolute(value)) throw new Error(`AEDT installation variable ${key} must be absolute`)
      roots.set(key.toUpperCase(), resolve(value))
    }
  }
  const programFiles = Object.entries(environment).find(([key]) => key.toLowerCase() === 'programfiles')?.[1] ?? 'C:\\Program Files'
  // Covers the legacy probe's AnsysEM/vXYZ layout and the newer ANSYS Inc/vXYZ/AnsysEM layout.
  for (const vendor of ['AnsysEM', 'ANSYS Inc']) {
    const parent = join(programFiles, vendor)
    let children
    try { children = await readdir(parent, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!child.isDirectory() || !/^v\d{3}$/iu.test(child.name)) continue
      const root = vendor === 'AnsysEM' ? join(parent, child.name) : join(parent, child.name, 'AnsysEM')
      roots.set(`ProgramFiles/${vendor}/${child.name}`, root)
    }
  }
  if (roots.size > 64) throw new Error('AEDT environment exceeds 64 installation roots')
  let files = 0, bytes = 0
  for (const [source, root] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
    checkTime()
    const record: AedtInstallationEvidence = { source, root, status: 'missing', files: [] }
    installations.push(record)
    try { record.resolvedRoot = await realpath(root) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    // Include immediate native runtime files beside the executable, not changing projects/logs/license files.
    for (const subdirectory of ['', 'Win64']) {
      const directory = join(record.resolvedRoot, subdirectory)
      let entries
      try { entries = await readdir(directory, { withFileTypes: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!/\.(exe|dll|pyd)$/iu.test(entry.name)) continue
        checkTime()
        const path = join(directory, entry.name), before = await lstat(path)
        if (!before.isFile() || before.isSymbolicLink()) throw new Error('AEDT runtime inventory contains a non-regular file')
        if (++files > limits.maxFiles || bytes + before.size > limits.maxBytes) throw new Error('AEDT runtime inventory exceeds its file or byte budget')
        const hash = createHash('sha256')
        let size = 0
        const stream = createReadStream(path)
        const timer = setTimeout(() => stream.destroy(new Error('AEDT environment inventory timed out')), Math.max(1, deadline - Date.now()))
        try {
          for await (const chunk of stream) {
            checkTime(); size += chunk.length; bytes += chunk.length
            if (bytes > limits.maxBytes) throw new Error('AEDT runtime inventory exceeds its byte budget')
            hash.update(chunk)
          }
        } finally { clearTimeout(timer); stream.destroy() }
        const after = await lstat(path)
        if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw new Error('AEDT runtime changed while collecting its identity')
        record.files.push({ path: subdirectory ? `${subdirectory}/${entry.name}` : entry.name, size, sha256: hash.digest('hex') })
        if (entry.name.toLowerCase() === 'ansysedt.exe') record.status = 'present'
      }
    }
  }
  return { digest: digest(), installations }
}
