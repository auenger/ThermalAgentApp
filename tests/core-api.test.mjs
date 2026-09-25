import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCoreApp } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'

test('Core API creates, persists and transitions a task through one business write path', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-agent-core-'))
  const app = createCoreApp({ home, startAgentRuntime: false })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  t.after(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
  })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const workspace = await (await fetch(`${base}/api/workspace`)).json()
  assert.equal(workspace.path, join(home, 'workspace'))
  assert.equal(workspace.agentPath, workspace.path)

  const pageResponse = await fetch(base)
  assert.equal(pageResponse.status, 200)
  assert.match(await pageResponse.text(), /Thermal Agent/u)

  const createdResponse = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Project1 两轮验证',
      ownerNodeId: 'node-local',
      requirementSnapshot: { maxIterations: 2 },
    }),
  })
  assert.equal(createdResponse.status, 201)
  const created = await createdResponse.json()
  assert.equal(created.task.executionStatus, 'DRAFT')

  const transitionedResponse = await fetch(`${base}/api/tasks/${created.task.id}/transitions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'READY', expectedVersion: 1, reason: '用户已确认需求' }),
  })
  assert.equal(transitionedResponse.status, 200)
  const transitioned = await transitionedResponse.json()
  assert.equal(transitioned.task.version, 2)

  const bypassResponse = await fetch(`${base}/api/tasks/${created.task.id}/transitions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'COMPLETED', expectedVersion: 2 }),
  })
  assert.equal(bypassResponse.status, 400)

  const detailResponse = await fetch(`${base}/api/tasks/${created.task.id}`)
  const detail = await detailResponse.json()
  assert.equal(detail.task.executionStatus, 'READY')
  assert.deepEqual(detail.runs, [])
  assert.deepEqual(detail.events.map(event => event.eventType), ['task.created', 'task.status_changed'])
  const noteResponse = await fetch(`${base}/api/tasks/${created.task.id}/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: '热设计专家', content: '复核关键热点后决定下一轮方向' }),
  })
  assert.equal(noteResponse.status, 201)
  const noted = await (await fetch(`${base}/api/tasks/${created.task.id}`)).json()
  assert.equal(noted.events.at(-1).eventType, 'task.note_added')
  assert.deepEqual(noted.events.at(-1).payload, { author: '热设计专家', content: '复核关键热点后决定下一轮方向' })

  const lanStartResponse = await fetch(`${base}/api/lan/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 0 }),
  })
  assert.equal(lanStartResponse.status, 200)
  const lanStarted = await lanStartResponse.json()
  assert.equal(lanStarted.lan.enabled, true)
  assert.match(lanStarted.lan.pairingCode, /^\d{8}$/u)
  const lanStopResponse = await fetch(`${base}/api/lan/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(lanStopResponse.status, 200)
})

test('optimization Skill recommendations are preliminary and task drafts retain matched hypotheses', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-optimization-api-'))
  const app = createCoreApp({ home, startAgentRuntime: false })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }) })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const all = await (await fetch(`${base}/api/skills`)).json()
  const guides = all.skills.filter(skill => skill.kind === 'OPTIMIZATION')
  assert.equal(guides.length, 6)
  const recommendationResponse = await fetch(`${base}/api/optimization/recommendations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requirement: '芯片与鳍片根部温差大，检查导热贴和风扇风量' }),
  })
  assert.equal(recommendationResponse.status, 200)
  const { recommendations } = await recommendationResponse.json()
  assert.equal(recommendations.length, 6)
  assert.ok(recommendations.find(item => item.key === 'optimization-01-tim').suggested)
  assert.ok(recommendations.find(item => item.key === 'optimization-04-fan-selection').suggested)
  assert.ok(recommendations.every(item => item.evidenceStatus === 'UNVERIFIED'))
  const created = await (await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '导热贴优化', description: '评估芯片界面热阻', requirementSnapshot: { projectPath: 'C:\\models\\thermal.aedt' } }),
  })).json()
  assert.ok(created.task.requirementSnapshot.optimizationHypotheses.some(item => item.skillKey === 'optimization-01-tim'))
  assert.ok(created.task.requirementSnapshot.optimizationSuggestions.some(item => item.key === 'optimization-01-tim' && item.name))
  const forbiddenRun = await fetch(`${base}/api/skills/${guides[0].id}/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '不可执行', projectPath: 'C:\\models\\thermal.aedt' }),
  })
  assert.equal(forbiddenRun.status, 409)
  const forbiddenPublish = await fetch(`${base}/api/skills/${guides[0].id}/enable`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer: 'tester', expectedUpdatedAt: guides[0].updatedAt }),
  })
  assert.equal(forbiddenPublish.status, 409)
})

test('App creates and versions advisory Skills which enter subsequent recommendations', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-edit-skill-api-'))
  const app = createCoreApp({ home, startAgentRuntime: false })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }) })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const initial = (await (await fetch(`${base}/api/optimization/recommendations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requirement: '热风回流' }),
  })).json()).recommendations
  const guidance = { ...initial[0].guidance, priority: 7, mechanism: '热风回流', diagnosticBasis: '入口温度异常升高',
    measure: '隔离进出风道', expectedTemperatureDrop: '待模型验证', constraints: '客户结构需确认', keywords: ['热风回流'] }
  const input = { name: '回流隔离', description: '检查回流', guidance }
  const createdResponse = await fetch(`${base}/api/optimization/skills`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })
  assert.equal(createdResponse.status, 201)
  const created = (await createdResponse.json()).skill
  assert.equal(created.activeVersion, 1)
  const editedResponse = await fetch(`${base}/api/optimization/skills/${created.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, name: '系统回流隔离', expectedVersion: 1, changeSummary: '明确名称' }),
  })
  assert.equal(editedResponse.status, 200)
  assert.equal((await editedResponse.json()).skill.activeVersion, 2)
  const stale = await fetch(`${base}/api/optimization/skills/${created.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, expectedVersion: 1, changeSummary: '过期编辑' }),
  })
  assert.equal(stale.status, 409)
  const suggested = (await (await fetch(`${base}/api/optimization/recommendations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requirement: '处理热风回流' }),
  })).json()).recommendations.find(item => item.skillId === created.id)
  assert.equal(suggested.name, '系统回流隔离')
  assert.equal(suggested.activeVersion, 2)
  assert.equal(suggested.suggested, true)
})

test('uploaded model, confirmed intake and pre-authorized fan action form a two-round Icepak flow', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-intake-flow-'))
  let baselineCalls = 0
  let candidateCalls = 0
  async function result(input, mode, tmaxC) {
    const output = join(input.outputDir, 'artifacts')
    await mkdir(output, { recursive: true })
    const projectPath = join(output, 'Uploaded.aedt')
    await writeFile(projectPath, `${mode}-solved`)
    return { status: 'ok', mode, sourceProject: input.projectPath, workingProject: input.projectPath, inputSha256: 'unused',
      project: { name: 'Uploaded', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: [], setups: ['Setup1'], boundaries: [], nativeComponents: [], monitors: [], objects: [] },
      validation: { verified: true, checks: [] }, metrics: { tmaxC, converged: true, solverNormalCompletion: true }, artifacts: { projectPath },
      ...(mode === 'fan-solve' ? { comparison: { improved: true, rollbackRequired: false, deltaTmaxC: -12 } } : {}) }
  }
  const pluginClient = {
    async probeEnvironment() { return { status: 'DETECTED', aedtVersions: ['2024.2'], capabilities: [] } },
    async inspectProject(input) { return {
      status: 'ok', mode: 'inspect', sourceProject: input.projectPath, workingProject: input.projectPath, inputSha256: 'unused',
      project: { name: 'Uploaded', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: [], setups: ['Setup1'], boundaries: [],
        nativeComponents: [{ name: 'Fan1', properties: { NativeComponentDefinitionProvider: { Type: 'Fan', FlowType: 'Curve', X: ['1'], Y: ['2'] } } }], monitors: [], objects: [] },
      validation: { verified: true, checks: [] },
      parameterCatalog: { schemaVersion: 1, variables: [{ name: 'FinGap', scope: 'design', expression: '2mm', units: 'mm', used: true, readOnly: false }],
        materials: [], boundaries: [], fans: [{ name: 'Fan1', flowType: 'Curve', properties: {}, actionStatus: 'DISCOVERED' }], setups: ['Setup1'], diagnostics: [] },
    } },
    async fanCheck(input) { return { status: 'ok', mode: 'fan-check', sourceProject: input.projectPath, workingProject: input.projectPath,
      inputSha256: 'unused', project: { name: 'Uploaded', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: [], setups: ['Setup1'], boundaries: [], nativeComponents: [], monitors: [], objects: [] },
      validation: { verified: true, checks: [] }, fanAction: { verified: true, fans: [{ name: 'Fan1' }] } } },
    async solveProject(input) { baselineCalls++; return result(input, 'solve', 100) },
    async fanSolve(input) { candidateCalls++; assert.equal(input.fanSpeedRatio, 1.1); return result(input, 'fan-solve', 88) },
  }
  const app = createCoreApp({ home, pluginClient, startAgentRuntime: false })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }) })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const invalidModel = await fetch(`${base}/api/models/upload`, { method: 'POST', headers: { 'X-Model-Name': encodeURIComponent('notes.txt') }, body: Buffer.from('not-an-aedt') })
  assert.equal(invalidModel.status, 400)
  const cadUpload = await fetch(`${base}/api/models/upload`, { method: 'POST', headers: { 'X-Model-Name': encodeURIComponent('housing.step') }, body: Buffer.from('cad-geometry') })
  assert.equal(cadUpload.status, 201)
  const cad = (await cadUpload.json()).model
  assert.equal(cad.modelKind, 'CAD')
  const cadCheck = await fetch(`${base}/api/models/${cad.sha256}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal((await cadCheck.json()).assessment.status, 'NEEDS_MODEL_PREPARATION')
  const cadTaskResponse = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'CAD 阶段需求', description: '仅有 CAD 几何，需建立热模型', requirementSnapshot: { intakeVersion: 2,
      modelSha256: cad.sha256, selectedOptimizationSkillIds: [], planConfirmed: false } }),
  })
  assert.equal(cadTaskResponse.status, 201)
  const cadTask = (await cadTaskResponse.json()).task
  assert.equal(cadTask.requirementSnapshot.modelKind, 'CAD')
  assert.equal(cadTask.requirementSnapshot.projectPath, undefined)
  const cadReady = await fetch(`${base}/api/tasks/${cadTask.id}/transitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'READY', expectedVersion: cadTask.version }) })
  assert.equal(cadReady.status, 409)
  const upload = await fetch(`${base}/api/models/upload`, { method: 'POST', headers: { 'X-Model-Name': encodeURIComponent('Uploaded.aedt'), 'Content-Type': 'application/octet-stream' }, body: Buffer.from('original-model') })
  assert.equal(upload.status, 201)
  const model = (await upload.json()).model
  assert.match(model.sha256, /^[a-f0-9]{64}$/u)
  const check = await fetch(`${base}/api/models/${model.sha256}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '2024.2' }) })
  assert.equal(check.status, 200)
  const assessment = (await check.json()).assessment
  assert.equal(assessment.status, 'READY_FOR_BASELINE')
  assert.deepEqual(assessment.items.find(item => item.skillKey === 'optimization-04-fan-selection').targetNames, ['Fan1'])
  assert.equal(assessment.items.find(item => item.skillKey === 'optimization-04-fan-selection').status, 'EXECUTABLE')
  assert.equal(assessment.parameterCatalog.variables[0].name, 'FinGap')
  assert.equal(assessment.parameterCatalog.fans[0].actionStatus, 'VERIFIED')
  const promotedCad = await fetch(`${base}/api/tasks/${cadTask.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: cadTask.title, description: 'CAD 几何已补成 Icepak 工程', expectedVersion: cadTask.version,
      requirementSnapshot: { intakeVersion: 2, modelSha256: model.sha256, aedtVersion: '2024.2', targetTmaxC: 90,
        selectedOptimizationSkillIds: [], planConfirmed: true } }),
  })
  assert.equal(promotedCad.status, 200)
  const promoted = (await promotedCad.json()).task
  assert.equal(promoted.requirementSnapshot.modelKind, 'AEDT')
  const promotedReady = await fetch(`${base}/api/tasks/${cadTask.id}/transitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'READY', expectedVersion: promoted.version }) })
  assert.equal(promotedReady.status, 200)
  const skills = (await (await fetch(`${base}/api/skills`)).json()).skills
  const fan = skills.find(skill => skill.key === 'optimization-04-fan-selection')
  const createdResponse = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '上传模型散热优化', description: '芯片目标温度 90 度，允许风扇调整', requirementSnapshot: {
      intakeVersion: 2, modelSha256: model.sha256, targetTmaxC: 90, aedtVersion: '2024.2', cores: 4,
      selectedOptimizationSkillIds: [fan.id], autoFanRatio: 1.1, planConfirmed: true, expertSupplement: '噪声上限需人工确认',
    } }),
  })
  assert.equal(createdResponse.status, 201)
  const task = (await createdResponse.json()).task
  assert.match(task.requirementSnapshot.projectPath, new RegExp(`workspace[/\\\\]tasks[/\\\\]${task.id}[/\\\\]inputs`))
  assert.equal(await readFile(task.requirementSnapshot.projectPath, 'utf8'), 'original-model')
  assert.notEqual(task.requirementSnapshot.projectPath, model.projectPath)
  assert.equal(task.requirementSnapshot.expertSupplement, '噪声上限需人工确认')
  const incomplete = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Agent 待上传', description: '先整理需求', requirementSnapshot: { intakeVersion: 2, selectedOptimizationSkillIds: [], planConfirmed: false } }),
  })
  assert.equal(incomplete.status, 201)
  const agentDraft = (await incomplete.json()).task
  const blocked = await fetch(`${base}/api/tasks/${agentDraft.id}/transitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'READY', expectedVersion: agentDraft.version }) })
  assert.equal(blocked.status, 409)
  const completedDraft = await fetch(`${base}/api/tasks/${agentDraft.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: agentDraft.title, description: '先整理需求，再由用户上传并确认', expectedVersion: agentDraft.version,
      requirementSnapshot: { intakeVersion: 2, modelSha256: model.sha256, aedtVersion: '2024.2', targetTmaxC: 90, selectedOptimizationSkillIds: [], planConfirmed: true } }),
  })
  assert.equal(completedDraft.status, 200)
  const patched = (await completedDraft.json()).task
  assert.equal(patched.requirementSnapshot.modelSha256, model.sha256)
  const agentConfirmed = await fetch(`${base}/api/tasks/${agentDraft.id}/transitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'READY', expectedVersion: patched.version }) })
  assert.equal(agentConfirmed.status, 200)
  const confirmed = await fetch(`${base}/api/tasks/${task.id}/transitions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'READY', expectedVersion: task.version }) })
  assert.equal(confirmed.status, 200)
  const started = await fetch(`${base}/api/tasks/${task.id}/runs/baseline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: task.requirementSnapshot.projectPath, version: '2024.2', cores: 4 }) })
  assert.equal(started.status, 202)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && (candidateCalls < 1 || app.database.getTask(task.id)?.executionStatus !== 'WAITING_FOR_APPROVAL')) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(baselineCalls, 1)
  assert.equal(candidateCalls, 1)
  assert.deepEqual(app.database.listTaskRuns(task.id).map(run => run.kind), ['BASELINE', 'CANDIDATE'])
  assert.equal(app.database.getTask(task.id).thermalVerdict, 'PASS')
  const detail = await (await fetch(`${base}/api/tasks/${task.id}`)).json()
  assert.equal(detail.runs.length, 2)
  assert.equal(detail.runs[0].attempts[0].resultSummary.tmaxC, 100)
  assert.equal(detail.runs[1].attempts[0].resultSummary.tmaxC, 88)
  assert.equal(detail.runs[1].attempts[0].resultSummary.converged, true)
})

test('explicit Icepak launch probe is local-only and does not claim solver readiness', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-agent-launch-probe-'))
  let launches = 0
  const pluginClient = {
    async probeEnvironment() { return { status: 'DETECTED', aedtVersions: ['2024.2'] } },
    async probeLaunchability(version) {
      launches++
      assert.equal(version, '2024.2')
      return { status: 'LAUNCHABLE', licenseStatus: 'UNKNOWN', selectedVersion: version }
    },
  }
  const app = createCoreApp({ home, pluginClient, startAgentRuntime: false })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }) })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const invalid = await fetch(`${base}/api/plugins/icepak/probe-launchability`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '2024.3' }),
  })
  assert.equal(invalid.status, 400)
  const response = await fetch(`${base}/api/plugins/icepak/probe-launchability`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '2024.2' }),
  })
  assert.equal(response.status, 200)
  const { probe } = await response.json()
  assert.equal(probe.status, 'LAUNCHABLE')
  assert.equal(probe.licenseStatus, 'UNKNOWN')
  assert.equal(launches, 1)
})

test('bundled sample inspection uses only the local fixture and never starts a solve', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-agent-sample-check-'))
  const sampleProjectPath = join(home, 'Project1.aedt')
  await writeFile(sampleProjectPath, 'sample-aedt')
  let inspected = 0
  const pluginClient = {
    async probeEnvironment() { return { status: 'DETECTED', platform: 'win32', pyaedtAvailable: true, aedtVersions: ['2024.2'], capabilities: [] } },
    async inspectProject(input) {
      inspected++
      assert.equal(input.projectPath, sampleProjectPath)
      assert.equal(input.version, '2024.2')
      assert.match(input.outputDir, /runs[/\\]icepak-self-check[/\\][0-9a-f-]+$/u)
      return { status: 'ok', mode: 'inspect', sourceProject: input.projectPath, workingProject: join(input.outputDir, 'Project1.aedt'), inputSha256: 'unused',
        project: { name: 'Project1', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: [], setups: [], boundaries: [], nativeComponents: [], monitors: [], objects: [] },
        validation: { verified: true, checks: [] }, solve: { attempted: false } }
    },
    async solveProject() { throw new Error('self-check must not solve') },
  }
  const app = createCoreApp({ home, sampleProjectPath, pluginClient, startAgentRuntime: false })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }) })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/api/plugins/icepak/sample-inspect`
  const wrongVersion = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '2025.1' }) })
  assert.equal(wrongVersion.status, 409)
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '2024.2' }) })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.sampleName, 'Project1.aedt')
  assert.equal(body.result.solve.attempted, false)
  assert.equal(inspected, 1)
  assert.equal(app.database.listTasks().length, 0)
})

