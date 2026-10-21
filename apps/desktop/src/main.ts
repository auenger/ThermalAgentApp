import { spawn, type ChildProcess } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDesktopRuntimePaths, validatePackagedRuntime } from './runtime-paths.js'
import { createTrayIconPng } from './tray-icon.js'
import { CoreProcessSupervisor, type CoreProcessState } from './core-process-supervisor.js'

let coreOrigin = ''
let window: BrowserWindow | undefined
let tray: Tray | undefined
let coreSupervisor: CoreProcessSupervisor | undefined
let creatingWindow: Promise<void> | undefined

async function dshFrame() {
  if (!window || window.isDestroyed()) throw new Error('桌面窗口尚未就绪')
  const response = await fetch(`${coreOrigin}/api/agent/status`)
  const body = await response.json() as { agent?: { phase?: string; url?: string } }
  if (!response.ok || body.agent?.phase !== 'ready' || !body.agent.url) throw new Error('DSH 对话尚未就绪')
  const origin = new URL(body.agent.url).origin
  const frame = window.webContents.mainFrame.frames.find(candidate => {
    try { return new URL(candidate.url).origin === origin } catch { return false }
  })
  if (!frame) throw new Error('请先打开散热 Agent 页面并等待对话加载')
  return frame
}

function assertDesktopSender(senderUrl: string): void {
  if (!senderUrl.startsWith(`${coreOrigin}/`)) throw new Error('桌面操作来源无效')
}

ipcMain.handle('thermal:locate-task-model', async (event, taskId: unknown, sha256: unknown) => {
  assertDesktopSender(event.senderFrame?.url ?? '')
  if (event.senderFrame !== window?.webContents.mainFrame) throw new Error('文件定位来源无效')
  if (typeof taskId !== 'string' || !/^[0-9a-f-]{36}$/u.test(taskId) ||
    (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)))) throw new Error('模型文件身份无效')
  const response = await fetch(`${coreOrigin}/api/tasks/${taskId}/model-files${sha256 ? `/${sha256}` : ''}/location`, { method: 'POST' })
  const body = await response.json() as { path?: string; kind?: string; error?: { message?: string } }
  if (!response.ok || !body.path) throw new Error(body.error?.message ?? '模型文件定位失败')
  if (body.kind === 'file') shell.showItemInFolder(body.path)
  else if (body.kind === 'directory') {
    const error = await shell.openPath(body.path)
    if (error) throw new Error(error)
  } else throw new Error('文件定位结果无效')
})

ipcMain.handle('thermal:dsh-open-session', async (event, value: unknown) => {
  assertDesktopSender(event.senderFrame?.url ?? '')
  if (typeof value !== 'string' || !/^session-[0-9a-f-]{36}$/iu.test(value)) throw new Error('会话 ID 无效')
  const response = await fetch(`${coreOrigin}/api/agent/sessions`)
  const body = await response.json() as { sessions?: Array<{ sessionId: string }> }
  if (!response.ok || !body.sessions?.some(item => item.sessionId === value)) throw new Error('该会话不属于当前工作目录')
  const frame = await dshFrame()
  await callDshNavigation(frame, 'openSession', value)
})

async function callDshNavigation(frame: Awaited<ReturnType<typeof dshFrame>>, method: 'openSession' | 'openSettings', sessionId?: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const accepted = await frame.executeJavaScript(`(() => {
      const api = window.thermalDsh;
      if (!api || api.protocol !== 1) return false;
      return api[${JSON.stringify(method)}](${JSON.stringify(sessionId)}) === true;
    })()`)
    if (accepted) return
    await new Promise(resolveWait => setTimeout(resolveWait, 120))
  }
  throw new Error('DSH 客户端插件尚未就绪或版本不兼容，请重启 Agent 后重试')
}

