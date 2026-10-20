// Browser + real Core routes, fake engineering port. Never native AEDT evidence.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCoreApp } from '../apps/core/dist/server.js'
import { createTask } from '../packages/domain/dist/index.js'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const home = await mkdtemp(join(tmpdir(), 'thermal-dynamic-ui-'))
let artifact
const plugin = {
  async probeEnvironment() { return { pluginId: 'ui-fixture', pluginVersion: '1', status: 'NOT_INSTALLED', aedtVersions: [], checks: [], diagnostics: [], platform: process.platform } },
  async inspectProject(input) { return { status: 'ok', inputSha256: artifact.sha256, project: { aedtVersion: input.version, objects: ['Chip'] } } },
  async solveProject(input) {
    const bytes = await readFile(input.projectPath), power = Number(bytes.toString().split('=')[1])
    const dir = join(input.outputDir, 'artifacts'); await mkdir(dir, { recursive: true })
    const projectPath = join(dir, 'project.aedt'), convergencePath = join(dir, 'convergence.json')
    await writeFile(projectPath, bytes)
    await writeFile(convergencePath, JSON.stringify({ schemaVersion: 'icepak-convergence-v1', setup: input.setup, evidence: { verified: true }, nativeEvidencePaths: {}, rawFileSha256: {} }))
    return { status: 'ok', mode: 'solve', inputSha256: createHash('sha256').update(bytes).digest('hex'), project: { aedtVersion: input.version, activeDesign: 'Icepak' },
      validation: { verified: true }, solve: { succeeded: true, setup: input.setup }, metrics: { solverNormalCompletion: true, converged: true, tmaxC: 40 + power },
      artifacts: { projectPath, outputSha256: createHash('sha256').update(bytes).digest('hex'), convergencePath } }
  },
  async executeScript(input) {
    const verifiedProjectPath = join(input.outputDir, 'verified', 'project.aedt'), bytes = Buffer.from(`power=${input.parameters.power}`)
    await mkdir(join(input.outputDir, 'verified'), { recursive: true }); await writeFile(verifiedProjectPath, bytes)
    return { schemaVersion: 1, status: 'ok', inputSha256: input.projectSha256, scriptSha256: input.scriptSha256, parameters: input.parameters,
      scriptExecuted: true, persistedReadback: true, readbackEvidenceSource: 'script-reported-after-reopen', readback: { passed: true, checks: [{ actual: input.parameters.power }] },
      executionKind: 'test-double', verifiedProjectPath, verifiedProjectSha256: createHash('sha256').update(bytes).digest('hex') }
  },
}
const app = createCoreApp({ home, pluginClient: plugin, startAgentRuntime: false, startRemoteSolve: false })
let browser
try {
  artifact = await app.artifacts.putBytes(Buffer.from('original UI fixture'), 'fixture.aedt'); app.database.upsertArtifact(artifact)
  const task = app.database.createTask(createTask({ title: '动态热源操作验证', description: 'UI fixture', ownerNodeId: app.nodeIdentity.nodeId,
    requirementSnapshot: { modelSha256: artifact.sha256, aedtVersion: '2024.2', planConfirmed: true } }))
  const script = app.dynamicScripts.library.stage({ name: '调整芯片热源', version: '1', description: '动态脚本浏览器验证', source: '# UI fixture, no actual solver',
    parameters: { power: { type: 'number', description: '热源功率', required: true, unit: 'W', minimum: 0, maximum: 100 } },
    applicability: { aedtVersions: ['2024.2'], requiredObjects: ['Chip'] }, tags: ['heat'] })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(15000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${app.server.address().port}`)
  await page.getByRole('button', { name: task.title, exact: true }).first().click()
  const panel = page.locator('.dynamic-script-workspace')
  await panel.getByLabel('选择已保存脚本').selectOption(script.id)
  await panel.getByLabel('power (W) · 热源功率').fill('28')
  await panel.getByRole('button', { name: '在工程副本上执行', exact: true }).click()
  await panel.getByText('调整芯片热源 · 持久工程读回通过', { exact: true }).waitFor()
  await panel.getByText('测试替身记录，不代表真实 Icepak 验证。', { exact: true }).waitFor()
  await panel.getByLabel('power (W) · 热源功率').fill('32')
  await panel.getByRole('button', { name: '在工程副本上执行', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.dynamic-script-run strong')].filter(node => node.textContent.includes('持久工程读回通过')).length === 2)
  assert.deepEqual(app.dynamicScripts.library.runs(task.id).map(run => run.parameters.power), [28, 32])
  assert.equal(app.dynamicScripts.library.list().length, 1)
  const iteration = panel.locator('.script-iteration-panel')
  await iteration.getByText('设置参数范围与运行预算', { exact: true }).click()
  await iteration.getByLabel('自动调整 power', { exact: true }).check()
  await iteration.getByLabel('power 下限', { exact: true }).fill('0')
  await iteration.getByLabel('power 上限', { exact: true }).fill('60')
  await iteration.getByLabel('power 初始步长', { exact: true }).fill('10')
  await iteration.getByLabel('power 最小步长', { exact: true }).fill('1')
  await iteration.getByLabel('目标最高温度 (°C)', { exact: true }).fill('65')
  await iteration.getByLabel('求解 setup', { exact: true }).fill('Setup1')
  await iteration.getByRole('button', { name: '保存迭代计划', exact: true }).click()
  await iteration.getByText('待确认计划', { exact: true }).waitFor()
  assert.equal(app.dynamicScripts.library.iterations(task.id)[0].rounds.length, 0)
  await iteration.getByRole('button', { name: '确认范围与预算并启动求解', exact: true }).click()
  await iteration.getByText('达到设定目标', { exact: true }).waitFor()
  const completed = app.dynamicScripts.library.iterations(task.id)[0]
  assert.deepEqual(completed.rounds.map(round => round.parameters.power), [32, 42, 22])
  assert.equal(completed.bestRound, 3)
  await iteration.getByText('包含测试替身结果，不代表真实 Icepak 收敛。', { exact: true }).waitFor()
  const [download] = await Promise.all([page.waitForEvent('download'), panel.getByRole('button', { name: '校验并导出验收记录', exact: true }).click()])
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'))
  assert.equal(exported.acceptance, 'manual-review-required')
  assert.equal(exported.observations.nativeReadbacks, 0)
  assert.equal(exported.observations.testDoubleReadbacks, 5)
  assert.ok(exported.artifactChecks.every(item => item.verified))
  assert.deepEqual(errors, [])
  console.log('Dynamic script UI: task context, parameter entry, two executions, explicit bounded iteration approval, three solved rounds and persisted test-double results passed.')
} finally { await browser?.close(); await app.close(); await rm(home, { recursive: true, force: true }) }
