import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
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
    async solveProject(input) {
      const bytes = await readFile(input.projectPath), power = Number(bytes.toString().split('=')[1])
      const dir = join(input.outputDir, 'artifacts'); await mkdir(dir, { recursive: true })
      const projectPath = join(dir, 'project.aedt'), convergencePath = join(dir, 'convergence.json')
      await writeFile(projectPath, bytes)
      await writeFile(convergencePath, JSON.stringify({ schemaVersion: 'icepak-convergence-v1', setup: input.setup, evidence: { verified: true }, nativeEvidencePaths: {}, rawFileSha256: {} }))
      return { status: 'ok', mode: 'solve', inputSha256: sha(bytes), project: { aedtVersion: '2024.2', activeDesign: 'Icepak' }, validation: { verified: true },
        solve: { succeeded: true, setup: input.setup }, metrics: { solverNormalCompletion: true, converged: true, tmaxC: 40 + power }, artifacts: { projectPath, outputSha256: sha(bytes), convergencePath } }
    },
    async executeScript(input) {
      const path = join(input.outputDir, 'verified', 'project.aedt'), data = Buffer.from(`power=${input.parameters.power}`)
      await mkdir(join(input.outputDir, 'verified'), { recursive: true }); await writeFile(path, data)
      return { schemaVersion: 1, status: 'ok', inputSha256: input.projectSha256, scriptSha256: input.scriptSha256, parameters: input.parameters,
        scriptExecuted: true, persistedReadback: true, readbackEvidenceSource: 'script-reported-after-reopen',
        readback: { passed: true, checks: [{ actual: input.parameters.power }] }, executionKind: 'test-double', verifiedProjectPath: path, verifiedProjectSha256: sha(data) }
    } }
  let app = createCoreApp({ home, pluginClient: port, startAgentRuntime: false, startRemoteSolve: false })
  original = await app.artifacts.putBytes(Buffer.from('original'), 'project.aedt'); app.database.upsertArtifact(original)
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  let base = `http://127.0.0.1:${app.server.address().port}`
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }) })
  const task = (snapshot = {}, ownerNodeId = app.nodeIdentity.nodeId) => app.database.createTask(createTask({ title: 'Dynamic test', description: 'Dynamic test fixture', ownerNodeId,
    requirementSnapshot: { modelSha256: original.sha256, aedtVersion: '2024.2', planConfirmed: true, ...snapshot } }))
  const request = async (path, body, headers = {}) => {
    const response = await fetch(base + path, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'Content-Type': 'application/json', ...headers } })
    return { status: response.status, data: await response.json() }
  }
  return { home, get app() { return app }, original, task, request, port,
    async restart() {
      await app.close()
      app = createCoreApp({ home, pluginClient: port, startAgentRuntime: false, startRemoteSolve: false })
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
      base = `http://127.0.0.1:${app.server.address().port}`
    } }

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

