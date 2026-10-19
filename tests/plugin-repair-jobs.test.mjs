import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRepairJobs } from '../apps/core/dist/plugin-repair-jobs.js'
import { createRepairControl } from '../plugins/dsh-thermal/dist/repair-control.js'

const target = { basePackageDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) }
const other = { basePackageDigest: 'c'.repeat(64), environmentDigest: 'b'.repeat(64) }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'thermal-repair-jobs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = 1_000
  const path = join(root, 'jobs.json'), clock = () => now
  const jobs = new PluginRepairJobs(path, clock)
  const input = { enabled: true, targets: [target], candidates: [] }
  const dispatched = [], stopped = []
  const transport = { dispatch: async job => { dispatched.push(job) }, stop: async job => { stopped.push(job) } }
  return { jobs, input, transport, dispatched, stopped, path, clock, advance: ms => { now += ms } }
}

test('repair admission is durable before IO, serialized and consumed across restart', async t => {
  const f = await fixture(t)
  let resume
  const wait = new Promise(resolve => { resume = resolve })
  f.transport.dispatch = async job => {
    const stored = JSON.parse(await readFile(f.path, 'utf8')).jobs[0]
    assert.equal(stored.state, 'dispatching')
    assert.equal(stored.requestId, job.requestId)
    f.dispatched.push(job)
    await wait
  }
  const first = f.jobs.reconcile(() => f.input, f.transport)
  const second = f.jobs.reconcile(() => f.input, f.transport)
  assert.equal(first, second)
  resume(); await first
  assert.equal(f.dispatched.length, 1)
  const restarted = new PluginRepairJobs(f.path, f.clock)
  assert.equal(restarted.status().jobs[0].state, 'stopping')
  await restarted.reconcile(() => f.input, f.transport)
  assert.equal(restarted.status().jobs[0].state, 'interrupted')
  assert.equal(f.dispatched.length, 1)
  assert.equal(f.stopped[0].sessionId, f.dispatched[0].sessionId)
  f.input.enabled = false; await restarted.reconcile(() => f.input, f.transport)
  f.input.enabled = true; await restarted.reconcile(() => f.input, f.transport)
  assert.equal(f.dispatched.length, 1)
})

test('ambiguous prompt acknowledgement never resubmits and failed cancellation blocks subsequent jobs', async t => {
  const f = await fixture(t)
  f.transport.dispatch = async job => { f.dispatched.push(job); throw new Error('acknowledgement lost') }
  f.transport.stop = async () => { throw new Error('host control unavailable') }
  await f.jobs.reconcile(() => f.input, f.transport)
  assert.equal(f.jobs.status().jobs[0].state, 'stopping')
  assert.match(f.jobs.status().jobs[0].error, /acknowledgement lost/)
  f.input.targets.push(other)
  await f.jobs.reconcile(() => f.input, f.transport)
  assert.equal(f.dispatched.length, 1)
  f.transport.stop = async job => { f.stopped.push(job) }
  f.input.targets = [target]
  await f.jobs.reconcile(() => f.input, f.transport)
  assert.equal(f.jobs.status().jobs[0].state, 'failed')
  assert.equal(f.dispatched.length, 1)
})

test('repair deadline stops work and a new environment has a distinct bounded admission', async t => {
  const f = await fixture(t)
  await f.jobs.reconcile(() => f.input, f.transport)
  f.advance(300_000)
  await f.jobs.reconcile(() => f.input, f.transport)
  assert.equal(f.jobs.status().jobs[0].state, 'timed-out')
  f.input.targets = [{ ...target, environmentDigest: 'd'.repeat(64) }]
  await f.jobs.reconcile(() => f.input, f.transport)
  assert.equal(f.dispatched.length, 2)
  assert.notEqual(f.dispatched[0].sessionId, f.dispatched[1].sessionId)
})

test('only matching host candidate evidence settles a repair and stopping clears the live job', async t => {
  const f = await fixture(t)
  await f.jobs.reconcile(() => f.input, f.transport)
  f.input.candidates = [{ ...other, id: 'e'.repeat(64) }]
  await f.jobs.reconcile(() => f.input, f.transport)
  assert.equal(f.jobs.status().jobs[0].state, 'running')
  f.input.candidates.push({ ...target, id: 'f'.repeat(64) })
  await f.jobs.reconcile(() => f.input, f.transport)
  assert.equal(f.jobs.status().jobs[0].state, 'candidate-ready')
  assert.equal(f.jobs.status().jobs[0].candidateId, 'f'.repeat(64))
  assert.equal(f.stopped.length, 1)
})

