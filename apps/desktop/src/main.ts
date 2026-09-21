import { spawn, type ChildProcess } from 'node:child_process'
import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, Tray } from 'electron'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { resolveDesktopRuntimePaths, validatePackagedRuntime } from './runtime-paths.js'
import { terminateProcessTree } from '@thermal-agent/process-control'
import { createTrayIconPng } from './tray-icon.js'

let coreOrigin = ''
let window: BrowserWindow | undefined
let tray: Tray | undefined
let coreProcess: ChildProcess | undefined
let creatingWindow: Promise<void> | undefined

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
  if (app.isPackaged) validatePackagedRuntime(paths)
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
      ...(paths.icepakPython ? { THERMAL_ICEPAK_PYTHON: paths.icepakPython } : {}),
      THERMAL_REPORT_PLUGIN_ROOT: paths.reportPluginRoot,
      ...(paths.reportPython ? { THERMAL_REPORT_PYTHON: paths.reportPython } : {}),
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

async function showWindow(): Promise<void> {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    return
  }
  if (creatingWindow) return creatingWindow
  creatingWindow = (async () => {
    if (!coreOrigin) {
      coreOrigin = `http://127.0.0.1:${await availablePort()}`
      startCore()
    }
    await waitForCore()
    const next = new BrowserWindow({
      width: 1380,
      height: 900,
      minWidth: 960,
      minHeight: 680,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#f4f4f4',
      title: 'Thermal Agent',
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    window = next
    next.on('closed', () => { if (window === next) window = undefined })
    next.setMenuBarVisibility(false)
    try {
      await next.loadURL(coreOrigin)
      if (!next.isDestroyed()) next.show()
    } catch (error) {
      if (!next.isDestroyed()) next.destroy()
      throw error
    }
  })().finally(() => { creatingWindow = undefined })
  return creatingWindow
}

function openWindow(): void {
  void showWindow().catch(error => {
    console.error(error)
    dialog.showErrorBox('Thermal Agent 工作台无法打开', error instanceof Error ? error.message : String(error))
  })
}

function createTray(): void {
  const icon = nativeImage.createFromBuffer(createTrayIconPng())
  if (icon.isEmpty()) throw new Error('托盘图标无法加载')
  tray = new Tray(icon)
  tray.setToolTip('Thermal Agent · 后台任务运行中')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开工作台', click: openWindow },
    { type: 'separator' },
    { label: '退出应用', click: () => app.quit() },
  ]))
  tray.on('double-click', openWindow)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', openWindow)
  app.whenReady().then(async () => {
    createTray()
    await showWindow()
  }).catch(error => {
    console.error(error)
    dialog.showErrorBox('Thermal Agent 无法启动', error instanceof Error ? error.message : String(error))
    app.quit()
  })
}

app.on('window-all-closed', () => {
  // The Core, DSH Host and any active Icepak task keep running in the tray.
})

app.on('activate', openWindow)

app.on('before-quit', () => {
  tray?.destroy()
  if (coreProcess) terminateProcessTree(coreProcess)
})
