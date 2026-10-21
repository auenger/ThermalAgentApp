import assert from 'node:assert/strict'
import { createCoreApp } from '../apps/core/dist/server.js'
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const home = await mkdtemp(join(tmpdir(), 'thermal-dsh-navigation-'))
const app = createCoreApp({ home, startRemoteSolve: false, pluginClient: {
  probeEnvironment: async () => ({ status: 'NOT_INSTALLED', platform: process.platform, aedtVersions: [], capabilities: [], diagnostics: [] }),
} })
let browser
try {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${app.server.address().port}`
  let status
  const deadline = Date.now() + 30_000
  do {
    status = (await (await fetch(`${base}/api/agent/status`)).json()).agent
    if (status.phase === 'failed') throw new Error(status.detail)
    if (status.phase === 'ready') break
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  assert.equal(status.phase, 'ready')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(status.url)
  await page.waitForFunction(() => window.thermalDsh?.protocol === 1)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await page.getByRole('button', { name: 'Add API Key', exact: true }).click()
  await page.getByRole('button', { name: 'Configure later', exact: true }).click()
  assert.equal(await page.evaluate(() => window.thermalDsh.openSettings()), true)
  await page.getByRole('button', { name: 'General', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  const created = await (await fetch(`${base}/api/agent/sessions`, { method: 'POST' })).json()
  let requested = false
  page.on('request', request => { if (request.postData()?.includes(created.sessionId) || request.url().includes(created.sessionId)) requested = true })
  assert.equal(await page.evaluate(id => window.thermalDsh.openSession(id), created.sessionId), true)
  for (let i = 0; i < 100 && !requested; i++) await page.waitForTimeout(100)
  assert.ok(requested, 'Opening a session must load that session through the official client service')
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.getByRole('button', { name: 'Add plugin', exact: true }).click()
  const fixtureDir = join(home, 'fixture plugin with spaces')
  await mkdir(fixtureDir)
  await writeFile(join(fixtureDir, 'package.json'), JSON.stringify({ name: 'thermal-navigation-fixture', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(fixtureDir, 'cordis.patch.yml'), "- insert:\n    - id: thermal-navigation-fixture\n      name: thermal-navigation-fixture\n")
  await writeFile(join(fixtureDir, 'index.js'), "import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; export function apply(){writeFileSync(join(process.env.DSH_HOME, 'thermal-plugin-fixture-loaded'), 'loaded')}\n")
  await page.getByRole('textbox', { name: 'Package name or address' }).fill(fixtureDir)
  await page.getByRole('button', { name: 'Install', exact: true }).click()
  await page.getByRole('button', { name: 'Enable now', exact: true }).click()
  let installed = false
  for (let i = 0; i < 600; i++) {
    try { await access(join(home, 'dsh', 'thermal-plugin-fixture-loaded')); installed = true; break } catch {}
    await page.waitForTimeout(100)
  }
  assert.ok(installed, 'Installed local plugin must execute after being enabled')
  assert.deepEqual(errors, [])
  await page.goto(base)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('heading', { name: 'DSH 引擎更新', exact: true }).waitFor()
  assert.ok(await page.getByText('0.2.1-rc.2', { exact: false }).count())
  console.log('DSH native client plugin: onboarding, settings, session navigation, local plugin installation from a path with spaces, plugin execution and App runtime settings passed.')
} finally { await browser?.close(); await app.close(); await rm(home, { recursive: true, force: true }) }