test('policy change or close during admission cancels after the acknowledgement', async t => {
  for (const action of ['policy', 'close', 'environment']) {
    const f = await fixture(t)
    let resume
    const wait = new Promise(resolve => { resume = resolve })
    f.transport.dispatch = async job => { f.dispatched.push(job); await wait }
    const work = f.jobs.reconcile(() => f.input, f.transport)
    if (action === 'policy') f.input.enabled = false
    if (action === 'environment') f.input.targets = []
    const closing = action === 'close' ? f.jobs.close(f.transport) : Promise.resolve()
    resume(); await work; await closing
    assert.equal(f.jobs.status().jobs[0].state, 'cancelled')
    assert.equal(f.stopped.length, 1)
  }
})

test('busy checks postpone admission without cancelling active work; malformed ledger fails closed', async t => {
  const f = await fixture(t)
  f.input.canDispatch = false
  await f.jobs.reconcile(() => f.input, f.transport)
  assert.equal(f.dispatched.length, 0)
  f.input.canDispatch = true
  await f.jobs.reconcile(() => f.input, f.transport)
  f.input.canDispatch = false
  await f.jobs.reconcile(() => f.input, f.transport)
  assert.equal(f.jobs.status().jobs[0].state, 'running')
  const invalid = JSON.parse(await readFile(f.path, 'utf8'))
  invalid.jobs[0].deadline += 1
  await writeFile(f.path, JSON.stringify(invalid))
  assert.throws(() => new PluginRepairJobs(f.path), /Invalid repair job/)
})

test('ledger sealing drains pending admission and prevents writes after host ownership release', async t => {
  const f = await fixture(t)
  let resume, sealed = false
  const wait = new Promise(resolve => { resume = resolve })
  f.transport.dispatch = async () => { await wait }
  const work = f.jobs.reconcile(() => f.input, f.transport)
  let reopened = false
  const late = work.then(() => f.jobs.reconcile(() => { reopened = true; return f.input }, f.transport))
  const sealing = f.jobs.seal().then(() => { sealed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sealed, false)
  resume(); await work; await sealing; await late
  assert.equal(reopened, false)
  const before = await readFile(f.path, 'utf8')
  f.input.targets = [other]
  await f.jobs.reconcile(() => f.input, f.transport)
  assert.equal(await readFile(f.path, 'utf8'), before)
  assert.equal(f.stopped.length, 1)
})

function controlFixture(t) {
  const agents = new Map(), prompts = [], cancellations = [], archives = []
  const ctx = { agents: { get: id => agents.get(id) }, workspaceRegistry: { archiveSession: async id => { archives.push(id) } },
    sessionController: { list: async () => ({ items: [] }), create: async request => {
      agents.set(request.sessionId, { session: { header: { cwd: '/workspace', agentPreset: request.agentPreset } },
        cancel: (...args) => cancellations.push(args), whenIdle: async () => {} })
      return { sessionId: request.sessionId, agentPreset: request.agentPreset }
    }, prompt: async request => { prompts.push(request); return { accepted: true } } } }
  const control = createRepairControl(ctx, 'workspace-test', '/workspace')
  t.after(() => control.dispose())
  const input = { ...target, sessionId: 'session-11111111-1111-4111-8111-111111111111', requestId: 'repair-22222222-2222-4222-8222-222222222222', deadline: Date.now() + 60_000 }
  return { ctx, control, input, agents, prompts, cancellations, archives }
}

test('repair transport uses fixed prompt and preset, rejects replay and discards queued work on stop', async t => {
  const f = controlFixture(t)
  await f.control.run({ ...f.input, prompt: 'RUN ARBITRARY SHELL', agentPreset: 'thermal-agent' })
  assert.equal(f.agents.get(f.input.sessionId).session.header.agentPreset, 'thermal-plugin-repair')
  assert.match(f.prompts[0].content[0].text, new RegExp(target.basePackageDigest))
  assert.doesNotMatch(f.prompts[0].content[0].text, /RUN ARBITRARY SHELL/)
  assert.equal(f.prompts[0].requestId, f.input.requestId)
  await assert.rejects(f.control.run(f.input), /consumed/)
  await f.control.stop(f.input.sessionId)
  assert.deepEqual(f.cancellations[0][1], { keepInbox: false })
  assert.deepEqual(f.archives, [f.input.sessionId])
})

test('cancellation during late session creation prevents prompt admission', async t => {
  const f = controlFixture(t)
  const create = f.ctx.sessionController.create
  let resume
  const wait = new Promise(resolve => { resume = resolve })
  f.ctx.sessionController.create = async request => { await wait; return create(request) }
  const work = f.control.run(f.input)
  await assert.rejects(f.control.stop(f.input.sessionId), /settling/)
  resume()
  await assert.rejects(work, /expired/)
  assert.equal(f.prompts.length, 0)
  await f.control.stop(f.input.sessionId)
  assert.ok(f.cancellations.every(call => call[1].keepInbox === false))
})

test('late prompt acknowledgement is cancelled and ordinary or foreign sessions cannot be stopped', async t => {
  const f = controlFixture(t)
  let resume
  const wait = new Promise(resolve => { resume = resolve })
  f.ctx.sessionController.prompt = async () => { await wait; return { accepted: true } }
  const work = f.control.run(f.input)
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.control.stop(f.input.sessionId), /settling/)
  resume(); await work
  assert.equal(f.cancellations.length, 2)
  await f.control.stop(f.input.sessionId)
  const agent = f.agents.get(f.input.sessionId)
  agent.session.header.agentPreset = 'thermal-agent'
  const count = f.cancellations.length
  await assert.rejects(f.control.stop(f.input.sessionId), /Not an owned/)
  f.control.dispose()
  assert.equal(f.cancellations.length, count)
})

