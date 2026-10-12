import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import type { CadInspection, ModelPreparation, ModelPreparationJob, ThermalModelDraft, ThermalModelSpec } from '@thermal-agent/contracts'

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
function processBirth(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const result = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$thermalProcess = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($thermalProcess) { $thermalProcess.StartTime.ToUniversalTime().Ticks.ToString() }`], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      : execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] })
    return result.trim() || null
  } catch { return null }
}
let currentOwnerBirth: string | null | undefined
export interface IcepakOperationRecord {
  operation_id: string
  method: string
  acquired_at: string
  owner_pid: number | null
  owner_birth: string | null
  worker_pid: number | null
  recovery_required: number
  resources_json: string
}

/** Uses the same WAL database as LocalDatabase; state survives Core restarts. */
export class ModelPreparationStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS cad_inspections (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_spec_drafts (task_id TEXT PRIMARY KEY REFERENCES tasks(id), version INTEGER NOT NULL, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_preparations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL, record_json TEXT NOT NULL, UNIQUE(task_id, revision));
      CREATE TABLE IF NOT EXISTS model_preparation_jobs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, request_id TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(task_id, kind, request_id));
      CREATE TABLE IF NOT EXISTS model_preparation_artifacts (job_id TEXT NOT NULL REFERENCES model_preparation_jobs(id), role TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES artifacts(sha256), PRIMARY KEY(job_id, role));
      CREATE TABLE IF NOT EXISTS icepak_operation_lock (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), operation_id TEXT NOT NULL, method TEXT NOT NULL, acquired_at TEXT NOT NULL);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (15, datetime('now'));
    `)
    const columns = this.db.prepare('PRAGMA table_info(icepak_operation_lock)').all().map(row => String(row.name))
    for (const [name, type] of [['owner_pid', 'INTEGER'], ['owner_birth', 'TEXT'], ['worker_pid', 'INTEGER'], ['recovery_required', 'INTEGER NOT NULL DEFAULT 0'], ['resources_json', "TEXT NOT NULL DEFAULT '[]'"]]) {
      if (!columns.includes(name)) this.db.exec(`ALTER TABLE icepak_operation_lock ADD COLUMN ${name} ${type}`)
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (16, datetime('now'))").run()
  }
  close() { this.db.close() }
  private get<T>(table: string, id: string): T | null {
    const row = this.db.prepare(`SELECT record_json FROM ${table} WHERE id = ?`).get(id)
    return row ? JSON.parse(String(row.record_json)) as T : null
  }
  private list<T>(table: string, taskId?: string): T[] {
    const rows = taskId ? this.db.prepare(`SELECT record_json FROM ${table} WHERE task_id = ? ORDER BY rowid`).all(taskId)
      : this.db.prepare(`SELECT record_json FROM ${table} ORDER BY rowid`).all()
    return rows.map(row => JSON.parse(String(row.record_json)) as T)
  }
  inspection(id: string) { return this.get<CadInspection>('cad_inspections', id) }
  preparation(id: string) { return this.get<ModelPreparation>('model_preparations', id) }
  job(id: string) { return this.get<ModelPreparationJob>('model_preparation_jobs', id) }
  inspections(taskId: string) { return this.list<CadInspection>('cad_inspections', taskId) }
  preparations(taskId: string) { return this.list<ModelPreparation>('model_preparations', taskId) }
  jobs(taskId?: string) { return this.list<ModelPreparationJob>('model_preparation_jobs', taskId) }
  requestedJob(taskId: string, kind: string, requestId: string) {
    const row = this.db.prepare('SELECT record_json FROM model_preparation_jobs WHERE task_id = ? AND kind = ? AND request_id = ?').get(taskId, kind, requestId)
    return row ? JSON.parse(String(row.record_json)) as ModelPreparationJob : null
  }
  createInspection(record: CadInspection) {
    this.db.prepare('INSERT INTO cad_inspections VALUES (?, ?, ?)').run(record.id, record.taskId, JSON.stringify(record))
  }
  finishInspection(id: string, patch: Partial<Pick<CadInspection, 'status' | 'catalog' | 'projectSha256' | 'catalogSha256' | 'previewSha256' | 'environment'>>) {
    const current = this.inspection(id)
    if (!current) throw new Error('导入记录不存在')
    const next = { ...current, ...patch }
    this.db.prepare('UPDATE cad_inspections SET record_json = ? WHERE id = ?').run(JSON.stringify(next), id)
    return next
  }
  createPreparation(record: ModelPreparation) {
    this.db.prepare('INSERT INTO model_preparations VALUES (?, ?, ?, ?)').run(record.id, record.taskId, record.revision, JSON.stringify(record))
  }
  updatePreparation(id: string, patch: Partial<Pick<ModelPreparation, 'status' | 'projectSha256' | 'validationSha256' | 'validatedDesign' | 'validatedSetup'>>) {
    const current = this.preparation(id)
    if (!current) throw new Error('建模版本不存在')
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
    this.db.prepare('UPDATE model_preparations SET record_json = ? WHERE id = ?').run(JSON.stringify(next), id)
    return next
  }
  createJob(job: ModelPreparationJob) {
    this.db.prepare('INSERT INTO model_preparation_jobs VALUES (?, ?, ?, ?, ?)').run(job.id, job.taskId, job.kind, job.requestId, JSON.stringify(job))
  }
  updateJob(id: string, patch: Partial<Pick<ModelPreparationJob, 'status' | 'stage' | 'artifacts' | 'error'>>) {
    const current = this.job(id)
    if (!current) throw new Error('建模作业不存在')
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
    this.db.prepare('UPDATE model_preparation_jobs SET record_json = ? WHERE id = ?').run(JSON.stringify(next), id)
    for (const a of patch.artifacts ?? []) this.db.prepare('INSERT OR IGNORE INTO model_preparation_artifacts VALUES (?, ?, ?)').run(id, a.role, a.sha256)
    return next
  }
  draft(taskId: string): ThermalModelDraft | null {
    const row = this.db.prepare('SELECT record_json FROM model_spec_drafts WHERE task_id = ?').get(taskId)
    return row ? JSON.parse(String(row.record_json)) as ThermalModelDraft : null
  }
  saveDraft(taskId: string, spec: ThermalModelSpec, expectedVersion: number): ThermalModelDraft {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.draft(taskId)
      if ((current?.version ?? 0) !== expectedVersion) throw new Error('配置草稿版本冲突，请刷新后重试')
      const draft = { taskId, spec, version: expectedVersion + 1, updatedAt: new Date().toISOString() }
      this.db.prepare('INSERT INTO model_spec_drafts VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET version = excluded.version, record_json = excluded.record_json').run(taskId, draft.version, JSON.stringify(draft))
      this.db.exec('COMMIT')
      return draft
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  acquireOperation(id: string, method: string, ownerPid: number = process.pid): boolean {
    this.reconcileRecoveredOperation()
    if (currentOwnerBirth === undefined) currentOwnerBirth = processBirth(process.pid)
    const birth = ownerPid === process.pid ? currentOwnerBirth : processBirth(ownerPid)
    return this.db.prepare("INSERT OR IGNORE INTO icepak_operation_lock(singleton, operation_id, method, acquired_at, owner_pid, owner_birth, worker_pid, recovery_required) VALUES (1, ?, ?, datetime('now'), ?, ?, NULL, 0)").run(id, method, ownerPid, birth).changes === 1
  }
  registerOperationWorker(id: string, pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('invalid Icepak worker pid')
    if (this.db.prepare('UPDATE icepak_operation_lock SET worker_pid = ? WHERE operation_id = ? AND owner_pid = ? AND recovery_required = 0').run(pid, id, process.pid).changes !== 1) throw new Error('Icepak operation ownership changed before process registration')
  }
  registerOperationResource(id: string, pid: number, creationTime: number) {
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(creationTime) || creationTime <= 0) throw new Error('invalid managed AEDT resource identity')
    const current = this.operation()
    if (!current || current.operation_id !== id || current.owner_pid !== process.pid) throw new Error('Icepak resource ownership changed')
    const resources = JSON.parse(current.resources_json) as Array<{ pid: number; creationTime: number }>
    if (!resources.some(r => r.pid === pid && r.creationTime === creationTime)) resources.push({ pid, creationTime })
    this.db.prepare('UPDATE icepak_operation_lock SET resources_json = ? WHERE operation_id = ?').run(JSON.stringify(resources), id)
  }
  private managedPids(record: IcepakOperationRecord) {
    return [...(record.worker_pid ? [record.worker_pid] : []), ...(JSON.parse(record.resources_json) as Array<{ pid: number }>).map(r => r.pid)]
  }
  completeOperation(id: string): boolean {
    const current = this.operation()
    if (!current || current.operation_id !== id) return false
    if (this.managedPids(current).some(processAlive)) {
      this.db.prepare('UPDATE icepak_operation_lock SET recovery_required = 1, owner_pid = NULL WHERE operation_id = ?').run(id)
      return false
    }
    this.releaseOperation(id)
    return true
  }
  releaseOperation(id: string) { this.db.prepare('DELETE FROM icepak_operation_lock WHERE operation_id = ?').run(id) }
  operation(): IcepakOperationRecord | null { return this.db.prepare('SELECT * FROM icepak_operation_lock WHERE singleton = 1').get() as unknown as IcepakOperationRecord ?? null }
  reconcileRecoveredOperation() {
    const previous = this.operation()
    // Never kill an arbitrary PID. An alive or unobservable worker keeps the fence closed.
    if (previous?.recovery_required) {
      const pids = this.managedPids(previous)
      if (pids.length && pids.every(pid => !processAlive(pid))) this.releaseOperation(previous.operation_id)
    }
    return this.operation()
  }
  recover() {
    const previous = this.operation()
    if (previous?.owner_pid && processAlive(previous.owner_pid)) {
      const birth = processBirth(previous.owner_pid)
      if (!previous.owner_birth || !birth || previous.owner_birth === birth) throw new Error('App 工作空间仍有活跃 Core 操作或无法核实其身份，请关闭原 App 后再打开同一工作空间')
    }
    if (previous) {
      if (previous.owner_pid && !previous.worker_pid) this.releaseOperation(previous.operation_id)
      else this.db.prepare('UPDATE icepak_operation_lock SET recovery_required = 1 WHERE operation_id = ?').run(previous.operation_id)
    }
    this.reconcileRecoveredOperation()
    for (const job of this.jobs()) {
      if (!['QUEUED', 'RUNNING'].includes(job.status)) continue
      this.updateJob(job.id, { status: 'INTERRUPTED', stage: 'interrupted', error: { code: 'INTERRUPTED', message: 'Core 重启中断了建模作业，请显式重试。' } })
      if (job.kind === 'INSPECT') this.finishInspection(job.inspectionId, { status: 'INTERRUPTED' })
      else if (job.preparationId) this.updatePreparation(job.preparationId, { status: 'INTERRUPTED' })
    }
  }
}
