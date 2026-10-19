import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreApp } from '@thermal-agent/core'
import { createTask } from '@thermal-agent/domain'

export const parameters = [
  { id: 'variable:FinGap', label: 'FinGap', adapter: 'variable', target: 'FinGap', currentValue: '2mm', unit: 'mm', role: 'unclassified', min: 0.000001, fingerprint: 'fin-baseline' },
  { id: 'material:HeatSink', label: 'HeatSink', adapter: 'material', target: 'HeatSink', currentValue: 'aluminum', unit: '', role: 'design', choices: ['aluminum', 'copper'], fingerprint: 'material-baseline' },
  { id: 'boundary-power:CPU', label: 'CPU', adapter: 'boundary-power', target: 'CPU', currentValue: '20W', unit: 'W', role: 'operating-condition', min: 0, fingerprint: 'power-baseline' },
  { id: 'fan:Fan1', label: 'Fan1', adapter: 'fan', target: 'Fan1', currentValue: '1', unit: '', role: 'design', min: 1, max: 1.5, fingerprint: 'fan-baseline' },
]
export const catalog = { schemaVersion: 1, variables: [], materials: [], boundaries: [], fans: [], setups: ['Setup1'], diagnostics: [], editableParameters: parameters }
const project = { name: 'ThermalModel', aedtVersion: '2024.2', activeDesign: 'IcepakDesign1', designs: ['IcepakDesign1'], setups: ['Setup1'], boundaries: [], nativeComponents: [], monitors: ['CPU'], objects: ['HeatSink'] }
export async function waitFor(fn) {
  const end = Date.now() + 5000
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 15)) }
  throw new Error('timed out waiting for parameter operation')
}
export async function parameterApp() {
  const home = await mkdtemp(join(tmpdir(), 'thermal-parameters-'))
  const source = join(home, 'ThermalModel.aedt')
  await writeFile(source, 'baseline-input')
  const calls = []
  const plugin = {
    failCheck: false, failSolve: false, checkDelay: 0,
    async probeEnvironment() { return { pluginId: 'icepak-pyaedt', pluginVersion: '0.2.0', status: 'UNAVAILABLE', platform: 'darwin', aedtVersions: [], checks: [], diagnostics: [] } },
    async inspectProject() { return { status: 'ok', project, parameterCatalog: catalog, validation: { verified: true, checks: [] } } },
    async checkChanges(input) {
      calls.push({ kind: 'check', input })
      if (plugin.checkDelay) await new Promise(r => setTimeout(r, plugin.checkDelay))
      if (plugin.failCheck) throw new Error('persisted parameter verification failed: FinGap')
      await mkdir(input.outputDir, { recursive: true })
      const verifiedProjectPath = join(input.outputDir, 'ThermalModel.aedt')
      await writeFile(verifiedProjectPath, JSON.stringify({ modified: input.changes }))
      return { status: 'ok', mode: 'check-changes', project, inputSha256: createHash('sha256').update(await readFile(input.projectPath)).digest('hex'), validation: { verified: true, checks: ['persistedParameters'] }, verifiedProjectPath,
        actionResults: input.changes.map(c => ({ parameterId: c.parameter.id, target: c.parameter.target, before: c.parameter.currentValue, after: c.value, verifiedAfter: c.value, verified: true })) }
    },
    async solveProject(input, options) {
      calls.push({ kind: 'solve', input, bytes: await readFile(input.projectPath, 'utf8') })
      if (plugin.failSolve) throw new Error('test solver failed after successful parameter verification')
      options?.onProgress?.('solving')
      await mkdir(input.outputDir, { recursive: true })
      const projectPath = join(input.outputDir, 'ThermalModel.aedt')
      const text = await readFile(input.projectPath, 'utf8')
      await writeFile(projectPath, text === 'baseline-input' ? 'baseline-solved' : text)
      const tmaxC = input.baselineMetrics ? 78 : 95
      return { status: 'ok', mode: 'solve', project, workingProject: projectPath, parameterCatalog: catalog,
        validation: { verified: true, checks: [] }, solve: { setup: 'Setup1', succeeded: true, attempted: true },
        artifacts: { projectPath }, metrics: { tmaxC, converged: true, solverNormalCompletion: true },
        ...(input.baselineMetrics ? { comparison: { deltaTmaxC: -17, rollbackRequired: false } } : {}) }
    },
    fanCheck() { throw new Error('unexpected legacy fanCheck') },
    fanSolve() { throw new Error('generic candidate must not use legacy fanSolve') },
  }
  const app = createCoreApp({ home, pluginClient: plugin, startAgentRuntime: false, startRemoteSolve: false,
    discoveryOptions: { multicast: false } })
  app.server.listen(0, '127.0.0.1'); await new Promise(r => app.server.once('listening', r))
  const base = `http://127.0.0.1:${app.server.address().port}`
  const task = app.database.createTask(createTask({ title: '控制器散热验证', description: '调整鳍片间距与散热器材料，追溯热点改善情况。', ownerNodeId: app.nodeIdentity.nodeId,
    requirementSnapshot: { targetTmaxC: 85, modelOriginalName: 'ThermalModel.aedt', projectName: '控制器 R2', workCondition: '环境温度 30 °C，CPU 20 W' } }))
  app.database.transitionTask(task.id, 'READY', task.version)
  async function request(path, value) {
    const response = await fetch(base + path, value === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
    return { response, body: await response.json() }
  }
  await request(`/api/tasks/${task.id}/runs/baseline`, { projectPath: source, design: 'IcepakDesign1', setup: 'Setup1', cores: 4 })
  await waitFor(() => app.database.getTask(task.id).executionStatus === 'WAITING_FOR_APPROVAL')
  const context = (await request(`/api/tasks/${task.id}/parameters`)).body
  return { app, base, home, source, task, context, request, plugin, calls,
    async close() { await app.close(); await rm(home, { recursive: true, force: true }) } }
}
