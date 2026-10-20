import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCoreApp, ThermalToolsBridge } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const definition = { name: 'Heat adjustment', version: '1', description: 'Test dynamic operation', source: 'def apply(ipk, parameters): pass',
  parameters: { power: { type: 'number', description: 'Power', required: true, minimum: 0, maximum: 100 } },
  applicability: { aedtVersions: ['2024.2'], requiredObjects: ['Chip'] }, tags: ['heat'] }
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'thermal-script-api-'))
  let original
  const port = { async probeEnvironment() { return { pluginId: 'test', pluginVersion: '1' } },
    async inspectProject(input) { return { status: 'ok', inputSha256: original.sha256, project: { aedtVersion: input.version, objects: ['Chip'] } } },
    async executeScript(input) {
      const path = join(input.outputDir, 'verified', 'project.aedt'), data = Buffer.from(`power=${input.parameters.power}`)
      await mkdir(join(input.outputDir, 'verified'), { recursive: true }); await writeFile(path, data)
      return { schemaVersion: 1, status: 'ok', inputSha256: input.projectSha256, scriptSha256: input.scriptSha256, parameters: input.parameters,
        scriptExecuted: true, persistedReadback: true, readbackEvidenceSource: 'script-reported-after-reopen',
        readback: { passed: true, checks: [{ actual: input.parameters.power }] }, executionKind: 'test-double', verifiedProjectPath: path, verifiedProjectSha256: sha(data) }
    } }
  const app = createCoreApp({ home, pluginClient: port, startAgentRuntime: false, startRemoteSolve: false })
  original = await app.artifacts.putBytes(Buffer.from('original'), 'project.aedt'); app.database.upsertArtifact(original)
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${app.server.address().port}`
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }) })
  const task = (snapshot = {}, ownerNodeId = app.nodeIdentity.nodeId) => app.database.createTask(createTask({ title: 'Dynamic test', description: 'Dynamic test fixture', ownerNodeId,
    requirementSnapshot: { modelSha256: original.sha256, aedtVersion: '2024.2', planConfirmed: true, ...snapshot } }))
  const request = async (path, body, headers = {}) => {
    const response = await fetch(base + path, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'Content-Type': 'application/json', ...headers } })
    return { status: response.status, data: await response.json() }
  }
  return { home, app, original, task, request, port }
}
test('HTTP stages a script and executes through task ownership with durable registered artifacts', async t => {
  const f = await fixture(t), task = f.task()
  const staged = await f.request('/api/dynamic-scripts', definition)
  assert.equal(staged.status, 201)
  const scriptId = staged.data.script.id
  const context = await f.request(`/api/tasks/${task.id}/script-context`)
  assert.equal(context.data.source.sha256, f.original.sha256)
  assert.ok(context.data.source.projectPath.endsWith('.aedt'))
  const started = await f.request(`/api/tasks/${task.id}/script-runs`, { scriptId, parameters: { power: 23 } })
  assert.equal(started.status, 202)
  const done = await f.app.dynamicScripts.manager.wait(started.data.run.id)
  assert.equal(done.status, 'SUCCEEDED')
  assert.equal(f.app.database.getArtifact(done.evidence.projectSha256).originalName, 'project.aedt')
  assert.equal(f.app.database.getArtifact(done.evidence.artifactSha256).mediaType, 'application/json')
  assert.equal((await f.request(`/api/tasks/${task.id}/script-runs`)).data.runs[0].status, 'SUCCEEDED')
})
test('HTTP rejects foreign origins, unconfirmed plans, foreign tasks and unrelated input artifacts', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/api/dynamic-scripts', definition, { Origin: 'https://untrusted.example' })).status, 403)
  const { data } = await f.request('/api/dynamic-scripts', definition)
  const body = { scriptId: data.script.id, parameters: { power: 10 } }
  assert.equal((await f.request(`/api/tasks/${f.task({ planConfirmed: false }).id}/script-runs`, body)).status, 409)
  assert.equal((await f.request(`/api/tasks/${f.task({}, 'another-node').id}/script-runs`, body)).status, 409)
  assert.equal((await f.request(`/api/tasks/${f.task().id}/script-runs`, { ...body, projectSha256: 'a'.repeat(64) })).status, 409)
  assert.equal((await f.request(`/api/tasks/${f.task().id}/script-runs`, { ...body, projectPath: 'C:/outside.aedt' })).status, 409)
})
test('authenticated DSH bridge uses the same dynamic service and cannot supply execution receipts', async t => {
  const f = await fixture(t), task = f.task()
  const bridge = new ThermalToolsBridge(f.home, f.app.database, f.port, f.app.nodeIdentity.nodeId, undefined, f.app.dynamicScripts)
  const address = await bridge.start(); t.after(() => bridge.stop())
  assert.equal((await fetch(address.url + '/v1/dynamic-scripts')).status, 401)
  const call = async (path, body) => {
    const response = await fetch(address.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const staged = await call('/v1/dynamic-scripts', definition)
  assert.equal(staged.status, 201)
  assert.equal((await call(`/v1/tasks/${task.id}/script-context`)).body.source.sha256, f.original.sha256)
  const run = await call(`/v1/tasks/${task.id}/script-runs`, { scriptId: staged.body.script.id, parameters: { power: 25 } })
  assert.equal(run.status, 202)
  assert.equal((await f.app.dynamicScripts.manager.wait(run.body.run.id)).status, 'SUCCEEDED')
  assert.equal((await call(`/v1/tasks/${task.id}/script-runs`, { scriptId: staged.body.script.id, parameters: { power: 30 }, evidence: { status: 'SUCCEEDED' } })).status, 409)
})
