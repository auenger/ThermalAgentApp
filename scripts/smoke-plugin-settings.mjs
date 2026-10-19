// Run after pnpm build. Uses an isolated client home and an intentionally offline update source.
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createCoreApp } from '../apps/core/dist/server.js'
import { PluginHost } from '../apps/core/dist/plugin-host.js'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const home = await mkdtemp(join(tmpdir(), 'thermal-plugin-ui-'))
let networkCalls = 0
const plugins = new PluginHost(join(home, 'plugins'), {
  updateSources: () => [{ id: 'company', url: 'https://updates.test/index.json' }],
  fetchUpdates: async () => { networkCalls++; throw new TypeError('offline fixture') },
})
const app = createCoreApp({ home, pluginHost: plugins, startAgentRuntime: false, startRemoteSolve: false })
let browser
try {
  await plugins.reconcile()
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  // UI-only status fixture; real asset downloads, rebuilds and collection use Node integration tests.
  await page.route('**/api/plugin-runtime', async route => {
    const response = await route.fetch(), value = await response.json()
    value.repairCandidates = { candidates: [{ id: 'ui-fixture', pluginId: 'report-reportlab', version: '0.1.1', reason: 'UI candidate fixture', createdAt: '2026-10-19T00:00:00Z', basePackageDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64), changes: [{ path: 'python/adapter.py', sha256: 'c'.repeat(64) }] }], errors: [] }
    value.repairJobs = { jobs: [{ id: 'ui-job', state: 'stopping', startedAt: 1_000 }], error: 'UI repair cancellation fixture' }
    value.executionFailures = [{ packageDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64), method: 'inspect_project', code: 'ATTRIBUTEERROR', detail: 'UI compatibility evidence fixture', observedAt: '2026-10-19T00:00:00Z' }]
    value.executionEvidenceError = 'UI evidence persistence fixture'
    value.runtimeRepairs = [{ key: 'ui-fixture', packageDigest: 'a'.repeat(64), status: 'prepared',
      detectedAt: '2026-10-19T00:00:00Z', reason: 'UI fixture: dependency file changed; not an AEDT validation certificate' }]
    value.runtimeStorage = { checkedAt: '2026-10-19T00:00:00Z', removed: ['ui-fixture-removed'],
      retained: [{ directory: 'ui-fixture-retained', reason: 'saved workflow or readiness reference' }] }
    value.runtimes[0].retry = { consecutiveFailures: 2, nextRetryAt: '2026-10-19T00:05:00Z', reason: 'UI retry fixture' }
    value.runtimes[0].aedtBindings = { repairs: [{ variable: 'ANSYSEM_ROOT261', path: 'C:/Program Files/ANSYS Inc/v261/AnsysEM' }], diagnostics: [] }
    value.updates = { ...value.updates, assetDownloaded: 1, assetCached: 3, assetBytes: 34 * 1024 * 1024 }
    await route.fulfill({ response, json: value })
  })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${app.server.address().port}`)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.locator('#plugin-runtime-settings')
  await settings.getByText(/获取失败，保留本地可用版本/).waitFor()
  await settings.getByText(/company · 新包 0/).waitFor()
  await settings.getByText(/新的仿真候选暂不自动启用/).waitFor()
  await settings.getByText('依赖环境：App 基础运行时').first().waitFor()
  const receipts = settings.locator('details').filter({ has: page.locator(':scope > summary', { hasText: '最近验证记录' }) })
  assert.ok(await receipts.count() >= 1)
  await receipts.first().locator(':scope > summary').click()
  await receipts.first().locator('details > summary').first().click()
  await receipts.first().getByText(/插件摘要：/).first().waitFor()
  const automatic = settings.getByRole('switch', { name: '自动获取并选择兼容版本' })
  assert.equal(await automatic.isChecked(), true)
  const repairSwitch = settings.getByRole('switch', { name: '故障后自动请求模型生成修复候选' })
  assert.equal(await repairSwitch.isChecked(), false)
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/plugin-runtime/policy')), repairSwitch.click()])
  assert.equal(plugins.status().automaticRepair, true)
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/plugin-runtime/policy')), repairSwitch.click()])
  assert.equal(plugins.status().automaticRepair, false)
  await settings.getByText('自动修复任务（1）', { exact: true }).click()
  await settings.getByText(/正在停止/).waitFor()
  await settings.getByText(/UI repair cancellation fixture/).waitFor()
  await settings.getByText('业务兼容性故障（1）', { exact: true }).click()
  await settings.getByText('UI compatibility evidence fixture', { exact: true }).waitFor()
  await settings.getByText(/业务故障记录失败，自动模型修复已暂停/).waitFor()
  let releaseCheck
  const checking = new Promise(resolve => { releaseCheck = resolve })
  await page.route('**/api/plugin-runtime/reconcile', async route => { await checking; await route.continue() })
  await settings.getByRole('button', { name: '立即检查环境与插件' }).click()
  await settings.getByRole('button', { name: '正在处理…' }).waitFor()
  assert.equal(await automatic.isEnabled(), true, 'policy cancellation stays available during a manual check')
  try { await automatic.click() } finally { releaseCheck() }
  await settings.getByRole('button', { name: '立即检查环境与插件' }).waitFor()
  await page.unroute('**/api/plugin-runtime/reconcile')
  assert.equal(await automatic.isChecked(), false)
  const before = networkCalls
  await settings.getByRole('button', { name: '立即检查环境与插件' }).click()
  await settings.getByText(/自动获取已关闭/).waitFor()
  assert.equal(networkCalls, before)
  assert.equal(plugins.status().automaticUpdates, false)
  await settings.getByText('依赖环境重建记录', { exact: true }).click()
  await settings.getByText(/环境已重新准备/).waitFor()
  await settings.getByText('依赖环境存储', { exact: true }).click()
  await settings.getByText(/历史作业或就绪证据仍有引用/).waitFor()
  await settings.getByText(/依赖资产：已下载 1 个/).waitFor()
  await settings.getByText(/连续失败 2 次/).waitFor()
  await settings.getByText('本机启动路径适配（1）', { exact: true }).click()
  await settings.getByText(/已为插件进程补齐安装路径/).waitFor()
  await settings.getByText('修复候选（1）', { exact: true }).click()
  await settings.getByText(/以下候选仅已存档/).waitFor()
  await settings.getByText(/v0.1.1 · 等待隔离验证/).click()
  await settings.getByText('UI candidate fixture', { exact: true }).waitFor()
  const directory = resolve('.thermal-agent/screenshots/plugin-settings')
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: join(directory, 'desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 375, height: 812 })
  assert.equal(await settings.evaluate(element => element.scrollWidth > element.clientWidth + 1), false)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ success: true, covered: ['source diagnostics', 'engineering policy status', 'validation evidence', 'policy switch', 'separate repair policy', 'repair cancellation status', 'disabled network', 'runtime retention history', 'asset transfer progress', '375px'] }))
} finally { await browser?.close(); await app.close(); await rm(home, { recursive: true, force: true }) }
