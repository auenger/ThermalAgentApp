import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

interface WorkspaceStore {
  unit: { name: string; version: number }
  global: { initialized: boolean; workspaceIds: string[]; archivedSessionIds: string[] }
  tables: { workspaces: Record<string, { path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string }> }
}

export function bindDshWorkspace(dshHome: string, selectedPath: string): void {
  const path = realpathSync(selectedPath)
  const storageDir = join(dshHome, 'storages')
  const storagePath = join(storageDir, 'workspace.json')
  mkdirSync(storageDir, { recursive: true, mode: 0o700 })
  const now = new Date().toISOString()
  let value: WorkspaceStore = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
    tables: { workspaces: {} },
  }
  if (existsSync(storagePath)) {
    try { value = JSON.parse(readFileSync(storagePath, 'utf8')) as WorkspaceStore } catch {
      throw new Error('DSH workspace configuration is damaged')
    }
  }
  if (value.unit?.name !== 'workspace' || value.unit.version !== 2 || !value.global || !value.tables?.workspaces) {
    throw new Error('DSH workspace configuration version is unsupported')
  }
  const records = value.tables.workspaces
  let workspaceId = Object.keys(records).find(id => records[id]?.path === path)
  if (!workspaceId) {
    workspaceId = randomUUID()
    records[workspaceId] = { path, title: basename(path) || path, sessionIds: [], createdAt: now, updatedAt: now }
  } else {
    records[workspaceId].title = basename(path) || path
    records[workspaceId].updatedAt = now
  }
  value.global.workspaceIds = [workspaceId, ...value.global.workspaceIds.filter(id => id !== workspaceId)]
  value.global.initialized = true
  const temporary = `${storagePath}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, storagePath)
}