test('iteration draft cannot be started through DSH; App approval binds the task version and budget', async t => {
  const f = await fixture(t), task = f.task()
  const staged = await f.request('/api/dynamic-scripts', definition)
  const plan = { scriptId: staged.data.script.id, parameters: { power: 20 }, adjustable: [{ name: 'power', minimum: 0, maximum: 40, step: 10, minimumStep: 1 }],
    targetTmaxC: 45, setup: 'Setup1', maxRounds: 5, maxDurationMs: 10_000 }
  const created = await f.request(`/api/tasks/${task.id}/script-iterations`, plan)
  assert.equal(created.status, 201); assert.equal(created.data.iteration.status, 'DRAFT')
  const id = created.data.iteration.id
  const bridge = new ThermalToolsBridge(f.home, f.app.database, f.port, f.app.nodeIdentity.nodeId, undefined, f.app.dynamicScripts)
  const address = await bridge.start(); t.after(() => bridge.stop())
  const denied = await fetch(`${address.url}/v1/tasks/${task.id}/script-iterations/${id}/start`, { method: 'POST', headers: { Authorization: `Bearer ${address.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedTaskVersion: task.version }) })
  assert.equal(denied.status, 409)
  assert.equal(f.app.dynamicScripts.library.iteration(id).status, 'DRAFT')
  assert.equal((await f.request(`/api/tasks/${task.id}/script-iterations/${id}/start`, { expectedTaskVersion: task.version + 1 })).status, 409)
  const started = await f.request(`/api/tasks/${task.id}/script-iterations/${id}/start`, { expectedTaskVersion: task.version })
  assert.equal(started.status, 202)
  const done = await f.app.dynamicScripts.iterations.wait(id)
  assert.equal(done.stopReason, 'TARGET_REACHED')
  assert.deepEqual(done.rounds.map(round => round.parameters.power), [20, 30, 10, 0])
  assert.equal(done.approvedTaskVersion, task.version)
  assert.ok(f.app.database.getArtifact(done.rounds.at(-1).resultSha256))
})

test('evidence export hashes real artifacts and never upgrades test-double receipts to acceptance', async t => {
  const f = await fixture(t), task = f.task()
  const staged = await f.request('/api/dynamic-scripts', definition)
  const started = await f.request(`/api/tasks/${task.id}/script-runs`, { scriptId: staged.data.script.id, parameters: { power: 18 } })
  const done = await f.app.dynamicScripts.manager.wait(started.data.run.id)
  assert.equal(done.status, 'SUCCEEDED')
  const exported = await f.request(`/api/tasks/${task.id}/script-evidence`)
  assert.equal(exported.status, 200)
  assert.equal(exported.data.status, 'collected')
  assert.equal(exported.data.acceptance, 'manual-review-required')
  assert.equal(exported.data.observations.nativeReadbacks, 0)
  assert.equal(exported.data.observations.testDoubleReadbacks, 1)
  assert.ok(exported.data.runs[0].coreInstanceId)
  assert.ok(exported.data.artifactChecks.every(check => check.verified))
  assert.equal(exported.data.scripts[0].submissions[0].channel, 'app')
  await writeFile(f.app.artifacts.resolveArtifact(done.evidence.projectSha256), 'tampered')
  const damaged = await f.request(`/api/tasks/${task.id}/script-evidence`)
  assert.equal(damaged.data.status, 'artifact-errors')
  assert.ok(damaged.data.artifactChecks.some(check => !check.verified && /mismatch/.test(check.error)))
  assert.equal((await f.request(`/api/tasks/${f.task({}, 'foreign-node').id}/script-evidence`)).status, 409)
})

test('Core restart reuses the saved script with different parameters without restaging code', async t => {
  const f = await fixture(t), task = f.task()
  const staged = await f.request('/api/dynamic-scripts', definition), scriptId = staged.data.script.id
  const first = await f.request(`/api/tasks/${task.id}/script-runs`, { scriptId, parameters: { power: 15 } })
  const original = await f.app.dynamicScripts.manager.wait(first.data.run.id)
  assert.equal(original.status, 'SUCCEEDED')
  await f.restart()
  const scripts = (await f.request('/api/dynamic-scripts')).data.scripts
  assert.equal(scripts.length, 1); assert.equal(scripts[0].id, scriptId)
  assert.equal(scripts[0].source, definition.source)
  assert.equal(scripts[0].validation.state, 'unverified')
  const second = await f.request(`/api/tasks/${task.id}/script-runs`, { scriptId, parameters: { power: 35 } })
  const reused = await f.app.dynamicScripts.manager.wait(second.data.run.id)
  assert.equal(reused.status, 'SUCCEEDED')
  assert.notEqual(reused.coreInstanceId, original.coreInstanceId)
  const report = (await f.request(`/api/tasks/${task.id}/script-evidence`)).data
  assert.deepEqual(report.runs.map(run => run.parameters.power), [15, 35])
  assert.equal(report.observations.nativeReadbacks, 0)
})


test('App harness reports live availability and task evidence without executing or granting actions', async t => {
  const f = await fixture(t), task = f.task({ planConfirmed: false })
  let snapshot = { automaticUpdates: false, automaticRepairApply: false, active: {}, runtimes: [], repairApplications: [] }
  const host = { status: () => snapshot }
  const bridge = new ThermalToolsBridge(f.home, f.app.database, f.port, f.app.nodeIdentity.nodeId, host, f.app.dynamicScripts)
  const address = await bridge.start(); t.after(() => bridge.stop())
  assert.equal((await fetch(`${address.url}/v1/harness`)).status, 401)
  const get = path => fetch(`${address.url}${path}`, { headers: { Authorization: `Bearer ${address.token}` } })
  const result = await (await get(`/v1/harness?taskId=${task.id}`)).json()
  assert.equal(result.guide.schemaVersion, 1)
  assert.deepEqual(result.availability, { dynamicScripts: true, managedPlugins: true })
  assert.equal(result.task.planConfirmed, false)
  assert.equal(result.task.source.sha256, f.original.sha256)
  assert.equal(result.runtime.automaticRepairApply, false)
  assert.deepEqual(f.app.dynamicScripts.library.runs(task.id), [])
  snapshot = { ...snapshot, automaticRepairApply: true, active: { 'icepak-pyaedt': { current: 'a'.repeat(64) } } }
  const refreshed = await (await get('/v1/harness')).json()
  assert.equal(refreshed.runtime.automaticRepairApply, true)
  assert.equal(refreshed.runtime.active['icepak-pyaedt'].current, 'a'.repeat(64))
  assert.equal(refreshed.task, null)
  const foreign = f.task({}, 'another-node')
  assert.equal((await get(`/v1/harness?taskId=${foreign.id}`)).status, 409)
})
