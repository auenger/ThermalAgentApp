import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreApp } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export async function modelApp(existingHome) {
  const home = existingHome ?? await mkdtemp(join(tmpdir(), 'thermal-model-test-'))
  const controls = { delay: 0, failedValidation: false, badPath: false, calls: [] }
  const env = { aedtVersion: '2024.2', pyaedtVersion: 'test', evidenceKind: 'TEST_DOUBLE' }
  const write = async (root, name, data) => { await mkdir(root, { recursive: true }); const path = join(root, name); await writeFile(path, typeof data === 'string' ? data : JSON.stringify(data)); return path }
  const wait = async options => {
    if (options?.signal.aborted) throw new Error('cancelled')
    if (!controls.delay) return
    await new Promise((done, reject) => {
      const timer = setTimeout(done, controls.delay)
      options?.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')) }, { once: true })
    })
  }
  const plugin = {
    async probeEnvironment() { return { status: 'NOT_INSTALLED', platform: 'darwin', aedtVersions: [], checks: [], diagnostics: [] } },
    async inspectProject() { throw new Error('unexpected ordinary project check') },
    async fanCheck() { throw new Error('unexpected fan check') },
    async fanSolve() { throw new Error('unexpected fan solve') },
    async inspectCad(input, options) {
      controls.calls.push({ method: 'inspect', input })
      options?.onProgress?.('cad_importing'); await wait(options)
      const catalog = { schemaVersion: 1, inspectionId: input.inspectionId, sourceSha256: input.sourceSha256, units: 'mm', boundingBox: [0, 0, 0, 30, 30, 12],
        objects: [{ key: input.inspectionId + ':CPU', name: 'CPU', type: 'Solid', boundingBox: [5, 5, 0, 15, 15, 2], volume: 200, materialName: null },
          { key: input.inspectionId + ':Sink', name: 'Sink', type: 'Solid', boundingBox: [0, 0, 2, 30, 30, 12], volume: 9000, materialName: 'aluminum' }], diagnostics: [] }
      const projectPath = await write(input.outputDir, 'Imported.aedt', 'imported-geometry')
      const catalogPath = await write(input.outputDir, 'objects.json', catalog)
      return { status: 'ok', operation: 'inspect_cad', inputSha256: input.sourceSha256, catalog, projectPath, environment: env,
        artifacts: [{ role: 'IMPORTED_PROJECT', path: controls.badPath ? await write(home, 'outside.aedt', 'unsafe') : projectPath }, { role: 'OBJECT_CATALOG', path: catalogPath }] }
    },
    async prepareModel(input, options) {
      controls.calls.push({ method: 'prepare', input }); await wait(options)
      const projectPath = await write(input.outputDir, 'ThermalModel.aedt', { spec: input.spec, generated: true })
      return { status: 'ok', operation: 'prepare_model', inputSha256: input.projectSha256, specSha256: input.specSha256, projectPath, environment: env,
        artifacts: [{ role: 'GENERATED_PROJECT', path: projectPath }, { role: 'PREPARATION_EVIDENCE', path: await write(input.outputDir, 'preparation.json', { specSha256: input.specSha256 }) }] }
    },
    async validateModel(input, options) {
      controls.calls.push({ method: 'validate', input }); await wait(options)
      if (controls.failedValidation) throw new Error('persisted material readback mismatch')
      const result = { status: 'ok', operation: 'validate_model', inputSha256: input.projectSha256, specSha256: input.specSha256, environment: env,
        validation: { verified: true, selfContained: true, meshGenerated: true, design: 'IcepakDesign1', setup: 'ThermalBaseline', checks: ['persistedModelSpec'], actual: { testDouble: true } }, artifacts: [] }
      const evidencePath = await write(input.outputDir, 'validation.json', result)
      result.artifacts = [{ role: 'VALIDATION_EVIDENCE', path: evidencePath }, { role: 'MESH_STATS', path: await write(input.outputDir, 'mesh.txt', 'test mesh statistics') }]
      return result
    },
    async solveProject(input, options) {
      controls.calls.push({ method: 'solve', input }); await wait(options)
      const projectPath = await write(input.outputDir, 'ThermalModel.aedt', 'solved-project')
      return { status: 'ok', mode: 'solve', inputSha256: digest(await readFile(input.projectPath)), workingProject: projectPath,
        project: { name: 'ThermalModel', activeDesign: 'IcepakDesign1', aedtVersion: '2024.2', setups: ['ThermalBaseline'], monitors: ['CPU'], nativeComponents: [], boundaries: [], objects: ['CPU', 'Sink'] },
        validation: { verified: true, checks: [] }, solve: { attempted: true, succeeded: true, setup: 'ThermalBaseline' },
        artifacts: { projectPath }, metrics: { tmaxC: 65, converged: true, solverNormalCompletion: true } }
    },
  }
  const app = createCoreApp({ home, pluginClient: plugin, startAgentRuntime: false, startRemoteSolve: false, discoveryOptions: { multicast: false } })
  app.server.listen(0, '127.0.0.1'); await new Promise(done => app.server.once('listening', done))
  const base = `http://127.0.0.1:${app.server.address().port}`
  let task = app.database.listTasks().find(t => t.title === 'CAD 基础案例')
  if (!task) {
    const artifact = await app.artifacts.putBytes(Buffer.from('STEP TEST DOUBLE'), 'sample.step', 'application/octet-stream')
    app.database.upsertArtifact(artifact)
    task = app.database.createTask(createTask({ title: 'CAD 基础案例', description: 'CAD 创建自然对流基础案例', ownerNodeId: app.nodeIdentity.nodeId,
      requirementSnapshot: { intakeVersion: 2, modelKind: 'CAD', modelSha256: artifact.sha256, selectedOptimizationSkillIds: [] } }))
  }
  const path = `/api/tasks/${task.id}`
  async function request(suffix, value, method = 'POST') {
    const response = await fetch(base + path + suffix, value === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
    const body = await response.json()
    return { response, body }
  }
  return { app, home, base, task, path, request, controls, close: async (remove = true) => { await app.close(); if (remove) await rm(home, { recursive: true, force: true }) } }
}
export async function waitModel(f, jobId) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const context = (await f.request('/model-preparations')).body
    const job = context.jobs.find(j => j.id === jobId)
    if (job && !['QUEUED', 'RUNNING'].includes(job.status)) return { context, job }
    await new Promise(done => setTimeout(done, 15))
  }
  throw new Error('model operation timed out')
}
export function confirmSpec(spec) {
  spec.author = '工程师'; spec.reason = '核对材料、功率和安装工况'; spec.contactNotes = 'CPU 与散热器直接接触，按理想接触建模，无导热垫。'
  spec.dimensionsConfirmed = true; spec.assumptionsConfirmed = true
  for (const value of Object.values(spec)) if (value && typeof value === 'object' && 'confirmed' in value) value.confirmed = true
  spec.objects.forEach((o, i) => { o.role = i === 0 ? 'HEAT_SOURCE' : 'HEATSINK'; o.material = { value: i === 0 ? 'silicon' : 'aluminum', source: 'USER_INPUT', reference: '工程材料表', confirmed: true }; o.powerW = { value: i === 0 ? 10 : 0, source: 'USER_INPUT', reference: '额定工况', confirmed: true }; o.monitor = true })
  return spec
}
