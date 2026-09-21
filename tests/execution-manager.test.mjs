import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { IcepakExecutionManager } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'
import { LocalDatabase } from '@thermal-agent/sqlite-store'

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

function unused() { throw new Error('not used by this test') }

test('local execution snapshots input, records progress, and links immutable result artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-agent-execution-'))
  const database = new LocalDatabase(join(root, 'data', 'thermal.db'))
  const artifacts = new ArtifactStore(join(root, 'artifacts'))
  const source = join(root, 'Project1.aedt')
  await writeFile(source, 'source-project')
  const progress = []
  const plugin = {
    probeEnvironment: unused, inspectProject: unused, fanCheck: unused, fanSolve: unused,
    async solveProject(input, options) {
      progress.push('called')
      plugin.lastProjectPath = input.projectPath
      options.onProgress?.('project_copied')
      options.onProgress?.('solving')
      const artifactDir = join(input.outputDir, 'artifacts')
      await mkdir(artifactDir, { recursive: true })
      const solved = join(artifactDir, 'Project1.aedt')
      const convergence = join(artifactDir, 'convergence.json')
      await writeFile(solved, 'solved-project')
      await writeFile(convergence, JSON.stringify({ verified: true }))
      return {
        status: 'ok', mode: 'solve', sourceProject: input.projectPath,
        workingProject: input.projectPath, inputSha256: 'unused',
        project: { name: 'Project1', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: [], setups: ['Setup1'], boundaries: [], nativeComponents: [], monitors: [], objects: [] },
        validation: { verified: true, checks: [] },
        artifacts: { projectPath: solved, convergencePath: convergence },
      }
    },
  }
  const manager = new IcepakExecutionManager(root, database, artifacts, plugin)
  t.after(async () => {
    await manager.close()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const task = database.createTask(createTask({ title: 'Baseline', description: '', ownerNodeId: 'local-node', requirementSnapshot: {} }))
  database.transitionTask(task.id, 'READY', 1)
  const started = await manager.startBaseline(task.id, { projectPath: source, cores: 4 })
  const finished = await waitFor(
    () => database.getAttempt(started.attempt.id)?.status === 'SUCCEEDED' && database.getAttempt(started.attempt.id),
    'baseline attempt did not finish',
  )
  assert.equal(finished.progressStage, 'result_collected')
  assert.equal(database.getTask(task.id)?.executionStatus, 'COMPLETED')
  assert.equal(database.getRun(started.run.id)?.selectedAttemptId, started.attempt.id)
  assert.deepEqual(database.listAttemptArtifacts(started.attempt.id).map(item => item.role), [
    'INPUT_PROJECT', 'SOLVED_PROJECT', 'SOLVER_RESULT', 'CONVERGENCE_EVIDENCE',
  ])
  assert.deepEqual(progress, ['called'])
  assert.notEqual(plugin.lastProjectPath, source)
})

test('cancelling an active local attempt produces terminal Attempt and Task states', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-agent-cancel-'))
  const database = new LocalDatabase(join(root, 'thermal.db'))
  const artifacts = new ArtifactStore(join(root, 'artifacts'))
  const source = join(root, 'Project1.aedt')
  await writeFile(source, 'source-project')
  const plugin = {
    probeEnvironment: unused, inspectProject: unused, fanCheck: unused, fanSolve: unused,
    solveProject(_input, options) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    },
  }
  const manager = new IcepakExecutionManager(root, database, artifacts, plugin)
  t.after(async () => {
    await manager.close()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const task = database.createTask(createTask({ title: 'Cancel', description: '', ownerNodeId: 'local-node', requirementSnapshot: {} }))
  database.transitionTask(task.id, 'READY', 1)
  const started = await manager.startBaseline(task.id, { projectPath: source })
  manager.cancel(started.attempt.id)
  await waitFor(
    () => database.getAttempt(started.attempt.id)?.status === 'CANCELLED',
    'cancelled attempt did not reach terminal state',
  )
  assert.equal(database.getTask(task.id)?.executionStatus, 'CANCELLED')
})