test('Core exposes conservative Icepak environment evidence through the plugin boundary', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-agent-plugin-api-'))
  const app = createCoreApp({ home, startAgentRuntime: false })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  t.after(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
  })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')

  const response = await fetch(`http://127.0.0.1:${address.port}/api/plugins/icepak/probe`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.probe.pluginId, 'icepak-pyaedt')
  assert.equal(body.probe.protocolVersion, '1.0.0')
  assert.notEqual(body.probe.status, 'READY')
})

test('Core streams task snapshots for desktop and LAN web clients', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-agent-events-'))
  const app = createCoreApp({ home, startAgentRuntime: false })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  const controller = new AbortController()
  t.after(async () => { controller.abort(); await app.close(); await rm(home, { recursive: true, force: true }) })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  app.database.createTask(createTask({ title: 'Live task', description: '', ownerNodeId: 'local-node', requirementSnapshot: {} }))

  const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, { signal: controller.signal })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u)
  const reader = response.body.getReader()
  let output = ''
  while (!output.includes('event: snapshot')) {
    const chunk = await reader.read()
    if (chunk.done) break
    output += new TextDecoder().decode(chunk.value)
  }
  assert.match(output, /event: snapshot/u)
  assert.match(output, /Live task/u)
  await reader.cancel()
})

