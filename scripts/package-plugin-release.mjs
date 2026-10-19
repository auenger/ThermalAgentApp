import { createReadStream, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto'
import { parseManagedPluginManifest } from '../packages/contracts/dist/index.js'
import { verifyPluginRelease } from '../apps/core/dist/plugin-release.js'

// Run after pnpm build:ts. Signing keys belong to the release system, not client installations.
const [sourceArg, publisherId, keyArg, outputArg] = process.argv.slice(2)
if (!sourceArg || !publisherId || !keyArg || !outputArg || process.argv.length !== 6) {
  throw new Error('Usage: node scripts/package-plugin-release.mjs <python-source-dir> <publisher-id> <private-key.pem> <output.json>')
}
const source = resolve(sourceArg)
const manifest = parseManagedPluginManifest(JSON.parse(readFileSync(join(source, 'plugin.json'), 'utf8')))
const files = { 'plugin.json': Buffer.from(JSON.stringify(manifest)).toString('base64') }
const external = new Map((manifest.pythonRuntime?.wheels ?? []).filter(wheel => wheel.asset).map(wheel => [`${manifest.entry.root}/${wheel.path}`, wheel]))
const found = new Set()
let bytes = 0, count = 1
async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function walk(directory, prefix) {
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Source must use regular directories')
  for (const name of readdirSync(directory).sort()) {
    if (['__pycache__', 'plugin.json', '.DS_Store'].includes(name) || /\.py[co]$/u.test(name)) continue
    const path = join(directory, name), relative = `${prefix}/${name}`, stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error('Plugin sources must not contain symlinks')
    if (stat.isDirectory()) { await walk(path, relative); continue }
    const wheel = external.get(relative)
    if (wheel) {
      if (!stat.isFile() || stat.size !== wheel.asset.sizeBytes || await hashFile(path) !== wheel.sha256) throw new Error('External wheel differs from its signed lock')
      const assets = join(dirname(resolve(outputArg)), 'assets'), temporary = join(assets, `${randomUUID()}.tmp`)
      await mkdir(assets, { recursive: true })
      try {
        await copyFile(path, temporary)
        if (await hashFile(temporary) !== wheel.sha256) throw new Error('External wheel changed during packaging')
        await rename(temporary, join(assets, `${wheel.sha256}.whl`))
      } finally { await rm(temporary, { force: true }) }
      found.add(relative)
      continue
    }
    if (!stat.isFile() || ++count > 2000 || (bytes += stat.size) > 32 * 1024 * 1024) throw new Error('Invalid or oversized plugin source')
    files[relative] = readFileSync(path).toString('base64')
  }
}
await walk(source, manifest.entry.root)
if (found.size !== external.size) throw new Error('A declared external wheel is missing from the source')
const key = createPrivateKey(readFileSync(resolve(keyArg)))
if (key.asymmetricKeyType !== 'ed25519') throw new Error('Signing requires an Ed25519 private key')
const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, publishedAt: new Date().toISOString(), files }))
const output = Buffer.from(JSON.stringify({ schemaVersion: 1, publisherId, payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }))
verifyPluginRelease(output, [{ id: publisherId, pluginIds: [manifest.id], publicKey: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString() }])
writeFileSync(resolve(outputArg), output, { flag: 'wx', mode: 0o600 })
console.log(`Signed ${manifest.id}@${manifest.version} (${output.length} envelope bytes; ${found.size} external wheel assets)`)
