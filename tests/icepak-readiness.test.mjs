import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createCoreApp, effectiveIcepakProbe, ICEPAK_READINESS_TTL_MS, NodeIdentity, PeerTaskInbox } from '@thermal-agent/core'

test('recent verified local solve attests READY without treating installation or launch as license proof', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-readiness-'))
  const home = join(root, 'app')
  const base = { pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', protocolVersion: '1.0.0',
    status: 'DETECTED', platform: 'win32', aedtVersions: ['2024.2', '2025.1'], selectedVersion: '2025.1',
    pyaedtAvailable: true, licenseStatus: 'UNKNOWN', capabilities: ['baseline_solve'], diagnostics: ['installation found'] }
  const plugin = {
    async probeEnvironment() { return base },
    async solveProject(input) {
      const data = await readFile(input.projectPath)
      const output = join(input.outputDir, 'solved.aedt')
      await mkdir(input.outputDir, { recursive: true })
      await writeFile(output, Buffer.concat([data, Buffer.from('-solved')]))
      return { status: 'ok', mode: 'solve', sourceProject: input.projectPath, workingProject: input.projectPath,
        inputSha256: createHash('sha256').update(data).digest('hex'),
        project: { name: 'Project1', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: [],
          setups: ['Setup1'], boundaries: [], nativeComponents: [], monitors: [], objects: [] },
        validation: { verified: true, checks: [] }, solve: { attempted: true, succeeded: true },
        metrics: { tmaxC: 80, converged: true, solverNormalCompletion: true }, artifacts: { projectPath: output } }
    },
  }
  let app = createCoreApp({ home, startAgentRuntime: false, pluginClient: plugin })
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  let address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const probeUrl = () => `http://127.0.0.1:${address.port}/api/plugins/icepak/probe`
  assert.equal((await (await fetch(probeUrl())).json()).probe.status, 'DETECTED')
  const ownerIdentity = NodeIdentity.loadOrCreate(join(root, 'owner'))
  app.database.trustPeer(ownerIdentity.publicIdentity, 'Owner')
  app.database.setRemoteExecutionEnabled(true)
  let inbox = new PeerTaskInbox(app.nodeIdentity.nodeId, app.database, plugin, undefined,
    () => effectiveIcepakProbe(base, app.database, app.artifacts))
  const offer = { operation: 'task.baseline.offer', taskId: randomUUID(), runId: randomUUID(),
    attemptId: randomUUID(), ownerNodeId: ownerIdentity.nodeId, executorNodeId: app.nodeIdentity.nodeId,
    leaseId: randomUUID(), epoch: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    inputSha256: 'a'.repeat(64), inputSizeBytes: 1, inputOriginalName: 'Project1.aedt',
    parameters: { version: '2024.2', nonGraphical: true } }
  await assert.rejects(inbox.receive(ownerIdentity.nodeId, offer), error => error.code === 'ICEPAK_NOT_READY')
  const source = join(root, 'Project1.aedt')
  await writeFile(source, 'source-project')
  const verifyUrl = `http://127.0.0.1:${address.port}/api/plugins/icepak/verify-solver`
  const denied = await fetch(verifyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: source, version: '2024.2' }) })
  assert.equal(denied.status, 400)
  assert.equal(app.database.listTasks().length, 0)
  const response = await fetch(verifyUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: source, version: '2024.2', authorizeSolve: true }),
  })
  assert.equal(response.status, 202)
  const created = await response.json()
  assert.equal(created.task.requirementSnapshot.diagnosticReadinessProbe, true)
  let readiness
  for (let index = 0; index < 100; index++) {
    readiness = app.database.listIcepakReadiness()[0]
    if (readiness) break
    await delay(20)
  }
  assert.ok(readiness)
  assert.equal(readiness.source, 'LOCAL_ATTEMPT')
  let probe = (await (await fetch(probeUrl())).json()).probe
  assert.equal(probe.status, 'READY')
  assert.equal(probe.licenseStatus, 'AVAILABLE')
  assert.deepEqual(probe.aedtVersions, ['2024.2'])
  assert.ok(probe.readinessVerifiedAt)
  assert.equal((await inbox.receive(ownerIdentity.nodeId, offer)).status, 'OFFERED')
  assert.equal((await effectiveIcepakProbe(base, app.database, app.artifacts,
    new Date(Date.parse(readiness.verifiedAt) + ICEPAK_READINESS_TTL_MS + 1))).status, 'DETECTED')
  assert.equal((await effectiveIcepakProbe({ ...base, pluginVersion: '0.3.0' }, app.database, app.artifacts)).status, 'DETECTED')
  assert.equal((await effectiveIcepakProbe({ ...base, platform: 'linux' }, app.database, app.artifacts)).status, 'DETECTED')

  await app.close()
  app = createCoreApp({ home, startAgentRuntime: false, pluginClient: plugin })
  app.server.listen(0, '127.0.0.1')
  await new Promise(resolve => app.server.once('listening', resolve))
  address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  probe = (await (await fetch(probeUrl())).json()).probe
  assert.equal(probe.status, 'READY')
})