test('Core owns Icepak run directories and delegates project operations only through the plugin port', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-agent-project-api-'))
  const calls = []
  const pluginClient = {
    async probeEnvironment() { throw new Error('not used') },
    async inspectProject(input) {
      calls.push({ method: 'inspect', input })
      return {
        status: 'ok', mode: 'inspect', sourceProject: input.projectPath,
        workingProject: join(input.outputDir, 'Project1.aedt'), inputSha256: 'a'.repeat(64),
        project: { name: 'Project1', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: ['IcepakDesign1'], setups: ['Setup1'], boundaries: [], nativeComponents: [], monitors: ['Chip1'], objects: [] },
        validation: { verified: true, checks: [] },
      }
    },
    async fanCheck(input) {
      calls.push({ method: 'fan-check', input })
      return {
        status: 'ok', mode: 'fan-check', sourceProject: input.projectPath,
        workingProject: join(input.outputDir, 'Project1.aedt'), inputSha256: 'a'.repeat(64),
        project: { name: 'Project1', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: [], setups: ['Setup1'], boundaries: [], nativeComponents: [], monitors: [], objects: [] },
        validation: { verified: true, checks: [] }, fanAction: { verified: true },
      }
    },
  }
  const app = createCoreApp({ home, pluginClient, startAgentRuntime: false })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  t.after(async () => {
    await app.close()
    await rm(home, { recursive: true, force: true })
  })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`

  const inspectResponse = await fetch(`${base}/api/plugins/icepak/inspect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: 'C:\\models\\Project1.aedt', version: '2024.2' }),
  })
  assert.equal(inspectResponse.status, 200)
  const inspect = await inspectResponse.json()
  assert.equal(inspect.result.project.activeDesign, 'IcepakDesign1')
  assert.match(calls[0].input.outputDir, /runs[/\\]icepak[/\\][0-9a-f-]+$/u)

  const fanResponse = await fetch(`${base}/api/plugins/icepak/fan-check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: 'C:\\models\\Project1.aedt', fanSpeedRatio: 1.1 }),
  })
  assert.equal(fanResponse.status, 200)
  assert.equal(calls[1].method, 'fan-check')
  assert.equal(calls[1].input.fanSpeedRatio, 1.1)

  const invalidResponse = await fetch(`${base}/api/plugins/icepak/fan-check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: 'C:\\models\\Project1.aedt', fanSpeedRatio: 2 }),
  })
  assert.equal(invalidResponse.status, 400)
  assert.equal(calls.length, 2)
})

