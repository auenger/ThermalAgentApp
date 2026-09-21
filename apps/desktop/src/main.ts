import { spawn, type ChildProcess } from 'node:child_process'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { resolveDesktopRuntimePaths } from './runtime-paths.js'

let coreOrigin = ''
let window: BrowserWindow | undefined
let coreProcess: ChildProcess | undefined

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('无法分配本地 Core 端口')); return }
      server.close(() => resolvePort(address.port))
    })
  })
}

async function coreIsReady(): Promise<boolean> {
  try {
    const response = await fetch(`${coreOrigin}/api/health`, { signal: AbortSignal.timeout(500) })
    if (!response.ok) return false
    const body = await response.json() as { service?: string }
    return body.service === 'thermal-agent-core'
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
  const paths = resolveDesktopRuntimePaths({
    appPath: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged,
    nodeOverride: process.env.THERMAL_AGENT_NODE_BIN,
  })
  const port = new URL(coreOrigin).port
  coreProcess = spawn(process.execPath, [paths.coreEntry], {
    cwd: paths.workingDirectory,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      THERMAL_AGENT_HOME: join(app.getPath('userData'), 'runtime'),
      THERMAL_AGENT_HOST: '127.0.0.1',
      THERMAL_AGENT_PORT: port,
      THERMAL_AGENT_WEB_ROOT: paths.webRoot,
      THERMAL_ICEPAK_PLUGIN_ROOT: paths.icepakPluginRoot,
      THERMAL_AGENT_DSH_PLUGIN: paths.dshPlugin,
      ...(paths.dshCli ? { THERMAL_AGENT_DSH_CLI: paths.dshCli } : {}),
      ...(paths.nodeBin ? { THERMAL_AGENT_NODE_BIN: paths.nodeBin } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  coreProcess.stdout?.on('data', data => process.stdout.write(data))
  coreProcess.stderr?.on('data', data => process.stderr.write(data))
}

async function createWindow(): Promise<void> {
  coreOrigin = `http://127.0.0.1:${await availablePort()}`
  startCore()
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
