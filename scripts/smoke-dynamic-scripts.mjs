// Browser + real Core routes, fake engineering port. Never native AEDT evidence.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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
  assert.deepEqual(errors, [])
  console.log('Dynamic script UI: task context, parameter entry, two executions and persisted test-double results passed.')
} finally { await browser?.close(); await app.close(); await rm(home, { recursive: true, force: true }) }