test('Core keeps skill drafts out of DSH until an explicit review publishes them', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-agent-skill-api-'))
  const pluginClient = {
    async probeEnvironment() {
      return { pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', protocolVersion: '1.0.0', status: 'READY', platform: 'win32', aedtVersions: ['2024.2'], selectedVersion: '2024.2', pyaedtAvailable: true, licenseStatus: 'AVAILABLE', capabilities: ['inspect-project', 'solve-project'], diagnostics: [] }
    },
    async inspectProject(input) {
      return { status: 'ok', mode: 'inspect', sourceProject: input.projectPath, workingProject: input.projectPath, inputSha256: 'd'.repeat(64), project: { name: 'Project1', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: ['IcepakDesign1'], setups: ['Setup1'], boundaries: [], nativeComponents: [], monitors: [], objects: [] }, validation: { verified: true, checks: [] } }
    },
  }
  const app = createCoreApp({ home, pluginClient, startAgentRuntime: false })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }) })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const task = app.database.createTask(createTask({ title: 'API Skill', description: '', ownerNodeId: 'local-node', requirementSnapshot: {} }))
  const { attempt } = app.database.createRunWithAttempt({
    taskId: task.id, kind: 'BASELINE', executorNodeId: 'local-node', pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', parameters: {},
  })
  for (const [sha256, role] of [
    ['a'.repeat(64), 'INPUT_PROJECT'], ['b'.repeat(64), 'SOLVED_PROJECT'], ['c'.repeat(64), 'SOLVER_RESULT'],
  ]) {
    app.database.upsertArtifact({ sha256, sizeBytes: 1, mediaType: 'application/octet-stream', originalName: role, relativePath: sha256, createdAt: new Date().toISOString() })
    app.database.linkAttemptArtifact({ attemptId: attempt.id, sha256, role, createdAt: new Date().toISOString() })
  }
  app.database.transitionAttempt(attempt.id, 'STARTING')
  app.database.transitionAttempt(attempt.id, 'RUNNING')
  app.database.transitionAttempt(attempt.id, 'SUCCEEDED')
  for (const [status, version] of [['READY', 1], ['QUEUED', 2], ['RUNNING', 3], ['COMPLETED', 4]]) {
    app.database.transitionTask(task.id, status, version)
  }

  const draftResponse = await fetch(`${base}/api/tasks/${task.id}/skill-draft`, { method: 'POST' })
  assert.equal(draftResponse.status, 201)
  const { skill: draft } = await draftResponse.json()
  assert.equal(draft.status, 'DRAFT')
  assert.equal(draft.publishedPath, null)

  const enableResponse = await fetch(`${base}/api/skills/${draft.id}/enable`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer: 'test-user', expectedUpdatedAt: draft.updatedAt }),
  })
  assert.equal(enableResponse.status, 200)
  const { skill: enabled } = await enableResponse.json()
  assert.equal(enabled.status, 'ENABLED')
  await access(enabled.publishedPath)

  const runResponse = await fetch(`${base}/api/skills/${enabled.id}/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Skill-driven task', projectPath: 'C:\\models\\Project1.aedt', targetTmaxC: 90, version: '2024.2', cores: 4 }),
  })
  assert.equal(runResponse.status, 201)
  const skillRun = await runResponse.json()
  assert.equal(skillRun.task.executionStatus, 'DRAFT')
  assert.equal(skillRun.run.status, 'RUNNING')
  assert.equal(skillRun.run.steps.find(step => step.stepId === 'probe').status, 'COMPLETED')
  assert.equal(skillRun.run.steps.find(step => step.stepId === 'confirm').status, 'PENDING')
  const taskDetailResponse = await fetch(`${base}/api/tasks/${skillRun.task.id}`)
  const taskDetail = await taskDetailResponse.json()
  assert.equal(taskDetail.skillRun.id, skillRun.run.id)
  const confirmResponse = await fetch(`${base}/api/tasks/${skillRun.task.id}/transitions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'READY', expectedVersion: 1, reason: '确认 Skill 输入' }),
  })
  assert.equal(confirmResponse.status, 200)
  const confirmedDetail = await (await fetch(`${base}/api/tasks/${skillRun.task.id}`)).json()
  assert.equal(confirmedDetail.skillRun.steps.find(step => step.stepId === 'confirm').status, 'COMPLETED')

  const staleResponse = await fetch(`${base}/api/skills/${draft.id}/disable`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewer: 'test-user', expectedUpdatedAt: draft.updatedAt }),
  })
  assert.equal(staleResponse.status, 409)
})
