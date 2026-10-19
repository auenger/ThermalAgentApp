import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
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
let bytes = 0, count = 1
function walk(directory, prefix) {
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Source must use regular directories')
  for (const name of readdirSync(directory).sort()) {
    if (['__pycache__', 'plugin.json', '.DS_Store'].includes(name) || /\.py[co]$/u.test(name)) continue
    const path = join(directory, name), relative = `${prefix}/${name}`, stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error('Plugin sources must not contain symlinks')
    if (stat.isDirectory()) { walk(path, relative); continue }
    if (!stat.isFile() || ++count > 2000 || (bytes += stat.size) > 32 * 1024 * 1024) throw new Error('Invalid or oversized plugin source')
    files[relative] = readFileSync(path).toString('base64')
  }
}
walk(source, manifest.entry.root)
const key = createPrivateKey(readFileSync(resolve(keyArg)))
if (key.asymmetricKeyType !== 'ed25519') throw new Error('Signing requires an Ed25519 private key')
const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, publishedAt: new Date().toISOString(), files }))
const output = Buffer.from(JSON.stringify({ schemaVersion: 1, publisherId, payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }))
verifyPluginRelease(output, [{ id: publisherId, pluginIds: [manifest.id], publicKey: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString() }])
writeFileSync(resolve(outputArg), output, { flag: 'wx', mode: 0o600 })
console.log(`Signed ${manifest.id}@${manifest.version} (${output.length} bytes)`)
