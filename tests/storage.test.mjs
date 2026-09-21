import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { createTask } from '@thermal-agent/domain'
import { LocalDatabase, VersionConflictError } from '@thermal-agent/sqlite-store'

test('SQLite persists task transitions and immutable event history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-agent-sqlite-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'thermal.db')
  const task = createTask({ title: 'Baseline', description: '', ownerNodeId: 'node-a', requirementSnapshot: {} })

  const first = new LocalDatabase(path)
  first.createTask(task)
  const ready = first.transitionTask(task.id, 'READY', 1, '需求已确认')
  first.close()

  const reopened = new LocalDatabase(path)
  t.after(() => reopened.close())
  assert.equal(reopened.getTask(task.id)?.executionStatus, 'READY')
  assert.equal(reopened.listTaskEvents(task.id).length, 2)
  assert.equal(reopened.listTaskEvents(task.id)[1].reason, '需求已确认')
  assert.throws(() => reopened.transitionTask(task.id, 'QUEUED', ready.version - 1), VersionConflictError)
})

test('Artifact Store deduplicates bytes by SHA-256 without storing blobs in SQLite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-agent-artifacts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ArtifactStore(root)
  const first = await store.putBytes(Buffer.from('same-aedt-content'), 'Project1.aedt')
  const second = await store.putBytes(Buffer.from('same-aedt-content'), 'Copy.aedt')

  assert.equal(first.sha256, second.sha256)
  assert.equal(first.relativePath, second.relativePath)
  assert.match(store.resolveArtifact(first.sha256), new RegExp(`${first.sha256}$`, 'u'))
  assert.throws(() => store.resolveArtifact('../escape'), /invalid/u)
})
