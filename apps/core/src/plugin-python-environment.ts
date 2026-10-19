import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ManagedPluginManifest } from '@thermal-agent/contracts'
import { terminateProcessTree } from '@thermal-agent/process-control'
import { inspectPythonRuntime, type PythonRuntimeSnapshot } from './python-environment.js'
import { pluginEnvironmentDigest } from './plugin-store.js'
import { pythonEnvironmentFiles } from './python-environment-files.js'
import { PluginRuntimeStorage, spawnPython, type PythonSpawner } from './plugin-runtime-storage.js'
import type { PluginWheelAssets } from './plugin-wheel-assets.js'

export interface PythonEnvironmentRepair {
  packageDigest: string; key: string; previousDirectory: string; reason: string; detectedAt: string;
  status: 'rebuilding' | 'prepared' | 'failed'; replacementDirectory?: string; error?: string
}

/** No shell, index access, source builds, user pip settings, or mutation of an existing environment. */
async function command(python: string, args: string[], signal?: AbortSignal, launch: PythonSpawner = spawnPython): Promise<void> {
  if (signal?.aborted) throw Object.assign(new Error('Runtime preparation cancelled'), { code: 'VALIDATION_DEFERRED' })
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env, PYTHONPATH: '', PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : '/dev/null' }
    for (const key of Object.keys(env)) if (/^PIP_/iu.test(key) && key !== 'PIP_CONFIG_FILE') delete env[key as keyof typeof env]
    const child = launch(python, ['-I', '-B', ...args], { env, windowsHide: true })
    child.stdin.end()
    let output = '', size = 0, timedOut = false
    const stop = () => terminateProcessTree(child, { force: true })
    const timer = setTimeout(() => { timedOut = true; stop() }, 120_000)
    const collect = (chunk: Buffer) => { size += chunk.length; output = (output + chunk.toString()).slice(-3000); if (size > 2_000_000) stop() }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    signal?.addEventListener('abort', stop, { once: true })
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error) })
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop)
      if (signal?.aborted) reject(Object.assign(new Error('Runtime preparation cancelled'), { code: 'VALIDATION_DEFERRED' }))
      else if (timedOut || size > 2_000_000 || code !== 0) reject(new Error(`Isolated Python preparation failed: ${timedOut ? 'timeout' : output}`))
      else resolve()
    })
  })
}

/** A venv is created at its final unique path: Python environments must not be moved after creation. */
export class PluginPythonEnvironments {
  private readonly repairs = new Map<string, PythonEnvironmentRepair>()
  constructor(private readonly home: string, private readonly storage = new PluginRuntimeStorage(home), private readonly assets?: PluginWheelAssets) {}

  status(): PythonEnvironmentRepair[] { return structuredClone([...this.repairs.values()]) }

