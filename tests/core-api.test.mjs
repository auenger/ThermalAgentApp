import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
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