ipcMain.handle('thermal:dsh-open-settings', async event => {
  assertDesktopSender(event.senderFrame?.url ?? '')
  await callDshNavigation(await dshFrame(), 'openSettings')
})

// Retained for the current renderer preload contract; presentation belongs to DSH plugins.
ipcMain.handle('thermal:dsh-style-frame', async event => {
  assertDesktopSender(event.senderFrame?.url ?? '')
})

ipcMain.handle('thermal:set-title-bar-theme', (event, dark: unknown) => {
  assertDesktopSender(event.senderFrame?.url ?? '')
  if (process.platform === 'darwin' || !window || window.isDestroyed()) return
  if (typeof dark !== 'boolean') throw new Error('标题栏主题值无效')
  window.setTitleBarOverlay({ color: dark ? '#292a27' : '#f3f3ef', symbolColor: dark ? '#f1f1ed' : '#30312e', height: 48 })
})

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

function spawnCore(): ChildProcess {
  const paths = resolveDesktopRuntimePaths({
    appPath: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged,
    nodeOverride: process.env.THERMAL_AGENT_NODE_BIN,
  })
  if (app.isPackaged) validatePackagedRuntime(paths)
  const port = new URL(coreOrigin).port
  const coreProcess = spawn(process.execPath, [paths.coreEntry], {
    cwd: paths.workingDirectory,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      THERMAL_AGENT_HOME: join(app.getPath('userData'), 'runtime'),
      THERMAL_AGENT_HOST: '127.0.0.1',
      THERMAL_AGENT_PORT: port,
      THERMAL_AGENT_WEB_ROOT: paths.webRoot,
      THERMAL_ICEPAK_PLUGIN_ROOT: paths.icepakPluginRoot,
      THERMAL_ICEPAK_SAMPLE_PROJECT: paths.sampleProjectPath,
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
  return coreProcess
}

function onCoreState(state: CoreProcessState, detail?: string): void {
  if (state === 'restarting') {
    console.error(`Thermal Agent Core is restarting: ${detail ?? 'unexpected exit'}`)
    tray?.setToolTip('Thermal Agent · 后台服务正在恢复')
  } else if (state === 'restarted') {
    void waitForCore().then(() => {
      tray?.setToolTip('Thermal Agent · 后台任务运行中')
      if (window && !window.isDestroyed()) window.reload()
    }).catch(error => { console.error('Core restart health check failed', error) })
  } else {
    console.error(`Thermal Agent Core stopped after repeated failures: ${detail ?? ''}`)
    tray?.setToolTip('Thermal Agent · 后台服务已停止，打开工作台可重试')
  }
}

async function showWindow(): Promise<void> {
  coreSupervisor?.start()
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
      coreSupervisor = new CoreProcessSupervisor(spawnCore, onCoreState)
      coreSupervisor.start()
    }
    await waitForCore()
    const iconPaths = resolveDesktopRuntimePaths({
      appPath: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged,
    })
    const next = new BrowserWindow({
      icon: iconPaths.windowIconPath,
      width: 1380,
      height: 900,
      minWidth: 960,
      minHeight: 680,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#f4f4f4',
      title: 'Thermal Agent',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      ...process.platform !== 'darwin' && { titleBarOverlay: { color: '#f3f3ef', symbolColor: '#30312e', height: 48 } },
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: join(fileURLToPath(new URL('.', import.meta.url)), 'preload.cjs') },
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
  const paths = resolveDesktopRuntimePaths({
    appPath: app.getAppPath(), resourcesPath: process.resourcesPath, packaged: app.isPackaged,
  })
  const icon = process.platform === 'darwin'
    ? nativeImage.createFromPath(paths.trayIconPath)
    : nativeImage.createFromBuffer(createTrayIconPng(paths.trayIconPath))
  if (icon.isEmpty()) throw new Error('托盘图标无法加载')
  if (process.platform === 'darwin') icon.setTemplateImage(true)
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
  coreSupervisor?.stop()
})
