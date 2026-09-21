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

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (1, datetime('now'));

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (2, datetime('now'));
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
