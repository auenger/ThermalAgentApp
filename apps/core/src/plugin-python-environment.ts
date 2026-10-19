import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ManagedPluginManifest } from '@thermal-agent/contracts'
import { terminateProcessTree } from '@thermal-agent/process-control'
import { inspectPythonRuntime, type PythonRuntimeSnapshot } from './python-environment.js'
import { pluginEnvironmentDigest } from './plugin-store.js'

/** No shell, index access, source builds, user pip settings, or mutation of an existing environment. */
async function command(python: string, args: string[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw Object.assign(new Error('Runtime preparation cancelled'), { code: 'VALIDATION_DEFERRED' })
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env, PYTHONPATH: '', PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : '/dev/null' }
    for (const key of Object.keys(env)) if (/^PIP_/iu.test(key) && key !== 'PIP_CONFIG_FILE') delete env[key as keyof typeof env]
    const child = spawn(python, ['-I', '-B', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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
  constructor(private readonly home: string) {}

  async prepare(input: { digest: string; root: string; manifest: ManagedPluginManifest; base: PythonRuntimeSnapshot;
    distributions: string[]; signal?: AbortSignal }): Promise<PythonRuntimeSnapshot> {
    const lock = input.manifest.pythonRuntime
    if (!lock) return input.base
    await mkdir(this.home, { recursive: true })
    const key = createHash('sha256').update(JSON.stringify({ package: input.digest, base: pluginEnvironmentDigest(input.base.environment), python: input.base.executable })).digest('hex')
    const index = join(this.home, `${key}.json`)
    const distributions = [...new Set([...input.distributions, 'pip', 'setuptools', ...lock.wheels.map(w => w.name)])]
    const inspect = async (directory: string) => {
      const python = join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      const snapshot = await inspectPythonRuntime(python, distributions)
      for (const wheel of lock.wheels) if (snapshot.environment.versions[wheel.name] !== wheel.version) throw new Error(`Installed dependency does not match lock: ${wheel.name}`)
      // Binding the independent host reference also invalidates receipts when the shipped verifier changes.
      snapshot.environment.versions['host-reference'] = pluginEnvironmentDigest(input.base.environment)
      for (const fact of ['aedt-installations', 'engineering-validation']) {
        if (input.base.environment.versions[fact]) snapshot.environment.versions[fact] = input.base.environment.versions[fact]
      }
      return snapshot
    }
    try {
      const stat = await lstat(index)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1000) throw new Error('Invalid isolated runtime index')
      const record = JSON.parse(await readFile(index, 'utf8'))
      if (record.key !== key || typeof record.directory !== 'string' || !/^env-[a-f0-9-]{36}$/u.test(record.directory)) throw new Error('Invalid isolated runtime index')
      const directory = join(this.home, record.directory), entry = await lstat(directory)
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid isolated runtime directory')
      const snapshot = await inspect(directory)
      if (record.environmentDigest !== pluginEnvironmentDigest(snapshot.environment)) throw new Error('Isolated runtime contents changed since installation')
      return snapshot
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const failurePath = join(this.home, `${key}.failure.json`)
    try {
      const failure = JSON.parse(await readFile(failurePath, 'utf8'))
      if (Number.isFinite(failure.at) && Date.now() - failure.at < 15 * 60_000) throw new Error(`Runtime preparation retry deferred: ${String(failure.error).slice(0, 3000)}`)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if ((await readdir(this.home)).filter(name => name.startsWith('env-')).length >= 64) throw new Error('Isolated runtime storage is full; archive unused runtimes before installing more')
    const name = `env-${randomUUID()}`, directory = join(this.home, name)
    await mkdir(directory)
    try {
      const wheelPaths: string[] = [], requirements: string[] = []
      for (const wheel of lock.wheels) {
        const path = join(input.root, wheel.path), stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid locked wheel file')
        const bytes = await readFile(path)
        if (createHash('sha256').update(bytes).digest('hex') !== wheel.sha256) throw new Error('Locked wheel SHA-256 mismatch')
        wheelPaths.push(path)
        requirements.push(`${pathToFileURL(path).href} --hash=sha256:${wheel.sha256}`)
      }
      await command(input.base.executable, ['-c',
        'import sys,zipfile\nn=0;size=0\nfor p in sys.argv[1:]:\n with zipfile.ZipFile(p) as z:\n  n+=len(z.infolist());size+=sum(i.file_size for i in z.infolist())\n  if n>100000 or size>512*1024*1024: raise RuntimeError("Wheel expansion budget exceeded")', ...wheelPaths], input.signal)
      await command(input.base.executable, ['-m', 'venv', process.platform === 'win32' ? '--copies' : '--symlinks', directory], input.signal)
      const python = join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      const requirementsPath = join(directory, 'locked-requirements.txt')
      await writeFile(requirementsPath, `${requirements.join('\n')}\n`, { flag: 'wx', mode: 0o600 })
      await command(python, ['-m', 'pip', '--isolated', 'install', '--prefix', directory, '--no-user', '--no-index', '--no-deps',
        '--require-hashes', '--only-binary=:all:', '--no-compile', '--no-cache-dir', '--disable-pip-version-check', '-r', requirementsPath], input.signal)
      await command(python, ['-m', 'pip', '--isolated', 'check', '--disable-pip-version-check'], input.signal)
      const snapshot = await inspect(directory)
      if (input.signal?.aborted) throw Object.assign(new Error('Runtime preparation cancelled'), { code: 'VALIDATION_DEFERRED' })
      const temporary = join(this.home, `${key}-${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify({ key, directory: name, environmentDigest: pluginEnvironmentDigest(snapshot.environment) }), { flag: 'wx', mode: 0o600 })
      await rename(temporary, index)
      await rm(failurePath, { force: true }).catch(() => {})
      return snapshot
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      if ((error as { code?: string })?.code !== 'VALIDATION_DEFERRED') {
        await writeFile(failurePath, JSON.stringify({ at: Date.now(), error: error instanceof Error ? error.message : String(error) }), { mode: 0o600 })
      }
      throw error
    }
  }
}
