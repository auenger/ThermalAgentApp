import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ArtifactRecord,
  ExecutionStatus,
  TaskEvent,
  TaskRecord,
  ThermalVerdict,
  ApprovalStatus,
} from '@thermal-agent/contracts'
import { assertTaskTransition } from '@thermal-agent/domain'

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

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (1, datetime('now'));
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
