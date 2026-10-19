import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:https'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PluginUpdateFeed, parsePluginUpdateSources } from '../apps/core/dist/plugin-update-feed.js'
import { PluginReleaseInbox } from '../apps/core/dist/plugin-release.js'
import { PluginStore } from '../apps/core/dist/plugin-store.js'

const source = { id: 'company', url: 'https://updates.example.test/plugins/index.json' }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = { schemaVersion: 1, hostApi: 1, id: 'report-reportlab', version: '2.0.0', kind: 'report', entry: { root: 'python', module: 'adapter' }, capabilities: ['health'], permissions: [], compatibility: { platforms: [process.platform], architectures: [process.arch], versions: {} } }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'thermal-feed-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publisher = { id: 'company', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), pluginIds: ['report-reportlab'] }
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, publishedAt: '2026-01-01T00:00:00Z', files: {
    'plugin.json': Buffer.from(JSON.stringify(manifest)).toString('base64'),
    'python/adapter.py': Buffer.from('raise RuntimeError("download must not execute code")').toString('base64'),
  } }))
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, publisherId: 'company', payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }))
  const store = new PluginStore(join(root, 'registry'))
  const inbox = new PluginReleaseInbox(root, store, () => [publisher])
  const catalog = { schemaVersion: 1, releases: [{ url: 'release.json', sha256: digest(bytes) }] }
  return { root, store, inbox, publisher, bytes, catalog }
}

test('network discovery verifies releases, coalesces polls and reuses reverified signed cache after restart', async t => {
  const f = await fixture(t), calls = []
  let offline = false
  const fetcher = async (url, options) => {
    calls.push(url)
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit')
    if (offline) throw new TypeError('fetch failed')
    return new Response(url.endsWith('index.json') ? JSON.stringify(f.catalog) : f.bytes)
  }
  let feed = new PluginUpdateFeed(f.inbox, () => [source], fetcher)
  const [a, b] = await Promise.all([feed.poll(true), feed.poll(true)])
  assert.equal(a.downloaded, 1); assert.deepEqual(a, b); assert.equal(calls.length, 2)
  assert.equal(f.store.list().revisions.length, 1); assert.deepEqual(f.store.list().active, {})
  await feed.close()
  feed = new PluginUpdateFeed(new PluginReleaseInbox(f.root, new PluginStore(join(f.root, 'registry')), () => [f.publisher]), () => [source], fetcher)
  assert.equal((await feed.poll(true)).cached, 1)
  assert.equal(calls.length, 3, 'restart fetches the catalog but not an already verified envelope')
  offline = true
  assert.equal((await feed.poll(true)).phase, 'error')
  assert.equal(f.inbox.scan().releases.length, 1, 'offline discovery cannot remove the existing version')
  const count = calls.length
  assert.equal((await feed.poll(false)).phase, 'disabled'); assert.equal(calls.length, count)
  await feed.close()
})

test('HTTPS source policy, same-origin release URLs and streamed limits are enforced before import', async t => {
  const f = await fixture(t)
  for (const url of ['http://updates.test/index.json', 'https://name:secret@updates.test/index.json', 'file:///tmp/package', 'https://updates.test/#fragment']) {
    assert.throws(() => parsePluginUpdateSources([{ ...source, url }]))
  }
  let requests = 0
  const escaped = new PluginUpdateFeed(f.inbox, () => [source], async () => {
    requests++; return Response.json({ ...f.catalog, releases: [{ ...f.catalog.releases[0], url: 'https://other.test/package' }] })
  })
  assert.equal((await escaped.poll(true)).phase, 'error'); assert.equal(requests, 1)
  let cancelled = false
  const oversized = new PluginUpdateFeed(f.inbox, () => [source], async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024)); controller.enqueue(new Uint8Array(1)) },
    cancel() { cancelled = true },
  }), { headers: { 'content-length': '1' } }))
  assert.match((await oversized.poll(true)).sources[0].errors[0], /size limit/)
  assert.equal(cancelled, true); assert.equal(f.store.list().revisions.length, 0)
  await escaped.close(); await oversized.close()
})

