import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('thermalDesktop', {
  platform: process.platform,
  locateTaskModel: (taskId: string, sha256?: string) => ipcRenderer.invoke('thermal:locate-task-model', taskId, sha256),
  setTitleBarTheme: (dark: boolean) => ipcRenderer.invoke('thermal:set-title-bar-theme', dark),
  openDshSession: (sessionId: string) => ipcRenderer.invoke('thermal:dsh-open-session', sessionId),
  openDshSettings: () => ipcRenderer.invoke('thermal:dsh-open-settings'),
  styleDshFrame: () => ipcRenderer.invoke('thermal:dsh-style-frame'),
})
