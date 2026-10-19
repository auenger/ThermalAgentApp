import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, utimes, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginWheelAssets } from '../apps/core/dist/plugin-wheel-assets.js'
import { PluginReleaseInbox } from '../apps/core/dist/plugin-release.js'
import { PluginUpdateFeed } from '../apps/core/dist/plugin-update-feed.js'
import { PluginStore } from '../apps/core/dist/plugin-store.js'
import { parseManagedPluginManifest } from '../packages/contracts/dist/index.js'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const descriptor = bytes => ({ name: 'asset-fixture', version: '1.0', path: 'wheels/asset_fixture-1.0-py3-none-any.whl', sha256: sha(bytes), asset: { sizeBytes: bytes.length } })
const source = { id: 'test', url: 'https://updates.example.test/index.json' }
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'thermal-wheel-assets-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return { home, cache: new PluginWheelAssets(join(home, 'cache')) }
}

test('asset streaming enforces signed bytes, exact sizes, cache integrity and cancellation', async t => {
  const { home, cache } = await fixture(t), bytes = Buffer.alloc(2 * 1024 * 1024, 71), wheel = descriptor(bytes)
  let transferred = 0
  await cache.download(wheel, 'https://updates.example.test/asset.whl', async (_url, options) => {
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit')
    let offset = 0
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === bytes.length) { controller.close(); return }
      controller.enqueue(bytes.subarray(offset, offset += 16384))
    } }), { headers: { 'Content-Length': String(bytes.length) } })
  }, new AbortController().signal, size => { transferred += size })
  assert.equal(transferred, bytes.length); assert.equal(await cache.has(wheel), true)
  const installed = await cache.materialize(wheel, join(home, 'wheel-inputs'))
  assert.equal(sha(await readFile(installed)), wheel.sha256)
  await writeFile(join(home, 'cache', `${wheel.sha256}.whl`), Buffer.alloc(bytes.length, 72))
  assert.equal(await cache.has(wheel), false)
  await assert.rejects(cache.materialize(wheel, join(home, 'bad')), error => error.code === 'RUNTIME_ASSET_UNAVAILABLE')
  for (const response of [new Response(bytes.subarray(1)), new Response(Buffer.alloc(bytes.length, 72)),
    new Response(bytes, { headers: { 'Content-Length': '1' } }), new Response(bytes, { headers: { 'Content-Encoding': 'gzip' } })]) {
    await assert.rejects(cache.download(wheel, source.url, async () => response, new AbortController().signal), /Wheel asset/)
  }
  const controller = new AbortController()
  let announce, cancelled = false
  const entered = new Promise(resolve => { announce = resolve })
  const pending = cache.download(wheel, source.url, async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(bytes.subarray(0, 1024)); announce() }, cancel() { cancelled = true },
  })), controller.signal)
  const rejected = assert.rejects(pending)
  await entered
  assert.equal((await cache.collect({ keep: new Set(), allowed: () => true, now: Date.now() + 8 * 86400000 })).deferred, true)
  controller.abort(); await rejected
  assert.equal(cancelled, true)
  assert.equal((await readdir(join(home, 'cache'))).some(name => name.endsWith('.partial')), false)
})

