import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:https'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { ReportClient } from '../apps/core/dist/report-client.js'
import { reportWheelFixture } from './fixtures/report-wheels.mjs'

test('a signed report downloads a wheel above 32 MiB over verified TLS and rebuilds offline from asset cache', { timeout: 240000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-external-report-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = new ReportClient().runtimeConfiguration(), source = join(root, 'source')
  await cp(config.pluginRoot, source, { recursive: true })
  const lock = JSON.parse(execFileSync(config.python, ['-I', '-B', '-c', reportWheelFixture, join(source, 'wheels'), 'external'], { encoding: 'utf8', maxBuffer: 100000 }))
  assert.ok(lock.some(wheel => wheel.asset.sizeBytes > 32 * 1024 * 1024))
  const manifestPath = join(source, 'plugin.json'), mainPath = join(source, 'thermal_report_plugin', '__main__.py')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')), main = await readFile(mainPath, 'utf8')
  await writeFile(manifestPath, JSON.stringify({ ...manifest, hostApi: 3, version: '0.1.1', pythonRuntime: { schemaVersion: 1, wheels: lock } }))
  await writeFile(mainPath, main.replace('"0.1.0"', '"0.1.1"'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'), key = join(root, 'publisher.pem'), release = join(root, 'release.json')
  await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  execFileSync(process.execPath, ['scripts/package-plugin-release.mjs', source, 'fixture', key, release], { cwd: resolve('.'), stdio: 'pipe' })
  assert.ok((await readFile(release)).length < 1024 * 1024, 'large wheels are not base64 embedded in the signed envelope')
  const catalog = join(root, 'index.json')
  execFileSync(process.execPath, ['scripts/create-plugin-update-catalog.mjs', catalog, release], { cwd: resolve('.'), stdio: 'pipe' })
  const cert = join(root, 'tls-cert.pem'), tlsKey = join(root, 'tls-key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tlsKey, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' })
  const files = new Map([['/index.json', catalog], ['/release.json', release], ...lock.map(wheel => [`/assets/${wheel.sha256}.whl`, join(root, 'assets', `${wheel.sha256}.whl`)])])
  let downloadedAssets = 0, streamedBytes = 0
  const server = createServer({ key: await readFile(tlsKey), cert: await readFile(cert) }, (request, response) => {
    const path = files.get(request.url)
    if (!path) { response.writeHead(404); response.end(); return }
    if (request.url.startsWith('/assets/')) { downloadedAssets++; streamedBytes += statSync(path).size }
    response.writeHead(200, { 'Content-Length': String(statSync(path).size) })
    createReadStream(path).pipe(response)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const input = { home: join(root, 'host'), report: config, release,
    source: { id: 'fixture', url: `https://127.0.0.1:${server.address().port}/index.json` },
    publisher: { id: 'fixture', pluginIds: ['report-reportlab'], publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() } }
  const inputPath = join(root, 'input.json'); await writeFile(inputPath, JSON.stringify(input))
  const moduleUrl = new URL('../apps/core/dist/plugin-host.js', import.meta.url).href
  const script = `import assert from 'node:assert/strict'; import { readFile, readdir, rm } from 'node:fs/promises'; import { dirname, join } from 'node:path';
import { PluginHost } from ${JSON.stringify(moduleUrl)};
const input=JSON.parse(await readFile(process.argv[1],'utf8'));
const options={report:input.report,publishers:()=>[input.publisher],updateSources:()=>[input.source]};
let host=new PluginHost(input.home,options);
const render=async(name)=>{const result=await host.report.renderTaskReport({outputPath:join(input.home,name),generatedAt:'2026-10-19T00:00:00Z',task:{id:'EXTERNAL-ASSET',title:'外部依赖资产',executionStatus:'COMPLETED',approvalStatus:'APPROVED',thermalVerdict:'FAIL'},runs:[],events:[]});assert.equal((await readFile(result.outputPath)).subarray(0,4).toString(),'%PDF');return result;};
try {
 const release=host.installRelease(await readFile(input.release));
 await host.reconcile();
 let status=host.status();
 assert.equal(status.active['report-reportlab'].current,release.digest,JSON.stringify(status.runtimes));
 assert.equal(status.updates.assetDownloaded,4);
 assert.ok(status.updates.assetBytes>32*1024*1024);
 const oldPython=status.runtimes.find(r=>r.id==='report-reportlab').pythonExecutable;
 assert.equal((await render('online.pdf')).pluginRuntime.packageDigest,release.digest);
 assert.deepEqual((await readdir(join(input.home,'python-environments'))).filter(n=>n.endsWith('.failure.json')),[],'waiting for assets must not impose a failed-install cooldown');
 await host.close();
 await rm(dirname(dirname(oldPython)),{recursive:true,force:true});
 host=new PluginHost(input.home,{...options,fetchUpdates:async()=>{throw new TypeError('offline fixture')}});
 await host.reconcile();status=host.status();
 assert.equal(status.active['report-reportlab'].current,release.digest);
 assert.notEqual(status.runtimes.find(r=>r.id==='report-reportlab').pythonExecutable,oldPython);
 assert.equal((await render('offline.pdf')).pluginRuntime.packageDigest,release.digest);
 assert.equal(status.validations.filter(v=>v.packageDigest===release.digest&&v.passed).length,2);
 await host.rollback('report-reportlab');
 assert.notEqual(host.status().active['report-reportlab'].current,release.digest);
 console.log(JSON.stringify({upgraded:true,offlineRebuilt:true,rollback:true}));
} finally {await host.close();}`
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, inputPath], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 220000, maxBuffer: 2 * 1024 * 1024,
  })
  assert.deepEqual(JSON.parse(stdout.trim()), { upgraded: true, offlineRebuilt: true, rollback: true })
  assert.equal(downloadedAssets, 4)
  assert.ok(streamedBytes > 32 * 1024 * 1024)
  assert.deepEqual((await readdir(join(root, 'host', 'wheel-assets'))).filter(name => name.endsWith('.partial')), [])
})
