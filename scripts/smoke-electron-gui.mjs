import { app, BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const origin = process.env.THERMAL_AGENT_ORIGIN ?? 'http://127.0.0.1:43110'
const output = resolve(process.env.THERMAL_AGENT_SCREENSHOT ?? '.thermal-agent/screenshots/workbench.png')
const startupTimeoutMs = Number(process.env.THERMAL_AGENT_GUI_TIMEOUT_MS ?? 20_000)
const startupWatchdog = setTimeout(() => {
  console.error(`Electron did not complete the GUI smoke test within ${startupTimeoutMs}ms`)
  app.exit(1)
}, startupTimeoutMs)

await app.whenReady()
const window = new BrowserWindow({
  width: 1440,
  height: 960,
  show: false,
  webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
})

try {
  await window.loadURL(origin)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript("document.body.innerText.includes('散热仿真工作台')")
    if (ready) break
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  const image = await window.webContents.capturePage()
  await mkdir(resolve(output, '..'), { recursive: true })
  await writeFile(output, image.toPNG())
  console.log(output)
} finally {
  clearTimeout(startupWatchdog)
  window.destroy()
  app.quit()
}