test('signed asset feeds verify before download, restore missing cache and respect platform and publisher scope', async t => {
  const { home } = await fixture(t), bytes = Buffer.from('streamed asset fixture'), wheel = descriptor(bytes)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  let publishers = [{ id: 'test', pluginIds: ['report-reportlab'], publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }]
  const manifest = { schemaVersion: 1, hostApi: 3, id: 'report-reportlab', version: '1.0.0', kind: 'report', entry: { root: 'python', module: 'adapter' },
    capabilities: ['health'], permissions: [], compatibility: { platforms: [process.platform], architectures: [process.arch], versions: {} }, pythonRuntime: { schemaVersion: 1, wheels: [wheel] } }
  assert.throws(() => parseManagedPluginManifest({ ...manifest, hostApi: 2 }), /host API 3/)
  assert.throws(() => parseManagedPluginManifest({ ...manifest, pythonRuntime: { schemaVersion: 1, wheels: [{ ...wheel, asset: { sizeBytes: 256 * 1024 * 1024 + 1 } }] } }), /asset size/)
  assert.throws(() => parseManagedPluginManifest({ ...manifest, pythonRuntime: { schemaVersion: 1, wheels: [{ ...wheel, path: 'wheels/NUL.whl' }] } }), /locked Python wheel/)
  assert.throws(() => parseManagedPluginManifest({ ...manifest, pythonRuntime: { schemaVersion: 1, wheels: Array.from({ length: 5 }, (_, i) => ({ ...wheel,
    name: `fixture-${i}`, path: `wheels/fixture_${i}-1.0-py3-none-any.whl`, asset: { sizeBytes: 256 * 1024 * 1024 } })) } }), /closure exceeds/)
  const envelope = value => {
    const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, publishedAt: '2026-10-19T00:00:00Z', files: {
      'plugin.json': Buffer.from(JSON.stringify(value)).toString('base64'), 'python/adapter.py': Buffer.from('raise RuntimeError("do not execute while downloading")').toString('base64') } }))
    return Buffer.from(JSON.stringify({ schemaVersion: 1, publisherId: 'test', payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }))
  }
  let release = envelope(manifest), assetRequests = 0, corrupt = false
  const store = new PluginStore(join(home, 'registry')), inbox = new PluginReleaseInbox(home, store, () => publishers)
  const fetcher = async url => {
    if (url.endsWith('index.json')) return Response.json({ schemaVersion: 1, releases: [{ url: 'releases/version.json', sha256: sha(release) }] })
    if (url.endsWith('version.json')) return new Response(release)
    assert.equal(url, `https://updates.example.test/releases/assets/${wheel.sha256}.whl`)
    assetRequests++
    return new Response(corrupt ? Buffer.from('wrong') : bytes)
  }
  let feed = new PluginUpdateFeed(inbox, () => [source], fetcher)
  inbox.accept(release) // Offline envelope can be staged; subsequent source discovery supplies its missing assets.
  assert.equal((await feed.poll(true)).assetDownloaded, 1)
  assert.equal(assetRequests, 1); assert.equal(store.list().revisions.length, 1); assert.deepEqual(store.list().active, {})
  const reused = await feed.poll(true)
  assert.equal(reused.cached, 1); assert.equal(reused.assetCached, 1); assert.equal(assetRequests, 1)
  await rm(join(home, 'wheel-assets', `${wheel.sha256}.whl`))
  let needed = false
  const selective = new PluginUpdateFeed(inbox, () => [source], fetcher, 15000, 300000, () => needed)
  assert.equal((await selective.poll(true)).assetDownloaded, 0)
  assert.equal(assetRequests, 1, 'obsolete cached release must not refill evicted assets')
  needed = true
  assert.equal((await selective.poll(true)).assetDownloaded, 1)
  await selective.close()
  await rm(join(home, 'wheel-assets', `${wheel.sha256}.whl`))
  corrupt = true
  const invalid = await feed.poll(true)
  assert.equal(invalid.downloaded, 0); assert.equal(invalid.phase, 'error')
  const requests = assetRequests
  await feed.poll(true); assert.equal(assetRequests, requests, 'bad assets use the release retry window')
  await feed.close(); corrupt = false
  feed = new PluginUpdateFeed(inbox, () => [source], fetcher)
  assert.equal((await feed.poll(true)).assetDownloaded, 1)
  await feed.close()
  await rm(join(home, 'wheel-assets', `${wheel.sha256}.whl`))
  publishers = []
  feed = new PluginUpdateFeed(inbox, () => [source], fetcher)
  assert.equal((await feed.poll(true)).phase, 'error'); assert.equal(assetRequests, requests + 1, 'revoked publishers cannot trigger asset requests')
  await feed.close()
  publishers = [{ id: 'test', pluginIds: ['report-reportlab'], publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }]
  release = envelope({ ...manifest, version: '1.0.1', compatibility: { ...manifest.compatibility, platforms: ['unsupported-fixture'] } })
  feed = new PluginUpdateFeed(inbox, () => [source], fetcher)
  assert.equal((await feed.poll(true)).downloaded, 1); assert.equal(assetRequests, requests + 1)
  await feed.close()
  release = envelope({ ...manifest, version: '1.0.2' })
  const forged = JSON.parse(release.toString()); forged.signature = Buffer.alloc(64).toString('base64')
  release = Buffer.from(JSON.stringify(forged))
  feed = new PluginUpdateFeed(inbox, () => [source], fetcher)
  assert.equal((await feed.poll(true)).phase, 'error'); assert.equal(assetRequests, requests + 1)
  await feed.close()
  release = envelope({ ...manifest, version: '1.0.2' })
  let announce, stall = true, cancelled = false
  const entered = new Promise(resolve => { announce = resolve })
  feed = new PluginUpdateFeed(inbox, () => [source], async (url, options) => {
    if (url.includes('/assets/') && stall) return new Response(new ReadableStream({
      start(stream) { stream.enqueue(bytes.subarray(0, 2)); announce() }, cancel() { cancelled = true },
    }))
    return fetcher(url, options)
  })
  const pending = feed.poll(true)
  await entered; feed.cancel()
  assert.equal((await pending).phase, 'cancelled'); assert.equal(cancelled, true)
  assert.equal(store.list().revisions.some(item => item.manifest.version === '1.0.2'), false)
  stall = false
  assert.equal((await feed.poll(true)).downloaded, 1, 'cancelled asset acquisition can resume without failure cooldown')
  await feed.close()
})