test('digest/signature failures do not install code and failed hashes back off without blocking a later good package', async t => {
  const f = await fixture(t)
  const tampered = Buffer.from(f.bytes.toString().replace('"company"', '"unknown"'))
  const entries = Array.from({ length: 10 }, (_, index) => ({ url: `bad-${index}.json`, sha256: digest(Buffer.concat([tampered, Buffer.from(' '.repeat(index))])) }))
  let catalog = { schemaVersion: 1, releases: [...entries, ...f.catalog.releases] }, downloads = 0
  const feed = new PluginUpdateFeed(f.inbox, () => [source], async url => {
    if (url.endsWith('index.json')) return Response.json(catalog)
    downloads++
    const index = /bad-(\d+)\.json/u.exec(url)?.[1]
    return new Response(index === undefined ? f.bytes : Buffer.concat([tampered, Buffer.from(' '.repeat(Number(index)))]))
  })
  assert.equal((await feed.poll(true)).downloaded, 0); assert.equal(downloads, 10)
  assert.equal(f.store.list().revisions.length, 0)
  assert.equal((await feed.poll(true)).downloaded, 1); assert.equal(downloads, 11)
  catalog = { schemaVersion: 1, releases: [{ url: 'release.json', sha256: 'a'.repeat(64) }] }
  assert.match((await feed.poll(true)).sources[0].errors[0], /digest mismatch/)
  await feed.close()
})

test('closing the feed aborts an in-flight request and prevents further network work', async t => {
  const f = await fixture(t)
  let started
  const ready = new Promise(resolve => { started = resolve })
  const feed = new PluginUpdateFeed(f.inbox, () => [source], async (_url, options) => new Promise((_resolve, reject) => {
    started(); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  }))
  const pending = feed.poll(true)
  await ready; await feed.close()
  assert.equal((await pending).phase, 'cancelled')
  assert.equal((await feed.poll(true)).phase, 'disabled')
  assert.equal(f.store.list().revisions.length, 0)
})

test('default fetch downloads over a real verified TLS connection and persists only a signed package', async t => {
  const f = await fixture(t)
  const keyPath = join(f.root, 'tls-key.pem'), certPath = join(f.root, 'tls-cert.pem'), configPath = join(f.root, 'tls.cnf')
  await writeFile(configPath, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,digitalSignature,keyEncipherment\n')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-config', configPath], { stdio: 'pipe' })
  const releasePath = join(f.root, 'release.json'), catalogPath = join(f.root, 'index.json')
  await writeFile(releasePath, f.bytes)
  execFileSync(process.execPath, ['scripts/create-plugin-update-catalog.mjs', catalogPath, releasePath], { stdio: 'pipe' })
  const publishedCatalog = await readFile(catalogPath)
  const paths = []
  const server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (request, response) => {
    paths.push(request.url)
    if (request.url === '/hang') return
    if (request.url === '/redirect') { response.writeHead(302, { Location: '/redirect-target' }); response.end(); return }
    response.setHeader('Content-Type', 'application/json')
    response.end(request.url === '/plugins/index.json' ? publishedCatalog : f.bytes)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const publisherPath = join(f.root, 'publisher.json'); await writeFile(publisherPath, JSON.stringify(f.publisher))
  const imports = ['plugin-update-feed', 'plugin-release', 'plugin-store'].map(name => pathToFileURL(resolve(`apps/core/dist/${name}.js`)).href)
  const script = `import{PluginUpdateFeed}from${JSON.stringify(imports[0])};import{PluginReleaseInbox}from${JSON.stringify(imports[1])};import{PluginStore}from${JSON.stringify(imports[2])};import{readFileSync}from'node:fs';
const publisher=JSON.parse(readFileSync(process.argv[1],'utf8'));const inbox=new PluginReleaseInbox(process.argv[2],new PluginStore(process.argv[2]+'/registry'),()=>[publisher]);
const feed=new PluginUpdateFeed(inbox,()=>[{id:'tls',url:process.argv[3]}]);const status=await feed.poll(true);await feed.close();
const timeout=new PluginUpdateFeed(inbox,()=>[{id:'timeout',url:new URL('/hang',process.argv[3]).href}],fetch,100);const timed=await timeout.poll(true);await timeout.close();
const redirect=new PluginUpdateFeed(inbox,()=>[{id:'redirect',url:new URL('/redirect',process.argv[3]).href}]);const redirected=await redirect.poll(true);await redirect.close();
console.log(JSON.stringify({status,timed,redirected}));`
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, publisherPath, f.root, `https://127.0.0.1:${server.address().port}/plugins/index.json`],
    { env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath, NODE_TLS_REJECT_UNAUTHORIZED: '1' }, timeout: 30_000 })
  const { status, timed, redirected } = JSON.parse(stdout)
  assert.equal(status.phase, 'ready', stdout); assert.equal(status.downloaded, 1)
  assert.equal(timed.phase, 'error'); assert.equal(redirected.phase, 'error')
  assert.equal(paths.includes('/redirect-target'), false, 'native fetch must not follow a redirect')
  const stored = new PluginStore(join(f.root, 'registry')).list()
  assert.equal(stored.revisions.length, 1); assert.deepEqual(stored.active, {})
})
