import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { IcepakPluginClient } from '../apps/core/dist/icepak-plugin-client.js'
import { ReportClient } from '../apps/core/dist/report-client.js'
import { PluginProtocolError, PluginResponseError } from '../apps/core/dist/python-plugin-launch.js'

for (const kind of ['icepak', 'report']) test(`${kind} classifies host-detected protocol damage without quarantining business errors or timeouts`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-protocol-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'adapter'))
  await writeFile(join(root, 'adapter', '__main__.py'), `import sys,json,time
r=json.loads(sys.stdin.readline())
mode=r['params'].get('mode') or r['params'].get('task',{}).get('mode')
if mode=='empty': sys.exit(1)
if mode=='timeout': time.sleep(2)
if mode=='json': print('broken'); sys.exit(0)
v={'id':r['id'],'ok':True,'result':{'status':'failed'}}
if mode=='null': v=None
if mode=='array': v=[]
if mode=='id': v['id']='wrong'
if mode=='status': v['ok']='yes'
if mode=='result': del v['result']
if mode=='error': v={'id':r['id'],'ok':False,'error':{}}
if mode=='business': v={'id':r['id'],'ok':False,'error':{'code':'PLUGIN_PROTOCOL_ERROR','message':'business rejection'}}
print(json.dumps(v))
`)
  let failures = 0, released = 0
  const reported = []
  const makeClient = timeoutMs => new (kind === 'icepak' ? IcepakPluginClient : ReportClient)({ timeoutMs,
    acquireRuntime: () => ({ python: process.platform === 'win32' ? 'python' : 'python3', pluginRoot: root, module: 'adapter',
      protocolFailure(method, error) { assert.ok(error instanceof PluginProtocolError); failures++ },
      responseFailure(method, error) { assert.ok(error instanceof PluginResponseError); reported.push({ method, code: error.code, detail: error.detail }) },
      release() { released++ } }) })
  const client = makeClient(5000)
  const call = (mode, target = client) => kind === 'icepak' ? target.call('health', { mode }) : target.renderTaskReport({ task: { mode } })
  for (const mode of ['empty', 'json', 'null', 'array', 'id', 'status', 'result', 'error']) {
    const before = failures
    await assert.rejects(call(mode), PluginProtocolError)
    assert.equal(failures, before + 1)
  }
  await assert.rejects(call('business'), /business rejection/)
  await assert.rejects(call('timeout', makeClient(150)), /timed out/)
  assert.equal((await call('valid')).status, 'failed', 'business result failure does not damage the RPC envelope')
  if (kind === 'icepak') {
    const controller = new AbortController(); controller.abort()
    await assert.rejects(client.call('health', {}, { signal: controller.signal }), /cancelled/)
  }
  assert.equal(failures, 8)
  assert.deepEqual(reported, [{ method: kind === 'icepak' ? 'health' : 'render_task_report', code: 'PLUGIN_PROTOCOL_ERROR', detail: 'business rejection' }], 'only valid error responses reach business diagnostics; timeout, cancellation and malformed messages do not')
  assert.equal(released, kind === 'icepak' ? 12 : 11)
})