  private async recordRepair(repair: PythonEnvironmentRepair): Promise<void> {
    this.repairs.delete(repair.key); this.repairs.set(repair.key, structuredClone(repair))
    if (this.repairs.size > 20) this.repairs.delete(this.repairs.keys().next().value!)
    const path = join(this.home, `${repair.key}.repair.json`), temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(repair), { flag: 'wx', mode: 0o600 })
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }

  async prepare(input: { digest: string; root: string; manifest: ManagedPluginManifest; base: PythonRuntimeSnapshot;
    distributions: string[]; signal?: AbortSignal; allowRepair?: boolean; onInvalidated?: () => void }): Promise<PythonRuntimeSnapshot> {
    const checkCancelled = () => {
      if (input.signal?.aborted) throw Object.assign(new Error('Runtime preparation cancelled'), { code: 'VALIDATION_DEFERRED' })
    }
    checkCancelled()
    const lock = input.manifest.pythonRuntime
    if (!lock) return input.base
    await mkdir(this.home, { recursive: true })
    const key = createHash('sha256').update(JSON.stringify({ package: input.digest, base: pluginEnvironmentDigest(input.base.environment), python: input.base.executable })).digest('hex')
    const index = join(this.home, `${key}.json`)
    const distributions = [...new Set([...input.distributions, 'pip', 'setuptools', ...lock.wheels.map(w => w.name)])]
    const inspect = async (directory: string) => {
      const python = join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      const snapshot = await inspectPythonRuntime(python, distributions, 120_000, this.storage.forDirectory(directory))
      for (const wheel of lock.wheels) if (snapshot.environment.versions[wheel.name] !== wheel.version) throw new Error(`Installed dependency does not match lock: ${wheel.name}`)
      // Binding the independent host reference also invalidates receipts when the shipped verifier changes.
      snapshot.environment.versions['host-reference'] = pluginEnvironmentDigest(input.base.environment)
      for (const fact of ['aedt-installations', 'aedt-launch-bindings', 'engineering-validation']) {
        if (input.base.environment.versions[fact]) snapshot.environment.versions[fact] = input.base.environment.versions[fact]
      }
      if (input.base.aedtEnvironment) snapshot.aedtEnvironment = { ...input.base.aedtEnvironment }
      return snapshot
    }
    let repair: PythonEnvironmentRepair | undefined
    try {
      const path = join(this.home, `${key}.repair.json`), stat = await lstat(path)
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 10_000) {
        const record = JSON.parse(await readFile(path, 'utf8')) as PythonEnvironmentRepair
        if (record.key === key && record.packageDigest === input.digest && ['prepared', 'failed', 'rebuilding'].includes(record.status) &&
          typeof record.reason === 'string' && typeof record.detectedAt === 'string' && /^env-[a-f0-9-]{36}$/u.test(record.previousDirectory)) {
          this.repairs.set(key, record)
          if (this.repairs.size > 20) this.repairs.delete(this.repairs.keys().next().value!)
          if (record.status !== 'prepared') repair = record
        }
      }
    } catch { /* Repair notes are diagnostics, not executable runtime indices. */ }
    try {
      const stat = await lstat(index)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1000) throw new Error('Invalid isolated runtime index')
      const record = JSON.parse(await readFile(index, 'utf8'))
      if (record.key !== key || typeof record.directory !== 'string' || !/^env-[a-f0-9-]{36}$/u.test(record.directory)) throw new Error('Invalid isolated runtime index')
      const directory = join(this.home, record.directory)
      try {
        if (record.schemaVersion !== 2 || !/^[a-f0-9]{64}$/u.test(record.filesDigest ?? '')) throw new Error('Runtime cache requires host file-inventory migration')
        const before = await pythonEnvironmentFiles(directory, input.signal)
        if (before !== record.filesDigest) throw new Error('Isolated runtime files changed since installation')
        const snapshot = await inspect(directory)
        checkCancelled()
        if (record.environmentDigest !== pluginEnvironmentDigest(snapshot.environment) ||
          await pythonEnvironmentFiles(directory, input.signal) !== before) throw new Error('Isolated runtime contents changed since installation')
        if (repair) await this.recordRepair({ ...repair, status: 'prepared', replacementDirectory: record.directory, error: undefined }).catch(() => {})
        return snapshot
      } catch (error) {
        checkCancelled()
        input.onInvalidated?.()
        if ((error as { code?: string })?.code === 'VALIDATION_DEFERRED' || input.allowRepair === false) throw error
        repair = { packageDigest: input.digest, key, previousDirectory: record.directory,
          reason: error instanceof Error ? error.message : String(error), detectedAt: new Date().toISOString(), status: 'rebuilding' }
        await this.recordRepair(repair)
        // Preserve the original directory and its receipt; never execute it to repair itself.
        await rename(index, join(this.home, `${key}.quarantined-${randomUUID()}.json`))
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    input.onInvalidated?.()
    if (input.allowRepair === false) throw new Error('Runtime rebuilding requires automatic updates to be enabled')
    const name = `env-${randomUUID()}`, directory = join(this.home, name)
    let created = false
    const failurePath = join(this.home, `${key}.failure.json`)
    try {
      try {
        const failure = JSON.parse(await readFile(failurePath, 'utf8'))
        if (Number.isFinite(failure.at) && Date.now() - failure.at < 15 * 60_000) throw Object.assign(new Error(`Runtime preparation retry deferred: ${String(failure.error).slice(0, 3000)}`), { code: 'RUNTIME_RETRY_DEFERRED' })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if ((await readdir(this.home)).filter(name => name.startsWith('env-')).length >= 64) throw new Error('Isolated runtime storage is full; archive unused runtimes before installing more')
      checkCancelled()
      if (repair) await this.recordRepair({ ...repair, status: 'rebuilding', error: undefined })
      await mkdir(directory)
      created = true
      this.storage.own(directory, key, input.digest)
      const run = (python: string, args: string[]) => command(python, args, input.signal, this.storage.forDirectory(directory))
      const wheelPaths: string[] = [], requirements: string[] = []
      for (const wheel of lock.wheels) {
        if (wheel.asset) {
          if (!this.assets) throw Object.assign(new Error('External wheel asset cache is not configured'), { code: 'RUNTIME_ASSET_UNAVAILABLE' })
          const path = await this.assets.materialize(wheel, join(directory, '.wheel-inputs'), input.signal)
          wheelPaths.push(path)
          requirements.push(`${pathToFileURL(path).href} --hash=sha256:${wheel.sha256}`)
          continue
        }
        const path = join(input.root, wheel.path), stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid locked wheel file')
        const bytes = await readFile(path)
        if (createHash('sha256').update(bytes).digest('hex') !== wheel.sha256) throw new Error('Locked wheel SHA-256 mismatch')
        wheelPaths.push(path)
        requirements.push(`${pathToFileURL(path).href} --hash=sha256:${wheel.sha256}`)
      }
      await run(input.base.executable, ['-c',
        'import sys,zipfile\nn=0;size=0\nfor p in sys.argv[1:]:\n with zipfile.ZipFile(p) as z:\n  n+=len(z.infolist());size+=sum(i.file_size for i in z.infolist())\n  if n>200000 or size>2*1024*1024*1024: raise RuntimeError("Wheel expansion budget exceeded")', ...wheelPaths])
      await run(input.base.executable, ['-m', 'venv', process.platform === 'win32' ? '--copies' : '--symlinks', directory])
      const python = join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      const requirementsPath = join(directory, 'locked-requirements.txt')
      await writeFile(requirementsPath, `${requirements.join('\n')}\n`, { flag: 'wx', mode: 0o600 })
      await run(python, ['-m', 'pip', '--isolated', 'install', '--prefix', directory, '--no-user', '--no-index', '--no-deps',
        '--require-hashes', '--only-binary=:all:', '--no-compile', '--no-cache-dir', '--disable-pip-version-check', '-r', requirementsPath])
      await run(python, ['-m', 'pip', '--isolated', 'check', '--disable-pip-version-check'])
      await rm(join(directory, '.wheel-inputs'), { recursive: true, force: true })
      const snapshot = await inspect(directory)
      const filesDigest = await pythonEnvironmentFiles(directory, input.signal)
      this.storage.own(directory, key, input.digest, pluginEnvironmentDigest(snapshot.environment))
      if (input.signal?.aborted) throw Object.assign(new Error('Runtime preparation cancelled'), { code: 'VALIDATION_DEFERRED' })
      const temporary = join(this.home, `${key}-${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify({ schemaVersion: 2, key, directory: name, filesDigest, environmentDigest: pluginEnvironmentDigest(snapshot.environment) }), { flag: 'wx', mode: 0o600 })
      await rename(temporary, index)
      await rm(failurePath, { force: true }).catch(() => {})
      if (repair) await this.recordRepair({ ...repair, status: 'prepared', replacementDirectory: name }).catch(() => {})
      return snapshot
    } catch (error) {
      if (input.signal?.aborted) error = Object.assign(new Error('Runtime preparation cancelled'), { code: 'VALIDATION_DEFERRED' })
      if (created) { await rm(directory, { recursive: true, force: true }); this.storage.forget(directory) }
      if (!['VALIDATION_DEFERRED', 'RUNTIME_RETRY_DEFERRED', 'RUNTIME_ASSET_UNAVAILABLE'].includes((error as { code?: string })?.code ?? '')) {
        await writeFile(failurePath, JSON.stringify({ at: Date.now(), error: error instanceof Error ? error.message : String(error) }), { mode: 0o600 })
      }
      if (repair) await this.recordRepair({ ...repair, status: 'failed', error: error instanceof Error ? error.message : String(error) }).catch(() => {})
      throw error
    }
  }
}
