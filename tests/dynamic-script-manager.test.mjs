import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { DynamicScriptLibrary, DynamicScriptManager } from '@thermal-agent/core'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'Thermal dynamic manager '))
  const artifacts = new ArtifactStore(join(home, 'artifacts'))
  const original = await artifacts.putBytes(Buffer.from('original project'), 'input.aedt')
  const library = new DynamicScriptLibrary(join(home, 'scripts.sqlite'))
  const script = library.stage({ name: 'Heat', version: '1', description: 'Change heat source', source: 'script supplied at runtime',
    parameters: { power: { type: 'number', description: 'Power', minimum: 0, maximum: 100, required: true } },
    applicability: { aedtVersions: ['2024.2'], requiredObjects: ['Chip'] }, tags: [] })
  const state = { released: 0, executed: 0 }
  let markExecuting
  const executing = new Promise(resolve => { markExecuting = resolve })
  const port = {
    async inspectProject(input) { return { status: 'ok', inputSha256: original.sha256, project: { aedtVersion: '2024.2', objects: options.missing ? [] : ['Chip'] } } },
    async executeScript(input, call) {
      state.executed++
      markExecuting()
      if (options.wait) await new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
      const verified = join(input.outputDir, 'verified', 'project.aedt')
      await mkdir(join(input.outputDir, 'verified'), { recursive: true })
      const output = Buffer.from(`changed power=${input.parameters.power}`)
      await writeFile(verified, output)
      return { schemaVersion: 1, status: 'ok', scriptSha256: input.scriptSha256, inputSha256: input.projectSha256,
        parameters: input.parameters, scriptExecuted: true, persistedReadback: true, readbackEvidenceSource: 'script-reported-after-reopen',
        readback: { passed: true, checks: [{ actual: input.parameters.power }] }, executionKind: 'test-double',
        verifiedProjectPath: options.badPath ? join(home, 'unrelated.aedt') : verified,
        verifiedProjectSha256: options.badDigest ? '0'.repeat(64) : hash(output), output: {}, solve: { hostRequested: false, status: 'not-verified' } }
    },
    async pinRuntime() { return { port, identity: { pluginId: 'icepak-pyaedt', pluginVersion: '0.3.0', packageDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) }, release() { state.released++ } } },
  }
  const manager = new DynamicScriptManager(home, library, artifacts, port)
  t.after(async () => { await manager.close(); library.close(); await rm(home, { recursive: true, force: true }) })
  const input = { taskId: randomUUID(), scriptId: script.id, parameters: { power: 20 }, projectSha256: original.sha256, aedtVersion: '2024.2' }
  return { manager, library, input, state, artifacts, original, executing }
}
test('dynamic task persists exact provenance and stores an artifact that can be reused for later solve', async t => {
  const f = await fixture(t)
  const run = await f.manager.start(f.input)
  const done = await f.manager.wait(run.id)
  assert.equal(done.status, 'SUCCEEDED')
  assert.equal(done.evidence.kind, 'test-double')
  assert.equal(await readFile(f.artifacts.resolveArtifact(done.evidence.projectSha256), 'utf8'), 'changed power=20')
  const receipt = JSON.parse(await readFile(f.artifacts.resolveArtifact(done.evidence.artifactSha256), 'utf8'))
  assert.equal(receipt.scriptId, f.input.scriptId)
  assert.equal(receipt.parameters.power, 20)
  assert.equal(receipt.inputSha256, f.original.sha256)
  assert.equal(await readFile(f.artifacts.resolveArtifact(f.original.sha256), 'utf8'), 'original project')
  assert.equal(f.state.released, 1)
  // A second invocation uses the same script with new parameters, not new code.
  const next = await f.manager.start({ ...f.input, parameters: { power: 30 } })
  const second = await f.manager.wait(next.id)
  assert.equal(second.status, 'SUCCEEDED')
  assert.notEqual(second.evidence.projectSha256, done.evidence.projectSha256)
  assert.equal(f.library.list().length, 1)
})
test('required objects are checked before script code executes', async t => {
  const f = await fixture(t, { missing: true })
  const run = await f.manager.start(f.input)
  const done = await f.manager.wait(run.id)
  assert.equal(done.status, 'FAILED')
  assert.match(done.error, /objects are missing/)
  assert.equal(f.state.executed, 0)
  assert.equal(f.state.released, 1)
})
for (const fault of ['badPath', 'badDigest']) test(`reject ${fault} instead of saving success`, async t => {
  const f = await fixture(t, { [fault]: true })
  const run = await f.manager.start(f.input)
  assert.equal((await f.manager.wait(run.id)).status, 'FAILED')
  assert.equal(f.state.released, 1)
})
test('cancel holds the runtime until execution exits and stops competing dynamic jobs', async t => {
  const f = await fixture(t, { wait: true })
  const run = await f.manager.start(f.input)
  await assert.rejects(f.manager.start(f.input), /busy/)
  await f.executing
  assert.equal(f.state.released, 0)
  f.manager.cancel(run.id)
  assert.equal((await f.manager.wait(run.id)).status, 'CANCELLED')
  assert.equal(f.manager.busy, false)
  assert.equal(f.state.released, 1)
})
