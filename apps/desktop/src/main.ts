import { spawn, type ChildProcess } from 'node:child_process'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { join, resolve } from 'node:path'

const coreOrigin = 'http://127.0.0.1:43110'
let window: BrowserWindow | undefined
let coreProcess: ChildProcess | undefined

async function coreIsReady(): Promise<boolean> {
  try {
    const response = await fetch(`${coreOrigin}/api/health`, { signal: AbortSignal.timeout(500) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForCore(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await coreIsReady()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 150))
  }
  throw new Error('本地 Core 启动超时')
}

function startCore(): void {
  const projectRoot = resolve(app.getAppPath(), '../..')
  const entry = join(projectRoot, 'apps', 'core', 'dist', 'cli.js')
  coreProcess = spawn(process.execPath, [entry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      THERMAL_AGENT_HOME: join(app.getPath('userData'), 'runtime'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  coreProcess.stdout?.on('data', data => process.stdout.write(data))
  coreProcess.stderr?.on('data', data => process.stderr.write(data))
}

async function createWindow(): Promise<void> {
  if (!await coreIsReady()) startCore()
  await waitForCore()
  window = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#f4f4f4',
    title: 'Thermal Agent',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.setMenuBarVisibility(false)
  await window.loadURL(coreOrigin)
}

app.whenReady().then(createWindow).catch(error => {
  console.error(error)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  coreProcess?.kill('SIGTERM')
})
