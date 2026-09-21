import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AttemptRecord,
  AttemptArtifactRecord,
  AttemptStatus,
  ArtifactRecord,
  CreateRunInput,
  ExecutionStatus,
  RunKind,
  RunRecord,
  RunStatus,
  SkillDetail,
  SkillRecord,
  SkillSourceRecord,
  SkillStatus,
  SkillVersionRecord,
  TaskEvent,
  TaskRecord,
  ThermalVerdict,
  ApprovalStatus,
} from '@thermal-agent/contracts'
import { assertAttemptTransition, assertTaskTransition } from '@thermal-agent/domain'

type SqliteRow = Record<string, unknown>

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} was not found`)
    this.name = 'TaskNotFoundError'
  }
}

export class VersionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`task version conflict: expected ${expected}, actual ${actual}`)
    this.name = 'VersionConflictError'
  }
}

export class SkillNotFoundError extends Error {
  constructor(readonly skillId: string) {
    super(`skill ${skillId} was not found`)
    this.name = 'SkillNotFoundError'
  }
}

export class SkillConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillConflictError'
  }
}

export class TaskApprovalConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskApprovalConflictError'
  }
}

export class LocalDatabase {
  readonly path: string
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.path = resolve(path)
    mkdirSync(dirname(this.path), { recursive: true })
    this.db = new DatabaseSync(this.path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        owner_node_id TEXT NOT NULL,
        executor_node_id TEXT,
        execution_status TEXT NOT NULL,
        thermal_verdict TEXT NOT NULL,
        approval_status TEXT NOT NULL,
        requirement_snapshot_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_status_updated_idx
        ON tasks(execution_status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        reason TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_events_task_created_idx
        ON task_events(task_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS artifacts (
        sha256 TEXT PRIMARY KEY,
        size_bytes INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        original_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL,
        selected_attempt_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS runs_task_sequence_idx
        ON runs(task_id, sequence ASC);

      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        executor_node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        plugin_version TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        progress_stage TEXT,
        input_artifact_sha256 TEXT,
        output_artifact_sha256 TEXT,
        started_at TEXT,
        heartbeat_at TEXT,
        finished_at TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS attempts_run_created_idx
        ON attempts(run_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS attempts_status_heartbeat_idx
        ON attempts(status, heartbeat_at ASC);

      CREATE TABLE IF NOT EXISTS attempt_artifacts (
        attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL REFERENCES artifacts(sha256),
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(attempt_id, sha256, role)
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        skill_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        active_version INTEGER NOT NULL,
        source_task_count INTEGER NOT NULL DEFAULT 0,
        published_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_versions (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        definition_json TEXT NOT NULL,
        change_summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(skill_id, version)
      );

      CREATE TABLE IF NOT EXISTS skill_sources (
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(skill_id, task_id),
        UNIQUE(task_id)
      );

      CREATE TABLE IF NOT EXISTS skill_reviews (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        action TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_runs (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        result_summary TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS skill_run_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES skill_runs(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        error_code TEXT,
        error_message TEXT,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(run_id, step_id)
      );

      CREATE INDEX IF NOT EXISTS skills_status_updated_idx ON skills(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS skill_runs_started_idx ON skill_runs(skill_id, started_at DESC);

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (1, datetime('now'));

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (2, datetime('now'));

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (3, datetime('now'));
    `)
  }

  createTask(task: TaskRecord): TaskRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO tasks(
          id, title, description, owner_node_id, executor_node_id,
          execution_status, thermal_verdict, approval_status,
          requirement_snapshot_json, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.title,
        task.description,
        task.ownerNodeId,
        task.executorNodeId,
        task.executionStatus,
        task.thermalVerdict,
        task.approvalStatus,
        JSON.stringify(task.requirementSnapshot),
        task.version,
        task.createdAt,
        task.updatedAt,
      )
      this.insertEvent({
        id: randomUUID(),
        taskId: task.id,
        eventType: 'task.created',
        fromStatus: null,
        toStatus: task.executionStatus,
        reason: null,
        payload: {},
        createdAt: task.createdAt,
      })
      this.db.exec('COMMIT')
      return task
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? decodeTask(row) : null
  }

  listTasks(limit = 100): TaskRecord[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)))
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?').all(bounded) as SqliteRow[]
    return rows.map(decodeTask)
  }

  transitionTask(id: string, toStatus: ExecutionStatus, expectedVersion?: number, reason?: string): TaskRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as SqliteRow | undefined
      if (!row) throw new TaskNotFoundError(id)
      const current = decodeTask(row)
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion, current.version)
      }
      assertTaskTransition(current.executionStatus, toStatus)
      const updatedAt = new Date().toISOString()
      const version = current.version + 1
      const result = this.db.prepare(`
        UPDATE tasks
        SET execution_status = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(toStatus, version, updatedAt, id, current.version)
      if (Number(result.changes) !== 1) throw new VersionConflictError(current.version, current.version + 1)
      this.insertEvent({
        id: randomUUID(),
        taskId: id,
        eventType: 'task.status_changed',
        fromStatus: current.executionStatus,
        toStatus,
        reason: reason?.trim().slice(0, 500) || null,
        payload: { previousVersion: current.version, version },
        createdAt: updatedAt,
      })
      this.db.exec('COMMIT')
      return { ...current, executionStatus: toStatus, version, updatedAt }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  requestTaskApproval(id: string, verdict: ThermalVerdict, expectedVersion?: number, reason?: string): TaskRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as SqliteRow | undefined
      if (!row) throw new TaskNotFoundError(id)
      const current = decodeTask(row)
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion, current.version)
      }
      if (current.approvalStatus !== 'NONE') throw new TaskApprovalConflictError('task already has an approval decision')
      assertTaskTransition(current.executionStatus, 'WAITING_FOR_APPROVAL')
      const now = new Date().toISOString()
      const version = current.version + 1
      this.db.prepare(`
        UPDATE tasks SET execution_status = 'WAITING_FOR_APPROVAL', thermal_verdict = ?,
          approval_status = 'PENDING', version = ?, updated_at = ? WHERE id = ? AND version = ?
      `).run(verdict, version, now, id, current.version)
      this.insertEvent({
        id: randomUUID(), taskId: id, eventType: 'task.approval_requested',
        fromStatus: current.executionStatus, toStatus: 'WAITING_FOR_APPROVAL',
        reason: reason?.trim().slice(0, 500) || null,
        payload: { thermalVerdict: verdict, approvalStatus: 'PENDING', previousVersion: current.version, version },
        createdAt: now,
      })
      this.db.exec('COMMIT')
      return this.getTask(id) as TaskRecord
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  resolveTaskApproval(
    id: string,
    decision: Extract<ApprovalStatus, 'APPROVED' | 'REJECTED'>,
    expectedVersion?: number,
    reason?: string,
  ): TaskRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as SqliteRow | undefined
      if (!row) throw new TaskNotFoundError(id)
      const current = decodeTask(row)
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion, current.version)
      }
      if (current.executionStatus !== 'WAITING_FOR_APPROVAL' || current.approvalStatus !== 'PENDING') {
        throw new TaskApprovalConflictError('task is not waiting for approval')
      }
      const nextStatus: ExecutionStatus = decision === 'APPROVED' ? 'COMPLETED' : 'ESCALATED'
      assertTaskTransition(current.executionStatus, nextStatus)
      const now = new Date().toISOString()
      const version = current.version + 1
      this.db.prepare(`
        UPDATE tasks SET execution_status = ?, approval_status = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(nextStatus, decision, version, now, id, current.version)
      this.insertEvent({
        id: randomUUID(), taskId: id, eventType: 'task.approval_resolved',
        fromStatus: current.executionStatus, toStatus: nextStatus,
        reason: reason?.trim().slice(0, 500) || null,
        payload: { thermalVerdict: current.thermalVerdict, approvalStatus: decision, previousVersion: current.version, version },
        createdAt: now,
      })
      this.db.exec('COMMIT')
      return this.getTask(id) as TaskRecord
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listTaskEvents(taskId: string): TaskEvent[] {
    const rows = this.db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as SqliteRow[]
    return rows.map(row => ({
      id: String(row.id),
      taskId: String(row.task_id),
      eventType: String(row.event_type),
      fromStatus: row.from_status === null ? null : row.from_status as ExecutionStatus,
      toStatus: row.to_status === null ? null : row.to_status as ExecutionStatus,
      reason: row.reason === null ? null : String(row.reason),
      payload: parseObject(row.payload_json),
      createdAt: String(row.created_at),
    }))
  }

  createRunWithAttempt(input: CreateRunInput): { run: RunRecord; attempt: AttemptRecord } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.getTask(input.taskId)) throw new TaskNotFoundError(input.taskId)
      const sequenceRow = this.db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM runs WHERE task_id = ?',
      ).get(input.taskId) as SqliteRow
      const now = new Date().toISOString()
      const run: RunRecord = {
        id: randomUUID(),
        taskId: input.taskId,
        kind: input.kind,
        sequence: Number(sequenceRow.next_sequence),
        status: 'PLANNED',
        selectedAttemptId: null,
        createdAt: now,
        updatedAt: now,
      }
      const attempt: AttemptRecord = {
        id: randomUUID(),
        runId: run.id,
        executorNodeId: input.executorNodeId,
        status: 'QUEUED',
        pluginId: input.pluginId,
        pluginVersion: input.pluginVersion,
        parameters: structuredClone(input.parameters),
        progressStage: null,
        inputArtifactSha256: input.inputArtifactSha256 ?? null,
        outputArtifactSha256: null,
        startedAt: null,
        heartbeatAt: null,
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      }
      this.db.prepare(`
        INSERT INTO runs(id, task_id, kind, sequence, status, selected_attempt_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(run.id, run.taskId, run.kind, run.sequence, run.status, null, now, now)
      this.db.prepare(`
        INSERT INTO attempts(
          id, run_id, executor_node_id, status, plugin_id, plugin_version,
          parameters_json, progress_stage, input_artifact_sha256, output_artifact_sha256,
          started_at, heartbeat_at, finished_at, error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attempt.id, attempt.runId, attempt.executorNodeId, attempt.status,
        attempt.pluginId, attempt.pluginVersion, JSON.stringify(attempt.parameters), null,
        attempt.inputArtifactSha256, null, null, null, null, null, null, now, now,
      )
      this.insertEvent({
        id: randomUUID(), taskId: input.taskId, eventType: 'run.created',
        fromStatus: null, toStatus: null, reason: null,
        payload: { runId: run.id, attemptId: attempt.id, kind: run.kind, sequence: run.sequence },
        createdAt: now,
      })
      this.db.exec('COMMIT')
      return { run, attempt }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? decodeRun(row) : null
  }

  listTaskRuns(taskId: string): RunRecord[] {
    const rows = this.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY sequence ASC').all(taskId) as SqliteRow[]
    return rows.map(decodeRun)
  }

  getAttempt(id: string): AttemptRecord | null {
    const row = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? decodeAttempt(row) : null
  }

  listRunAttempts(runId: string): AttemptRecord[] {
    const rows = this.db.prepare('SELECT * FROM attempts WHERE run_id = ? ORDER BY created_at ASC').all(runId) as SqliteRow[]
    return rows.map(decodeAttempt)
  }

  listActiveAttempts(): AttemptRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM attempts WHERE status IN ('STARTING', 'RUNNING') ORDER BY created_at ASC
    `).all() as SqliteRow[]
    return rows.map(decodeAttempt)
  }

  transitionAttempt(
    id: string,
    toStatus: AttemptStatus,
    details: { progressStage?: string; outputArtifactSha256?: string; errorCode?: string; errorMessage?: string } = {},
  ): AttemptRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id) as SqliteRow | undefined
      if (!row) throw new Error(`attempt ${id} was not found`)
      const current = decodeAttempt(row)
      assertAttemptTransition(current.status, toStatus)
      const now = new Date().toISOString()
      const startedAt = current.startedAt ?? (toStatus === 'STARTING' || toStatus === 'RUNNING' ? now : null)
      const heartbeatAt = toStatus === 'STARTING' || toStatus === 'RUNNING' ? now : current.heartbeatAt
      const finishedAt = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(toStatus) ? now : null
      this.db.prepare(`
        UPDATE attempts SET
          status = ?, progress_stage = ?, output_artifact_sha256 = ?, started_at = ?,
          heartbeat_at = ?, finished_at = ?, error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ?
      `).run(
        toStatus,
        details.progressStage?.slice(0, 200) ?? current.progressStage,
        details.outputArtifactSha256 ?? current.outputArtifactSha256,
        startedAt,
        heartbeatAt,
        finishedAt,
        details.errorCode?.slice(0, 100) ?? null,
        details.errorMessage?.slice(0, 2_000) ?? null,
        now,
        id,
      )
      const runStatus: RunStatus = toStatus === 'SUCCEEDED'
        ? 'COMPLETED'
        : toStatus === 'CANCELLED'
          ? 'CANCELLED'
          : ['FAILED', 'INTERRUPTED'].includes(toStatus)
            ? 'FAILED'
            : 'RUNNING'
      this.db.prepare(`
        UPDATE runs SET status = ?, selected_attempt_id = ?, updated_at = ? WHERE id = ?
      `).run(runStatus, toStatus === 'SUCCEEDED' ? id : null, now, current.runId)
      const taskRow = this.db.prepare('SELECT task_id FROM runs WHERE id = ?').get(current.runId) as SqliteRow
      this.insertEvent({
        id: randomUUID(), taskId: String(taskRow.task_id), eventType: 'attempt.status_changed',
        fromStatus: null, toStatus: null, reason: details.errorMessage?.slice(0, 500) ?? null,
        payload: { runId: current.runId, attemptId: id, fromAttemptStatus: current.status, toAttemptStatus: toStatus },
        createdAt: now,
      })
      this.db.exec('COMMIT')
      return this.getAttempt(id) as AttemptRecord
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  heartbeatAttempt(id: string, progressStage?: string): AttemptRecord {
    const now = new Date().toISOString()
    const result = this.db.prepare(`
      UPDATE attempts SET heartbeat_at = ?, progress_stage = COALESCE(?, progress_stage), updated_at = ?
      WHERE id = ? AND status IN ('STARTING', 'RUNNING')
    `).run(now, progressStage?.slice(0, 200) ?? null, now, id)
    if (Number(result.changes) !== 1) throw new Error(`attempt ${id} is not active`)
    return this.getAttempt(id) as AttemptRecord
  }

  upsertArtifact(artifact: ArtifactRecord): ArtifactRecord {
    this.db.prepare(`
      INSERT INTO artifacts(sha256, size_bytes, media_type, original_name, relative_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET
        media_type = excluded.media_type,
        original_name = excluded.original_name
    `).run(
      artifact.sha256,
      artifact.sizeBytes,
      artifact.mediaType,
      artifact.originalName,
      artifact.relativePath,
      artifact.createdAt,
    )
    return artifact
  }

  getArtifact(sha256: string): ArtifactRecord | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE sha256 = ?').get(sha256) as SqliteRow | undefined
    if (!row) return null
    return {
      sha256: String(row.sha256),
      sizeBytes: Number(row.size_bytes),
      mediaType: String(row.media_type),
      originalName: String(row.original_name),
      relativePath: String(row.relative_path),
      createdAt: String(row.created_at),
    }
  }

  linkAttemptArtifact(record: AttemptArtifactRecord): AttemptArtifactRecord {
    this.db.prepare(`
      INSERT OR IGNORE INTO attempt_artifacts(attempt_id, sha256, role, created_at)
      VALUES (?, ?, ?, ?)
    `).run(record.attemptId, record.sha256, record.role, record.createdAt)
    return record
  }

  listAttemptArtifacts(attemptId: string): AttemptArtifactRecord[] {
    const rows = this.db.prepare(`
      SELECT attempt_id, sha256, role, created_at
      FROM attempt_artifacts WHERE attempt_id = ? ORDER BY created_at ASC
    `).all(attemptId) as SqliteRow[]
    return rows.map(row => ({
      attemptId: String(row.attempt_id),
      sha256: String(row.sha256),
      role: row.role as AttemptArtifactRecord['role'],
      createdAt: String(row.created_at),
    }))
  }

  createSkillDraftFromTask(taskId: string): SkillDetail {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const task = this.getTask(taskId)
      if (!task) throw new TaskNotFoundError(taskId)
      if (task.executionStatus !== 'COMPLETED') {
        throw new SkillConflictError('only a COMPLETED task can produce a skill draft')
      }
      const existing = this.db.prepare(`
        SELECT skill_id FROM skill_sources WHERE task_id = ?
      `).get(taskId) as SqliteRow | undefined
      if (existing) {
        this.db.exec('COMMIT')
        return this.getSkill(String(existing.skill_id)) as SkillDetail
      }
      const attempt = this.db.prepare(`
        SELECT a.id AS attempt_id, a.plugin_id, a.plugin_version, a.parameters_json
        FROM runs r
        JOIN attempts a ON a.id = r.selected_attempt_id
        WHERE r.task_id = ? AND r.status = 'COMPLETED' AND a.status = 'SUCCEEDED'
        ORDER BY r.sequence DESC LIMIT 1
      `).get(taskId) as SqliteRow | undefined
      if (!attempt) throw new SkillConflictError('completed task has no selected successful attempt')
      const artifacts = this.listAttemptArtifacts(String(attempt.attempt_id))
      const roles = new Set(artifacts.map(item => item.role))
      for (const required of ['INPUT_PROJECT', 'SOLVED_PROJECT', 'SOLVER_RESULT'] as const) {
        if (!roles.has(required)) throw new SkillConflictError(`completed task is missing ${required} evidence`)
      }
      const id = randomUUID()
      const versionId = randomUUID()
      const now = new Date().toISOString()
      const key = `task-${task.id.replaceAll('-', '').slice(0, 16)}`
      const definition = {
        parameters: [
          { key: 'projectPath', description: '待分析的本地 AEDT 工程绝对路径', required: true },
          { key: 'targetTmaxC', description: '用户明确给出的最高温度目标；未知时不得猜测', required: false },
        ],
        steps: [
          { id: 'probe', title: '验证 Icepak 环境', description: '探测 AEDT、PyAEDT、许可证和插件能力。', verification: '能力证据明确；不可用时停止。' },
          { id: 'inspect', title: '隔离检查工程', description: '仅通过 Icepak 插件在工程副本中检查设计、边界、Monitor 与 Setup。', verification: '源工程未被修改且项目校验通过。' },
          { id: 'confirm', title: '人工确认求解输入', description: '展示需求快照与检查结果，等待用户在 App 中确认。', verification: '任务进入 READY，审批记录可追溯。' },
          { id: 'solve', title: '执行 Baseline', description: '由 App 启动一次受管 Icepak Baseline，并持续保存心跳。', verification: 'Attempt 成功且输入、求解工程和结果证据均已关联。' },
          { id: 'judge', title: '分别陈述证据', description: '分别报告温度、Monitor、残差、反向流与收敛性。', verification: '求解状态、热判定和审批状态未被混为一谈。' },
        ],
        permissions: ['读取本地任务和证据', '通过 Icepak 插件检查隔离工程副本', '昂贵求解必须由用户在 App 中明确启动', '禁止直接修改源 .aedt'],
        successCriteria: ['存在成功的受管 Attempt', '输入工程、求解工程与结构化结果均可追溯', '缺少的热判定证据被明确标记为未知'],
        failureStrategy: '停止当前步骤，保留 Attempt、错误和已有 Artifact；不得绕过人工确认或在源工程上重试。',
      }
      const evidence = {
        attemptId: String(attempt.attempt_id),
        pluginId: String(attempt.plugin_id),
        pluginVersion: String(attempt.plugin_version),
        artifactRoles: [...roles].sort(),
        thermalVerdict: task.thermalVerdict,
      }
      this.db.prepare(`
        INSERT INTO skills(id, skill_key, name, description, status, active_version, source_task_count, published_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'DRAFT', 1, 1, NULL, ?, ?)
      `).run(id, key, `${task.title}复用流程`.slice(0, 200), `从已完成任务「${task.title}」及其求解证据提取的待审核流程。`, now, now)
      this.db.prepare(`
        INSERT INTO skill_versions(id, skill_id, version, definition_json, change_summary, created_at)
        VALUES (?, ?, 1, ?, ?, ?)
      `).run(versionId, id, JSON.stringify(definition), `从完成任务「${task.title}」提取`, now)
      this.db.prepare(`
        INSERT INTO skill_sources(skill_id, task_id, evidence_json, created_at) VALUES (?, ?, ?, ?)
      `).run(id, taskId, JSON.stringify(evidence), now)
      this.insertEvent({
        id: randomUUID(), taskId, eventType: 'skill.draft_created', fromStatus: null, toStatus: null,
        reason: null, payload: { skillId: id, skillVersion: 1 }, createdAt: now,
      })
      this.db.exec('COMMIT')
      return this.getSkill(id) as SkillDetail
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getSkill(id: string): SkillDetail | null {
    const row = this.db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SqliteRow | undefined
    if (!row) return null
    const skill = decodeSkill(row)
    const versionRow = this.db.prepare(`
      SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?
    `).get(id, skill.activeVersion) as SqliteRow | undefined
    if (!versionRow) throw new Error(`skill ${id} active version was not found`)
    const sourceRows = this.db.prepare('SELECT * FROM skill_sources WHERE skill_id = ? ORDER BY created_at ASC').all(id) as SqliteRow[]
    return { ...skill, version: decodeSkillVersion(versionRow), sources: sourceRows.map(decodeSkillSource) }
  }

  listSkills(): SkillRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM skills ORDER BY CASE status WHEN 'ENABLED' THEN 0 WHEN 'DRAFT' THEN 1 ELSE 2 END, updated_at DESC
    `).all() as SqliteRow[]
    return rows.map(decodeSkill)
  }

  reviewSkill(
    id: string,
    status: Extract<SkillStatus, 'ENABLED' | 'DISABLED'>,
    reviewer: string,
    expectedUpdatedAt: string,
    publishedPath: string | null,
  ): SkillDetail {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.getSkill(id)
      if (!current) throw new SkillNotFoundError(id)
      if (current.updatedAt !== expectedUpdatedAt) throw new SkillConflictError('skill was changed by another operation')
      if (status === 'ENABLED' && !['DRAFT', 'DISABLED'].includes(current.status)) {
        throw new SkillConflictError(`skill status ${current.status} cannot be enabled`)
      }
      if (status === 'DISABLED' && current.status !== 'ENABLED') {
        throw new SkillConflictError(`skill status ${current.status} cannot be disabled`)
      }
      const now = new Date().toISOString()
      this.db.prepare('UPDATE skills SET status = ?, published_path = ?, updated_at = ? WHERE id = ?')
        .run(status, publishedPath, now, id)
      this.db.prepare(`
        INSERT INTO skill_reviews(id, skill_id, version, action, reviewer, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), id, current.activeVersion, status === 'ENABLED' ? 'APPROVED_AND_PUBLISHED' : 'DISABLED', reviewer.slice(0, 200), now)
      this.db.exec('COMMIT')
      return this.getSkill(id) as SkillDetail
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private insertEvent(event: TaskEvent): void {
    this.db.prepare(`
      INSERT INTO task_events(
        id, task_id, event_type, from_status, to_status, reason, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.taskId,
      event.eventType,
      event.fromStatus,
      event.toStatus,
      event.reason,
      JSON.stringify(event.payload),
      event.createdAt,
    )
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed = JSON.parse(String(value)) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('stored JSON is not an object')
  return parsed as Record<string, unknown>
}

function decodeTask(row: SqliteRow): TaskRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    ownerNodeId: String(row.owner_node_id),
    executorNodeId: row.executor_node_id === null ? null : String(row.executor_node_id),
    executionStatus: row.execution_status as ExecutionStatus,
    thermalVerdict: row.thermal_verdict as ThermalVerdict,
    approvalStatus: row.approval_status as ApprovalStatus,
    requirementSnapshot: parseObject(row.requirement_snapshot_json),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function decodeRun(row: SqliteRow): RunRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    kind: row.kind as RunKind,
    sequence: Number(row.sequence),
    status: row.status as RunStatus,
    selectedAttemptId: row.selected_attempt_id === null ? null : String(row.selected_attempt_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function decodeAttempt(row: SqliteRow): AttemptRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    executorNodeId: String(row.executor_node_id),
    status: row.status as AttemptStatus,
    pluginId: String(row.plugin_id),
    pluginVersion: String(row.plugin_version),
    parameters: parseObject(row.parameters_json),
    progressStage: row.progress_stage === null ? null : String(row.progress_stage),
    inputArtifactSha256: row.input_artifact_sha256 === null ? null : String(row.input_artifact_sha256),
    outputArtifactSha256: row.output_artifact_sha256 === null ? null : String(row.output_artifact_sha256),
    startedAt: row.started_at === null ? null : String(row.started_at),
    heartbeatAt: row.heartbeat_at === null ? null : String(row.heartbeat_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function decodeSkill(row: SqliteRow): SkillRecord {
  return {
    id: String(row.id),
    key: String(row.skill_key),
    name: String(row.name),
    description: String(row.description),
    status: row.status as SkillStatus,
    activeVersion: Number(row.active_version),
    sourceTaskCount: Number(row.source_task_count),
    publishedPath: row.published_path === null ? null : String(row.published_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function decodeSkillVersion(row: SqliteRow): SkillVersionRecord {
  return {
    id: String(row.id),
    skillId: String(row.skill_id),
    version: Number(row.version),
    definition: parseObject(row.definition_json) as unknown as SkillVersionRecord['definition'],
    changeSummary: String(row.change_summary),
    createdAt: String(row.created_at),
  }
}

function decodeSkillSource(row: SqliteRow): SkillSourceRecord {
  return {
    skillId: String(row.skill_id),
    taskId: String(row.task_id),
    evidence: parseObject(row.evidence_json),
    createdAt: String(row.created_at),
  }
}
