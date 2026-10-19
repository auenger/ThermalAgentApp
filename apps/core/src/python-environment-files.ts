import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

/** Inspect cached runtime bytes without starting its interpreter or executing site/.pth hooks. */
export async function pythonEnvironmentFiles(root: string, signal?: AbortSignal): Promise<string> {
  const deadline = Date.now() + 60_000
  const check = () => {
    if (signal?.aborted) throw Object.assign(new Error('Runtime preparation cancelled'), { code: 'VALIDATION_DEFERRED' })
    if (Date.now() > deadline) throw new Error('Python runtime file inventory timed out')
  }
  const entry = await lstat(root)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid isolated runtime directory')
  const canonicalRoot = await realpath(root)
  const records: unknown[] = []
  let entries = 0, bytes = 0
  const hashFile = async (path: string) => {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('Invalid runtime file')
    if (bytes + before.size > 1024 ** 3) throw new Error('Python runtime file inventory exceeds 1 GiB')
    const hash = createHash('sha256'), stream = createReadStream(path)
    const stop = () => stream.destroy(Object.assign(new Error('Runtime preparation cancelled'), { code: 'VALIDATION_DEFERRED' }))
    const timer = setTimeout(() => stream.destroy(new Error('Python runtime file inventory timed out')), Math.max(1, deadline - Date.now()))
    signal?.addEventListener('abort', stop, { once: true })
    let size = 0
    try {
      for await (const chunk of stream) {
        check(); size += chunk.length; bytes += chunk.length
        if (bytes > 1024 ** 3) throw new Error('Python runtime file inventory exceeds 1 GiB')
        hash.update(chunk)
      }
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); stream.destroy() }
    const after = await lstat(path)
    if (size !== before.size || after.size !== before.size || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Runtime file changed during inventory')
    return { size, mode: before.mode & 0o777, sha256: hash.digest('hex') }
  }
  const walk = async (directory: string, prefix = '', depth = 0): Promise<void> => {
    if (depth > 64) throw new Error('Python runtime directory nesting exceeds limit')
    for (const name of (await readdir(directory)).sort()) {
      check()
      if (name === '.DS_Store') continue
      if (++entries > 100_000) throw new Error('Python runtime inventory exceeds 100000 entries')
      const path = join(directory, name), key = prefix ? `${prefix}/${name}` : name, stat = await lstat(path)
      if (stat.isSymbolicLink()) {
        const link = await readlink(path), target = await realpath(path), targetStat = await lstat(target)
        if (targetStat.isDirectory()) {
          // Standard venv lib64 -> lib is covered by the ordinary traversal; never follow directory links.
          const rel = relative(canonicalRoot, target)
          if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('External runtime directory link is unsupported')
          records.push({ path: key, link, target })
        } else records.push({ path: key, link, target, ...await hashFile(target) })
      } else if (stat.isDirectory()) await walk(path, key, depth + 1)
      else records.push({ path: key, ...await hashFile(path) })
    }
  }
  await walk(root)
  check()
  return createHash('sha256').update(JSON.stringify({ schemaVersion: 1, records })).digest('hex')
}
