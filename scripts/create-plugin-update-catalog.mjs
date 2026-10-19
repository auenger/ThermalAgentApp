import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'

const [outputArg, ...releaseArgs] = process.argv.slice(2)
if (!outputArg || releaseArgs.length < 1 || releaseArgs.length > 50) throw new Error('Usage: node scripts/create-plugin-update-catalog.mjs <new-index.json> <release.json> [more releases...]')
const output = resolve(outputArg), seen = new Set()
const releases = releaseArgs.map(argument => {
  const path = resolve(argument), pathFromIndex = relative(dirname(output), path)
  if (!pathFromIndex || isAbsolute(pathFromIndex) || pathFromIndex.startsWith(`..${sep}`) || pathFromIndex === '..' || resolve(dirname(output), pathFromIndex) !== path || !statSync(path).isFile() || statSync(path).size > 48 * 1024 * 1024) throw new Error('Release must be a bounded file inside the catalog directory')
  const bytes = readFileSync(path), envelope = JSON.parse(bytes.toString('utf8'))
  if (envelope.schemaVersion !== 1 || typeof envelope.publisherId !== 'string' || typeof envelope.signature !== 'string' || typeof envelope.payload !== 'string') throw new Error('Expected a signed release envelope')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (seen.has(sha256)) throw new Error('Duplicate release envelope')
  seen.add(sha256)
  const url = pathFromIndex.split(sep).map(encodeURIComponent).join('/')
  if (url.length > 2048) throw new Error('Release URL is too long')
  return { url, sha256 }
})
const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, releases }, null, 2) + '\n')
if (bytes.length > 64 * 1024) throw new Error('Catalog exceeds 64 KiB')
writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 })
console.log(`Wrote catalog with ${releases.length} signed release references; clients still verify publisher signatures`)