test('repair control enforces its own deadline even without Core polling', async t => {
  const f = controlFixture(t)
  await f.control.run({ ...f.input, deadline: Date.now() + 100 })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(f.cancellations.length, 1)
  assert.deepEqual(f.cancellations[0][1], { keepInbox: false })
  await assert.rejects(f.control.run(f.input), /consumed|cancelled/)
})

test('cold repair sessions are inspected and archived without activating persisted work', async t => {
  const f = controlFixture(t)
  f.ctx.sessionController.list = async () => ({ items: [{ sessionId: f.input.sessionId }] })
  f.ctx.sessionController.inspect = async () => ({ meta: { cwd: '/workspace', agentPreset: 'thermal-plugin-repair' } })
  f.ctx.sessionController.create = async () => { assert.fail('cold cancellation must never activate') }
  await f.control.stop(f.input.sessionId)
  assert.deepEqual(f.archives, [f.input.sessionId])
  assert.equal(f.prompts.length, 0)
  f.ctx.sessionController.inspect = async () => ({ meta: { cwd: '/other-workspace', agentPreset: 'thermal-plugin-repair' } })
  await assert.rejects(f.control.stop(f.input.sessionId), /Not an owned/)
  assert.equal(f.archives.length, 1)
})

test('repair history retains dedupe identities and refuses a 65th automatic submission', async t => {
  const f = await fixture(t)
  for (let i = 1; i <= 65; i++) {
    f.input.targets = [{ ...target, environmentDigest: i.toString(16).padStart(64, '0') }]
    await f.jobs.reconcile(() => f.input, f.transport)
    f.input.enabled = false
    await f.jobs.reconcile(() => f.input, f.transport)
    f.input.enabled = true
  }
  assert.equal(f.dispatched.length, 64)
  assert.equal(f.jobs.status().jobs.length, 64)
  await f.jobs.reconcile(() => f.input, f.transport)
  assert.match(f.jobs.status().error, /capacity/)
  const restarted = new PluginRepairJobs(f.path, f.clock)
  f.input.targets = [{ ...target, environmentDigest: '1'.padStart(64, '0') }]
  await restarted.reconcile(() => f.input, f.transport)
  assert.equal(f.dispatched.length, 64)
})
