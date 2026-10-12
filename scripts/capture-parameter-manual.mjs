// Capture actual App UI against an isolated demonstration solver. No real AEDT results.
// Run after pnpm build. PLAYWRIGHT_MODULE can point to an existing installation.
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parameterApp, waitFor } from '../tests/fixtures/parameter-app.mjs'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const fixture = await parameterApp()
const browser = await chromium.launch({ headless: true })
const output = resolve('docs/manual/assets')
const page = await browser.newPage({ viewport: { width: 1600, height: 1400 }, deviceScaleFactor: 2 })
const captures = []
async function shot(name, locator, targets = []) {
  await locator.scrollIntoViewIfNeeded()
  const box = page.viewportSize()
  const tips = []
  for (const target of targets) {
    const bounds = await target.boundingBox()
    if (!bounds || bounds.y < 0 || bounds.y + bounds.height > box.height) {
      throw new Error(`Tooltip target is outside the App screenshot: ${name}`)
    }
    tips.push({ x: +((bounds.x + bounds.width - 8) / box.width * 100).toFixed(1),
      y: +((bounds.y + 8) / box.height * 100).toFixed(1) })
  }
  // Keep the complete App viewport, including navigation and task context.
  await page.screenshot({ path: `${output}/${name}`, animations: 'disabled' })
  captures.push({ name, width: box.width, height: box.height, tips })
}
try {
  await mkdir(output, { recursive: true })
  await page.goto(fixture.base)
  await page.getByRole('button', { name: fixture.task.title, exact: true }).first().click()
  const workspace = page.getByRole('region', { name: '参数修改与追溯' })
  await workspace.getByLabel('选择参数').selectOption('variable:FinGap')
  await workspace.getByRole('button', { name: '添加', exact: true }).click()
  await workspace.getByLabel('FinGap 目标值').fill('1.5mm')
  await workspace.getByLabel('FinGap 参数用途').selectOption('design')
  await workspace.getByLabel('选择参数').selectOption('material:HeatSink')
  await workspace.getByRole('button', { name: '添加', exact: true }).click()
  await workspace.getByLabel('目标值', { exact: true }).selectOption('copper')
  await workspace.getByLabel(/记录人/).fill('王工')
  await workspace.getByLabel(/修改原因/).fill('对比鳍片间距与散热器材料方案，维持原功耗与环境温度；铜材重量和成本需单独复核。')
  await shot('11-parameter-edit.png', workspace.locator('.parameter-editor'), [
    workspace.getByLabel('选择参数'), workspace.getByLabel('FinGap 目标值'), workspace.getByRole('button', { name: '保存新版本并验证' })])
  await workspace.getByRole('button', { name: '保存新版本并验证' }).click()
  await workspace.getByRole('button', { name: '执行 v1 候选求解' }).waitFor()
  await workspace.getByRole('button', { name: '复制为新版本' }).click()
  await workspace.getByLabel('FinGap 目标值').fill('1.2mm')
  await workspace.getByLabel(/修改原因/).fill('保留铜材，将鳍片间距调整为 1.2 mm，与 v1 对比；两版均基于原 Baseline。')
  await workspace.getByRole('button', { name: '保存新版本并验证' }).click()
  await workspace.getByRole('button', { name: '执行 v2 候选求解' }).waitFor()
  await workspace.getByLabel('与其他版本比较').selectOption(fixture.app.database.listParameterPlans(fixture.task.id).find(p => p.revision === 1).id)
  await shot('12-parameter-history.png', workspace.locator('.parameter-history'), [
    workspace.getByLabel('与其他版本比较'), workspace.getByRole('button', { name: '复制为新版本' }), workspace.getByRole('button', { name: '执行 v2 候选求解' })])
  await workspace.getByRole('button', { name: '执行 v2 候选求解' }).click()
  await waitFor(() => fixture.app.database.getTask(fixture.task.id).thermalVerdict === 'PASS')
  await workspace.getByText(/最高温度 78 °C/).waitFor({ timeout: 15000 })
  // The task sidebar refreshes separately from parameter results.
  await page.locator('.task-detail-aside').getByText('PASS', { exact: true }).waitFor({ timeout: 15000 })
  await workspace.getByLabel('与其他版本比较').selectOption('')
  await workspace.getByText('基准、工程与证据标识', { exact: true }).click()
  await shot('13-parameter-evidence.png', workspace.locator('.parameter-version').first(), [
    workspace.locator('.parameter-outcome').first(), workspace.getByRole('link', { name: '下载验证证据' }), workspace.getByRole('button', { name: '导出此版本' })])
  await workspace.getByLabel('选择参数').selectOption('boundary-power:CPU')
  await workspace.getByRole('button', { name: '添加', exact: true }).click()
  await workspace.getByLabel('CPU 目标值').fill('15W')
  await workspace.getByLabel(/修改原因/).fill('评估 CPU 15 W 工况，创建独立 Baseline；该结果不作为散热结构优化降温收益。')
  await shot('14-condition-edit.png', workspace.locator('.parameter-editor'), [workspace.getByLabel('CPU 目标值'), workspace.locator('.parameter-purpose')])
  await workspace.getByRole('button', { name: '保存新版本并验证' }).click()
  await workspace.getByRole('button', { name: '创建并求解 v3 新工况' }).waitFor()
  await workspace.getByRole('button', { name: '创建并求解 v3 新工况' }).click()
  await workspace.getByRole('button', { name: '打开工况任务' }).waitFor()
  await shot('15-condition-link.png', workspace.locator('.parameter-version').first(), [workspace.getByRole('button', { name: '打开工况任务' })])
  await workspace.getByRole('button', { name: '打开工况任务' }).click()
  await page.getByRole('heading', { name: `${fixture.task.title} · 工况 v3` }).waitFor()
  await workspace.getByRole('button', { name: '查看来源任务与修改记录' }).waitFor()
  await shot('16-condition-task.png', workspace, [workspace.getByRole('button', { name: '查看来源任务与修改记录' })])
  const manifest = { environment: 'Actual App UI with isolated demonstration solver; temperatures are illustrative, not AEDT evidence.', captures }
  await mkdir(resolve('.thermal-agent/screenshots/manual'), { recursive: true })
  await writeFile(resolve('.thermal-agent/screenshots/manual/captures.json'), JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify(manifest))
} finally { await browser.close(); await fixture.close() }
