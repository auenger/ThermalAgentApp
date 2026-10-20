import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { DynamicScriptLibrary, DynamicScriptManager, DynamicScriptIterations, parseIterationPlan, nextIterationParameters } from '@thermal-agent/core'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const runtime = { pluginId: 'test', pluginVersion: '1', packageDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) }
const definition = { name: 'Heat source', version: '1', description: 'Fixture operation', source: 'python fixture', parameters: {
  power: { type: 'number', description: 'Heat source', required: true, minimum: 0, maximum: 100 },
  width: { type: 'integer', description: 'Channel width', required: true, minimum: 1, maximum: 10 } },
  applicability: { aedtVersions: ['2024.2'], requiredObjects: ['Chip'] }, tags: [] }
const plan = scriptId => ({ scriptId, parameters: { power: 20, width: 2 }, adjustable: [{ name: 'power', minimum: 0, maximum: 40, step: 10, minimumStep: 1 }],
  setup: 'Setup1', targetTmaxC: 45, maxRounds: 5, maxDurationMs: 10_000 })
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'Thermal iteration ')), artifacts = new ArtifactStore(join(root, 'artifacts'))
  const original = await artifacts.putBytes(Buffer.from('original'), 'project.aedt')
  const library = new DynamicScriptLibrary(join(root, 'scripts.sqlite')), script = library.stage(definition)
  let solverStarted; const solving = new Promise(resolve => { solverStarted = resolve })
  const calls = [], parameters = [], releases = []
  const port = {
    async pinRuntime(expected) { if (expected) assert.deepEqual(expected, runtime); return { identity: runtime, port, release() { releases.push(true) } } },
    async inspectProject(input) { return { status: 'ok', inputSha256: hash(await readFile(input.projectPath)), project: { aedtVersion: '2024.2', objects: ['Chip'] } } },
    async executeScript(input) {
      parameters.push(input.parameters)
      assert.equal(await readFile(input.projectPath, 'utf8'), 'original')
      const path = join(input.outputDir, 'verified', 'project.aedt'), bytes = Buffer.from(JSON.stringify(input.parameters))
      await mkdir(join(input.outputDir, 'verified'), { recursive: true }); await writeFile(path, bytes)
      return { status: 'ok', scriptSha256: input.scriptSha256, inputSha256: input.projectSha256, parameters: input.parameters,
        scriptExecuted: true, persistedReadback: true, readback: { passed: true, checks: [{ actual: input.parameters.power }] },
        readbackEvidenceSource: 'script-reported-after-reopen', executionKind: 'test-double', verifiedProjectPath: path, verifiedProjectSha256: hash(bytes) }
    },
    async solveProject(input, call) {
      const bytes = await readFile(input.projectPath), p = JSON.parse(bytes)
      calls.push(p); solverStarted()
      if (options.wait) await new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(new Error('cancelled solver')), { once: true }))
      const dir = join(input.outputDir, 'artifacts'); await mkdir(dir, { recursive: true })
      const projectPath = join(dir, 'project.aedt'), convergencePath = join(dir, 'convergence.json')
      await writeFile(projectPath, bytes)
      await writeFile(convergencePath, JSON.stringify({ schemaVersion: 'icepak-convergence-v1', setup: 'Setup1', evidence: { verified: !options.badEvidence }, nativeEvidencePaths: {}, rawFileSha256: {} }))
      return { status: 'ok', mode: 'solve', inputSha256: hash(bytes), project: { aedtVersion: '2024.2', activeDesign: 'Icepak' },
        validation: { verified: true }, solve: { succeeded: true, setup: 'Setup1' },
        metrics: { solverNormalCompletion: true, converged: !options.notConverged, tmaxC: 40 + p.power },
        artifacts: { projectPath, outputSha256: hash(bytes), convergencePath } }
    },
  }
  const scripts = new DynamicScriptManager(root, library, artifacts, port)
  const iterations = new DynamicScriptIterations(root, library, scripts, artifacts, port)
  t.after(async () => { await iterations.close(); await scripts.close(); library.close(); await rm(root, { recursive: true, force: true }) })
  const draft = extra => iterations.draft(randomUUID(), original.sha256, '2024.2', { ...plan(script.id), ...extra })
  return { library, script, iterations, draft, calls, parameters, releases, artifacts, solving }
}
test('coordinate search preserves fixed parameters and honors numeric constraints', () => {
  const script = { ...definition, id: 'script' }, config = parseIterationPlan(plan('script'), script)
  assert.deepEqual(nextIterationParameters(config, []), { ...config.parameters })
  const rounds = [{ parameters: config.parameters, status: 'SUCCEEDED', tmaxC: 60 }]
  const next = nextIterationParameters(config, rounds)
  assert.equal(next.power, 30); assert.equal(next.width, 2)
  rounds.push({ parameters: next, status: 'SUCCEEDED', tmaxC: 70 })
  assert.equal(nextIterationParameters(config, rounds).power, 10)
  assert.throws(() => parseIterationPlan({ ...config, adjustable: [{ name: 'power', minimum: -1, maximum: 100, step: 10, minimumStep: 1 }] }, script), /range/)
  assert.throws(() => parseIterationPlan({ ...config, maxRounds: 100 }, script), /budget/)
  assert.throws(() => parseIterationPlan({ ...config, adjustable: [{ name: 'width', minimum: 1, maximum: 10, step: 0.5, minimumStep: 0.5 }] }, script), /bounds/)
})
test('bounded iterations reuse one script and stop only after converged goal evidence', async t => {
  const f = await fixture(t), draft = f.draft()
  await f.iterations.start(draft.id, 1)
  const done = await f.iterations.wait(draft.id)
  assert.equal(done.status, 'STOPPED'); assert.equal(done.stopReason, 'TARGET_REACHED')
  assert.deepEqual(f.calls.map(p => p.power), [20, 30, 10, 0])
  assert.equal(done.bestRound, 4)
  assert.ok(done.rounds.every(round => round.executionKind === 'test-double' && round.resultSha256 && round.solvedProjectSha256))
  const receipt = JSON.parse(await readFile(f.artifacts.resolveArtifact(done.rounds[3].resultSha256), 'utf8'))
  assert.equal(receipt.result.metrics.tmaxC, 40)
  assert.deepEqual(receipt.runtime, runtime)
  assert.equal(f.library.list().length, 1)
  assert.equal(f.releases.length, 5)
  await assert.rejects(f.iterations.start(draft.id, 1), /draft/)
})
test('round limit records best result without claiming the temperature target', async t => {
  const f = await fixture(t), draft = f.draft({ maxRounds: 2 })
  await f.iterations.start(draft.id, 1)
  const done = await f.iterations.wait(draft.id)
  assert.equal(done.stopReason, 'ROUND_LIMIT'); assert.equal(done.bestRound, 1); assert.equal(done.rounds.length, 2)
})
for (const option of ['badEvidence', 'notConverged']) test(`reject ${option} and do not use failed metrics as search evidence`, async t => {
  const f = await fixture(t, { [option]: true }), draft = f.draft()
  await f.iterations.start(draft.id, 1)
  const done = await f.iterations.wait(draft.id)
  assert.equal(done.stopReason, 'EXECUTION_FAILED'); assert.equal(done.bestRound, undefined)
  assert.equal(done.rounds.length, 1); assert.equal(done.rounds[0].status, 'FAILED')
  assert.ok(done.rounds[0].resultSha256)
})
test('cancellation waits for the solver and retains its failed round history', async t => {
  const f = await fixture(t, { wait: true }), draft = f.draft()
  await f.iterations.start(draft.id, 1); await f.solving
  f.iterations.cancel(draft.id)
  const done = await f.iterations.wait(draft.id)
  assert.equal(done.stopReason, 'CANCELLED'); assert.equal(done.rounds[0].status, 'CANCELLED')
  assert.equal(f.iterations.busy, false); assert.equal(f.releases.length, 2)
})
test('time budget aborts an in-flight solve and never starts another round', async t => {
  const f = await fixture(t, { wait: true }), draft = f.draft({ maxDurationMs: 1000 })
  await f.iterations.start(draft.id, 1)
  const done = await f.iterations.wait(draft.id)
  assert.equal(done.stopReason, 'TIME_LIMIT'); assert.equal(f.calls.length, 1)
})
test('recovery marks unfinished iteration interrupted without restarting solver requests', async t => {
  const f = await fixture(t), draft = f.draft()
  f.library.saveIteration({ ...draft, status: 'RUNNING', startedAt: new Date().toISOString() })
  f.iterations.recoverInterrupted()
  assert.equal(f.library.iteration(draft.id).stopReason, 'INTERRUPTED')
  assert.equal(f.calls.length, 0)
})

test('search explores another parameter after worse neighbors and stops when its finite neighborhood is exhausted', () => {
  const config = parseIterationPlan({ ...plan('script'), adjustable: [...plan('script').adjustable, { name: 'width', minimum: 1, maximum: 3, step: 1, minimumStep: 1 }] }, { ...definition, id: 'script' })
  const rounds = [20, 30, 10].map((power, i) => ({ parameters: { power, width: 2 }, status: 'SUCCEEDED', tmaxC: i ? 70 : 60 }))
  assert.deepEqual(nextIterationParameters(config, rounds), { power: 20, width: 3 })
  const finite = parseIterationPlan({ ...plan('script'), adjustable: [{ name: 'power', minimum: 19, maximum: 21, step: 1, minimumStep: 1 }] }, { ...definition, id: 'script' })
  assert.equal(nextIterationParameters(finite, [20, 21, 19].map(power => ({ parameters: { power, width: 2 }, status: 'SUCCEEDED', tmaxC: power === 20 ? 60 : 70 }))), null)
})
