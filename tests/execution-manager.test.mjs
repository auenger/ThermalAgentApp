import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { determineThermalVerdict, IcepakExecutionManager } from '@thermal-agent/core'
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

test('thermal verdict is deterministic and never treats solver completion as design pass', () => {
  assert.equal(determineThermalVerdict({ validation: { verified: false }, metrics: { tmaxC: 80, converged: true } }, { targetTmaxC: 90 }), 'INVALID')
  assert.equal(determineThermalVerdict({ validation: { verified: true }, metrics: { tmaxC: 80, converged: false } }, { targetTmaxC: 90 }), 'DIVERGED')
  assert.equal(determineThermalVerdict({ validation: { verified: true }, metrics: { tmaxC: 80, converged: true } }, {}), 'PENDING')
  assert.equal(determineThermalVerdict({ validation: { verified: true }, metrics: { tmaxC: 80, converged: true } }, { targetTmaxC: 79 }), 'FAIL')
  assert.equal(determineThermalVerdict({ validation: { verified: true }, metrics: { tmaxC: 80, converged: true } }, { targetTmaxC: 80 }), 'PASS')
})

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
        metrics: { tmaxC: 121.654, converged: true, solverNormalCompletion: true },
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
  const task = database.createTask(createTask({ title: 'Baseline', description: '', ownerNodeId: 'local-node', requirementSnapshot: { targetTmaxC: 122 } }))
  database.transitionTask(task.id, 'READY', 1)
  const started = await manager.startBaseline(task.id, { projectPath: source, cores: 4 })
  const finished = await waitFor(
    () => database.getAttempt(started.attempt.id)?.status === 'SUCCEEDED' && database.getAttempt(started.attempt.id),
    'baseline attempt did not finish',
  )
  assert.equal(finished.progressStage, 'result_collected')
  const waiting = database.getTask(task.id)
  assert.equal(waiting?.executionStatus, 'WAITING_FOR_APPROVAL')
  assert.equal(waiting?.thermalVerdict, 'PASS')
  assert.equal(waiting?.approvalStatus, 'PENDING')
  assert.equal(database.getRun(started.run.id)?.selectedAttemptId, started.attempt.id)
  assert.deepEqual(database.listAttemptArtifacts(started.attempt.id).map(item => item.role), [
    'INPUT_PROJECT', 'SOLVED_PROJECT', 'SOLVER_RESULT', 'CONVERGENCE_EVIDENCE',
  ])
  assert.deepEqual(progress, ['called'])
  assert.notEqual(plugin.lastProjectPath, source)
  const completed = database.resolveTaskApproval(task.id, 'APPROVED', waiting.version, '结果已人工复核')
  assert.equal(completed.executionStatus, 'COMPLETED')
  assert.equal(completed.approvalStatus, 'APPROVED')
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

test('approved fan candidate reuses baseline evidence and returns for final review', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-agent-candidate-'))
  const database = new LocalDatabase(join(root, 'thermal.db'))
  const artifacts = new ArtifactStore(join(root, 'artifacts'))
  const source = join(root, 'Project1.aedt')
  await writeFile(source, 'original-project')
  const makeResult = async (input, mode, tmaxC, comparison) => {
    const artifactDir = join(input.outputDir, 'artifacts')
    await mkdir(artifactDir, { recursive: true })
    const solved = join(artifactDir, 'Project1.aedt')
    const convergence = join(artifactDir, 'convergence.json')
    await writeFile(solved, mode === 'solve' ? 'baseline-solved' : 'candidate-solved')
    await writeFile(convergence, JSON.stringify({ verified: true }))
    return {
      status: 'ok', mode, sourceProject: input.projectPath, workingProject: input.projectPath, inputSha256: 'unused',
      project: { name: 'Project1', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: [], setups: ['Setup1'], boundaries: [], nativeComponents: [], monitors: ['Chip1'], objects: [] },
      validation: { verified: true, checks: [] },
      metrics: { tmaxC, converged: true, solverNormalCompletion: true },
      artifacts: { projectPath: solved, convergencePath: convergence },
      ...(comparison ? { comparison } : {}),
    }
  }
  const plugin = {
    probeEnvironment: unused, inspectProject: unused, fanCheck: unused,
    solveProject(input) { return makeResult(input, 'solve', 100) },
    async fanSolve(input) {
      assert.equal(await readFile(input.projectPath, 'utf8'), 'baseline-solved')
      assert.equal(input.baselineMetrics.tmaxC, 100)
      assert.equal(input.fanSpeedRatio, 1.1)
      return makeResult(input, 'fan-solve', 85, { improved: true, rollbackRequired: false, deltaTmaxC: -15 })
    },
  }
  const manager = new IcepakExecutionManager(root, database, artifacts, plugin)
  t.after(async () => { await manager.close(); database.close(); await rm(root, { recursive: true, force: true }) })
  const task = database.createTask(createTask({
    title: 'Two rounds', description: '', ownerNodeId: 'local-node', requirementSnapshot: { targetTmaxC: 90 },
  }))
  database.transitionTask(task.id, 'READY', 1)
  await manager.startBaseline(task.id, { projectPath: source })
  const baselineReview = await waitFor(
    () => database.getTask(task.id)?.executionStatus === 'WAITING_FOR_APPROVAL' && database.getTask(task.id),
    'baseline did not reach review',
  )
  assert.equal(baselineReview.thermalVerdict, 'FAIL')

  const candidate = await manager.startCandidate(task.id, { expectedVersion: baselineReview.version, fanSpeedRatio: 1.1 })
  const candidateReview = await waitFor(
    () => database.getAttempt(candidate.attempt.id)?.status === 'SUCCEEDED' && database.getTask(task.id)?.executionStatus === 'WAITING_FOR_APPROVAL' && database.getTask(task.id),
    'candidate did not reach final review',
  )
  assert.equal(candidateReview.thermalVerdict, 'PASS')
  assert.equal(candidateReview.approvalStatus, 'PENDING')
  assert.deepEqual(database.listTaskRuns(task.id).map(run => run.kind), ['BASELINE', 'CANDIDATE'])
  assert.equal(database.resolveTaskApproval(task.id, 'APPROVED', candidateReview.version).executionStatus, 'COMPLETED')
})