test('asset collection preserves referenced blobs and fresh offline copies, and ages partial files separately', async t => {
  const { home, cache } = await fixture(t), directory = join(home, 'cache')
  await mkdir(directory)
  const kept = descriptor(Buffer.from('required')), unused = descriptor(Buffer.from('obsolete'))
  for (const wheel of [kept, unused]) await writeFile(join(directory, `${wheel.sha256}.whl`), Buffer.alloc(wheel.asset.sizeBytes))
  const old = new Date(Date.now() - 30 * 86400000)
  await utimes(join(directory, `${unused.sha256}.whl`), old, old)
  const partial = '00000000-0000-0000-0000-000000000001.partial'
  await writeFile(join(directory, partial), 'part')
  await writeFile(join(directory, 'administrator-note'), 'keep')
  if (process.platform !== 'win32') await symlink(join(directory, `${kept.sha256}.whl`), join(directory, `${'f'.repeat(64)}.whl`))
  const keep = new Set([kept.sha256])
  assert.equal((await cache.collect({ keep, allowed: () => true })).removed, 0, 'old mtime alone cannot age a fresh copy')
  const day2 = await cache.collect({ keep, allowed: () => true, now: Date.now() + 2 * 86400000 })
  assert.equal(day2.removed, 1); assert.equal(day2.removedBytes, 4)
  const day8 = await cache.collect({ keep, allowed: () => true, now: Date.now() + 8 * 86400000 })
  assert.equal(day8.removed, 1); assert.equal(day8.removedBytes, unused.asset.sizeBytes)
  assert.equal(day8.retained['required by retained version'], 1)
  assert.equal(day8.retained['unknown entry'], process.platform === 'win32' ? 1 : 2)
  assert.ok((await readdir(directory)).includes(`${kept.sha256}.whl`))
})

test('asset collection is bounded and stops when update policy is disabled', async t => {
  const { home, cache } = await fixture(t), directory = join(home, 'cache')
  await mkdir(directory)
  for (let i = 0; i < 66; i++) await writeFile(join(directory, `${sha(String(i))}.whl`), 'x')
  const input = { keep: new Set(), now: Date.now() + 8 * 86400000 }
  assert.equal((await cache.collect({ ...input, allowed: () => false })).removed, 0)
  const first = await cache.collect({ ...input, allowed: () => true })
  assert.equal(first.removed, 64); assert.equal(first.retained['collection batch limit'], 2)
  assert.equal((await cache.collect({ ...input, allowed: () => true })).removed, 2)
  assert.deepEqual(await readdir(directory), [])
})
