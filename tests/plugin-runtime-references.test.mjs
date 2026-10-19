import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalDatabase, ModelPreparationStore } from '@thermal-agent/sqlite-store'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { createTask } from '@thermal-agent/domain'
import { pluginRuntimeReferences } from '../apps/core/dist/plugin-runtime-references.js'

test('retention reads persisted attempt, model and remote execution identities and rejects damaged evidence', async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-runtime-refs-'))
  const database = new LocalDatabase(join(home, 'state.sqlite')), modelStore = new ModelPreparationStore(database.path)
  t.after(async () => { modelStore.close(); database.close(); await rm(home, { recursive: true, force: true }) })
  const artifacts = new ArtifactStore(join(home, 'artifacts'))
  const identity = digit => ({ pluginId: 'icepak-pyaedt', pluginVersion: '1.0.0', packageDigest: digit.repeat(64), environmentDigest: digit.repeat(64) })
  const task = database.createTask(createTask({ title: 'retention evidence fixture', description: '', ownerNodeId: 'local', requirementSnapshot: {} }))
  database.createRunWithAttempt({ taskId: task.id, kind: 'BASELINE', executorNodeId: 'local', pluginId: 'icepak-pyaedt', pluginVersion: '1.0.0', parameters: { pluginRuntime: identity('a') } })
  const modelIdentity = await artifacts.putBytes(Buffer.from(JSON.stringify(identity('b'))), 'plugin-runtime.json', 'application/json')
  database.upsertArtifact(modelIdentity)
  modelStore.createJob({ id: 'model-job', taskId: task.id, kind: 'VALIDATE', requestId: 'model-request', status: 'SUCCEEDED', artifacts: [] })
  modelStore.updateJob('model-job', { artifacts: [{ role: 'PLUGIN_RUNTIME', sha256: modelIdentity.sha256 }] })
  const remote = await artifacts.putBytes(Buffer.from(JSON.stringify({ pluginRuntime: identity('c') })), 'remote-result.json', 'application/json')
  database.upsertArtifact(remote)
  database.acceptRemoteJob({ attemptId: 'remote-attempt', taskId: 'remote-task', runId: 'remote-run', ownerNodeId: 'remote', executorNodeId: 'local', leaseId: 'lease', epoch: 1,
    inputSha256: remote.sha256, inputSizeBytes: remote.sizeBytes, inputOriginalName: 'fixture.aedt', parameters: {} })
  for (const [from, to] of [['OFFERED', 'TRANSFERRING'], ['TRANSFERRING', 'INPUT_READY'], ['INPUT_READY', 'RUNNING']]) database.transitionRemoteJob('remote-attempt', 'lease', 1, from, to)
  database.stageRemoteJobResults('remote-attempt', 'lease', 1, remote.sha256, remote.sha256, null)
  const refs = await pluginRuntimeReferences(database, modelStore, artifacts)
  assert.deepEqual(new Set(refs.map(ref => ref.environmentDigest)), new Set(['a', 'b', 'c'].map(digit => digit.repeat(64))))
  const repaired = await artifacts.putBytes(Buffer.from(JSON.stringify(identity('d'))), 'new-plugin-runtime.json', 'application/json')
  database.upsertArtifact(repaired)
  modelStore.updateJob('model-job', { artifacts: [{ role: 'PLUGIN_RUNTIME', sha256: repaired.sha256 }] })
  assert.deepEqual(new Set((await pluginRuntimeReferences(database, modelStore, artifacts)).map(ref => ref.environmentDigest)),
    new Set(['a', 'b', 'c', 'd'].map(digit => digit.repeat(64))), 'current job records and retained historical artifact links both protect their environments')
  await writeFile(artifacts.resolveArtifact(modelIdentity.sha256), JSON.stringify(identity('d')))
  await assert.rejects(pluginRuntimeReferences(database, modelStore, artifacts), /SHA-256 mismatch/)
  await rm(artifacts.resolveArtifact(modelIdentity.sha256))
  await assert.rejects(pluginRuntimeReferences(database, modelStore, artifacts), { code: 'ENOENT' })
})
