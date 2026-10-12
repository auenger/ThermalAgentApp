import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createTask } from '@thermal-agent/domain'
import { get } from 'node:http'
import { modelApp } from './fixtures/model-preparation-app.mjs'

test('CAD preview source is task scoped and remains the original STEP after activation', async t => {
  const f = await modelApp(undefined, { realCad: true }); t.after(() => f.close())
  const sha = f.task.requirementSnapshot.modelSha256
  const source = await fetch(`${f.base}${f.path}/cad-source/${sha}`)
  assert.equal(source.status, 200)
  assert.deepEqual(Buffer.from(await source.arrayBuffer()), await readFile(resolve('assets/cad/reference-natural-convection.step')))
  const unrelated = f.app.database.createTask(createTask({ title: 'Other', description: '', ownerNodeId: f.app.nodeIdentity.nodeId, requirementSnapshot: {} }))
  assert.equal((await fetch(`${f.base}/api/tasks/${unrelated.id}/cad-source/${sha}`)).status, 404)
  assert.equal((await fetch(`${f.base}/api/tasks/${randomUUID()}/cad-source/${sha}`)).status, 404)
  // Simulate the identity split after activation; the new AEDT input must never replace the source.
  f.app.database.updateTaskDraft(f.task.id, f.task.title, f.task.description, { ...f.task.requirementSnapshot,
    modelKind: 'AEDT', modelSha256: 'f'.repeat(64), sourceModel: { sha256: sha } }, f.task.version)
  assert.equal((await fetch(`${f.base}${f.path}/cad-source/${sha}`)).status, 200)
  assert.equal((await fetch(`${f.base}${f.path}/cad-source/${'f'.repeat(64)}`)).status, 404)
})

test('preview rejects unsupported files and large inputs without changing archived artifacts', async t => {
  const f = await modelApp(); t.after(() => f.close())
  for (const [name, size, expected] of [['input.iges', 10, 404], ['large.step', 32 * 1024 * 1024 + 1, 413]]) {
    const artifact = await f.app.artifacts.putBytes(Buffer.alloc(size), name, 'application/octet-stream')
    f.app.database.upsertArtifact(artifact)
    const task = f.app.database.createTask(createTask({ title: name, description: '', ownerNodeId: f.app.nodeIdentity.nodeId,
      requirementSnapshot: { modelKind: 'CAD', modelSha256: artifact.sha256 } }))
    const response = await fetch(`${f.base}/api/tasks/${task.id}/cad-source/${artifact.sha256}`)
    assert.equal(response.status, expected)
    assert.equal(f.app.database.getArtifact(artifact.sha256).sizeBytes, size)
  }
})

test('cancelling a CAD source stream leaves Core alive', async t => {
  const f = await modelApp(); t.after(() => f.close())
  const artifact = await f.app.artifacts.putBytes(Buffer.alloc(8 * 1024 * 1024), 'cancel.step', 'application/octet-stream')
  f.app.database.upsertArtifact(artifact)
  const task = f.app.database.createTask(createTask({ title: 'Cancel stream', description: '', ownerNodeId: f.app.nodeIdentity.nodeId,
    requirementSnapshot: { modelKind: 'CAD', modelSha256: artifact.sha256 } }))
  await new Promise((done, reject) => {
    const request = get(`${f.base}/api/tasks/${task.id}/cad-source/${artifact.sha256}`, response => {
      assert.equal(response.statusCode, 200)
      response.once('data', () => response.destroy())
      response.once('close', done)
    })
    request.once('error', reject)
  })
  const alive = await fetch(f.base + '/api/tasks')
  assert.equal(alive.status, 200)
  assert.equal(f.app.database.getArtifact(artifact.sha256).sizeBytes, 8 * 1024 * 1024)
})

test('bundled viewer serves WASM and notices with dynamic evaluation restricted to its worker', async t => {
  const f = await modelApp(); t.after(() => f.close())
  const files = await readdir(resolve('apps/web/dist/assets'))
  const worker = files.find(n => /^step\.worker-.*\.js$/.test(n))
  const wasm = files.find(n => /^occt-import-js-.*\.wasm$/.test(n))
  assert.ok(worker); assert.ok(wasm)
  const main = await fetch(f.base)
  assert.doesNotMatch(main.headers.get('content-security-policy'), /unsafe-eval/)
  const workerResponse = await fetch(`${f.base}/assets/${worker}`)
  assert.match(workerResponse.headers.get('content-security-policy'), /script-src 'self' 'unsafe-eval'/)
  const wasmResponse = await fetch(`${f.base}/assets/${wasm}`)
  assert.equal(wasmResponse.headers.get('content-type'), 'application/wasm')
  for (const name of files.filter(n => /^license\.occt.*\.txt$/.test(n))) {
    const response = await fetch(`${f.base}/assets/${name}`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /GNU LESSER GENERAL PUBLIC LICENSE/)
  }
  assert.equal(files.filter(n => /^license\.occt.*\.txt$/.test(n)).length, 2)
})
