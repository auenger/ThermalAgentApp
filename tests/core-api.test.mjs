import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCoreApp } from '@thermal-agent/core'

test('Core API creates, persists and transitions a task through one business write path', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-agent-core-'))
  const app = createCoreApp({ home })
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

  const detailResponse = await fetch(`${base}/api/tasks/${created.task.id}`)
  const detail = await detailResponse.json()
  assert.equal(detail.task.executionStatus, 'READY')
  assert.deepEqual(detail.events.map(event => event.eventType), ['task.created', 'task.status_changed'])
})

test('Core exposes conservative Icepak environment evidence through the plugin boundary', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-agent-plugin-api-'))
  const app = createCoreApp({ home })
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
