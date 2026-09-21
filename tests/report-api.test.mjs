import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCoreApp } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'

test('approved task generates an auditable PDF, stores REPORT evidence, and serves it idempotently', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-agent-report-'))
  const app = createCoreApp({ home, startAgentRuntime: false })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  t.after(async () => { await app.close(); await rm(home, { recursive: true, force: true }) })
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`

  const task = app.database.createTask(createTask({
    title: '报告集成测试', description: '真实 PDF 插件', ownerNodeId: 'local-node',
    requirementSnapshot: { projectPath: 'C:\\Models\\Project1.aedt', targetTmaxC: 105, aedtVersion: '2024.2', cores: 4 },
  }))
  const { attempt } = app.database.createRunWithAttempt({
    taskId: task.id, kind: 'BASELINE', executorNodeId: 'local-node',
    pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', parameters: {},
  })
  for (const [role, content] of [
    ['INPUT_PROJECT', 'input'], ['SOLVED_PROJECT', 'output'],
    ['SOLVER_RESULT', JSON.stringify({ metrics: { tmaxC: 103.56, converged: true, flowConverged: true, temperatureConverged: true, monitorTemperatureStable: true, reversedFlowDetected: false } })],
  ]) {
    const artifact = await app.artifacts.putBytes(Buffer.from(content), `${role}.json`, 'application/json')
    app.database.upsertArtifact(artifact)
    app.database.linkAttemptArtifact({ attemptId: attempt.id, sha256: artifact.sha256, role, createdAt: new Date().toISOString() })
  }
  app.database.transitionAttempt(attempt.id, 'STARTING')
  app.database.transitionAttempt(attempt.id, 'RUNNING')
  app.database.transitionAttempt(attempt.id, 'SUCCEEDED')
  for (const [status, version] of [['READY', 1], ['QUEUED', 2], ['RUNNING', 3]]) app.database.transitionTask(task.id, status, version)
  app.database.requestTaskApproval(task.id, 'PASS', 4, '等待复核')

  const blocked = await fetch(`${base}/api/tasks/${task.id}/report`, { method: 'POST' })
  assert.equal(blocked.status, 409)
  app.database.resolveTaskApproval(task.id, 'APPROVED', 5, '人工接受')

  const first = await fetch(`${base}/api/tasks/${task.id}/report`, { method: 'POST' })
  assert.equal(first.status, 201)
  const { report } = await first.json()
  assert.equal(report.link.role, 'REPORT')
  assert.equal(report.artifact.mediaType, 'application/pdf')
  assert.deepEqual((await readFile(app.artifacts.resolveArtifact(report.artifact.sha256))).subarray(0, 4).toString(), '%PDF')

  const second = await fetch(`${base}/api/tasks/${task.id}/report`, { method: 'POST' })
  assert.equal(second.status, 201)
  assert.equal((await second.json()).report.artifact.sha256, report.artifact.sha256)
  assert.equal(app.database.listAttemptArtifacts(attempt.id).filter(item => item.role === 'REPORT').length, 1)

  const download = await fetch(`${base}/api/tasks/${task.id}/report`)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-type'), 'application/pdf')
  assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 4).toString(), '%PDF')
})
