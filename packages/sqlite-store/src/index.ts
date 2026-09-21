import { createHash, createPublicKey, randomUUID } from 'node:crypto'
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
  SkillRunDetail,
  SkillRunRecord,
  SkillRunStatus,
  SkillRunStepRecord,
  SkillStepStatus,
  SkillSourceRecord,
  SkillStatus,
  SkillVersionRecord,
  TaskEvent,
  TaskRecord,
  ThermalVerdict,
  ApprovalStatus,
  LeaseRecord,
  PeerHeartbeat,
  PeerIdentity,
  PeerRecord,
  RemoteJobRecord,
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

export class PeerConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PeerConflictError'
  }
}

export class LeaseConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LeaseConflictError'
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

      CREATE TABLE IF NOT EXISTS local_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        node_id TEXT NOT NULL,
        public_key TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS peers (
        node_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        trust_status TEXT NOT NULL,
        plugin_status TEXT NOT NULL,
        aedt_versions_json TEXT NOT NULL,
        max_concurrent INTEGER NOT NULL,
        active_attempts INTEGER NOT NULL,
        last_seen_at TEXT,
        paired_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        executor_node_id TEXT NOT NULL REFERENCES peers(node_id),
        epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        renewed_at TEXT,
        released_at TEXT,
        revoke_reason TEXT,
        UNIQUE(task_id, epoch)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active_per_task_idx
        ON leases(task_id) WHERE status = 'ACTIVE';

      CREATE INDEX IF NOT EXISTS leases_expiry_idx
        ON leases(status, expires_at);

      CREATE TABLE IF NOT EXISTS attempt_artifacts (
        attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
        sha256 TEXT NOT NULL REFERENCES artifacts(sha256),
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(attempt_id, sha256, role)
      );

      CREATE TABLE IF NOT EXISTS remote_execution_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1))
      );

      INSERT OR IGNORE INTO remote_execution_settings(singleton, enabled) VALUES (1, 0);

      CREATE TABLE IF NOT EXISTS remote_jobs (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        owner_node_id TEXT NOT NULL,
        executor_node_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        input_sha256 TEXT NOT NULL,
        input_size_bytes INTEGER NOT NULL,
        input_original_name TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(owner_node_id, task_id, epoch)
      );

      CREATE INDEX IF NOT EXISTS remote_jobs_status_updated_idx
        ON remote_jobs(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        skill_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        active_version INTEGER NOT NULL,
        source_task_count INTEGER NOT NULL DEFAULT 0,
        published_path TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
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

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (4, datetime('now'));

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (5, datetime('now'));

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (6, datetime('now'));

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
        VALUES (7, datetime('now'));
    `)
    this.ensureColumn('skills', 'run_count', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('skills', 'success_count', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('skills', 'consecutive_failures', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('skills', 'last_run_at', 'TEXT')
    this.ensureColumn('remote_jobs', 'error_code', 'TEXT')
    this.ensureColumn('remote_jobs', 'error_message', 'TEXT')
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqliteRow[]
    if (!columns.some(item => String(item.name) === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
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

  getLocalIdentity(): PeerIdentity | null {
    const row = this.db.prepare('SELECT node_id, public_key FROM local_identity WHERE singleton = 1').get() as SqliteRow | undefined
    return row ? { nodeId: String(row.node_id), publicKey: String(row.public_key), algorithm: 'Ed25519' } : null
  }

  bindLocalIdentity(identity: PeerIdentity): void {
    validatePeerIdentity(identity)
    const existing = this.getLocalIdentity()
    if (existing && (existing.nodeId !== identity.nodeId || existing.publicKey !== identity.publicKey)) {
      throw new PeerConflictError('local node identity does not match the persisted database owner')
    }
    if (!existing) {
      this.db.prepare('INSERT OR IGNORE INTO local_identity(singleton, node_id, public_key) VALUES (1, ?, ?)')
        .run(identity.nodeId, identity.publicKey)
      const bound = this.getLocalIdentity()
      if (bound?.nodeId !== identity.nodeId || bound.publicKey !== identity.publicKey) {
        throw new PeerConflictError('local node identity changed while starting Core')
      }
    }
  }

  adoptLegacyLocalTasks(nodeId: string): number {
    if (!/^node-[a-f0-9]{32}$/u.test(nodeId)) throw new Error('local node ID is invalid')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const tasks = (this.db.prepare("SELECT * FROM tasks WHERE owner_node_id = 'local-node'").all() as SqliteRow[]).map(decodeTask)
      for (const task of tasks) {
        const now = new Date().toISOString()
        this.db.prepare(`UPDATE tasks SET owner_node_id = ?, executor_node_id = CASE WHEN executor_node_id = 'local-node' THEN ? ELSE executor_node_id END,
          version = ?, updated_at = ? WHERE id = ? AND version = ?`)
          .run(nodeId, nodeId, task.version + 1, now, task.id, task.version)
        this.db.prepare(`UPDATE attempts SET executor_node_id = ? WHERE run_id IN (SELECT id FROM runs WHERE task_id = ?) AND executor_node_id = 'local-node'`)
          .run(nodeId, task.id)
        this.insertEvent({
          id: randomUUID(), taskId: task.id, eventType: 'task.owner_identity_migrated',
          fromStatus: task.executionStatus, toStatus: task.executionStatus, reason: 'legacy local-node identity replaced by persistent node identity',
          payload: { previousOwnerNodeId: 'local-node', ownerNodeId: nodeId, previousVersion: task.version, version: task.version + 1 },
          createdAt: now,
        })
      }
      this.db.exec('COMMIT')
      return tasks.length
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  trustPeer(identity: PeerIdentity, displayName: string, now = new Date()): PeerRecord {
    validatePeerIdentity(identity)
    const name = displayName.trim().slice(0, 100)
    if (!name) throw new PeerConflictError('peer display name is required')
    const existing = this.getPeer(identity.nodeId)
    if (existing && existing.publicKey !== identity.publicKey) throw new PeerConflictError('peer public key changed')
    const timestamp = now.toISOString()
    this.db.prepare(`
      INSERT INTO peers(node_id, public_key, display_name, trust_status, plugin_status,
        aedt_versions_json, max_concurrent, active_attempts, last_seen_at, paired_at, revoked_at)
      VALUES (?, ?, ?, 'TRUSTED', 'DETECTED', '[]', 0, 0, NULL, ?, NULL)
      ON CONFLICT(node_id) DO UPDATE SET display_name = excluded.display_name,
        trust_status = 'TRUSTED', plugin_status = 'DETECTED', aedt_versions_json = '[]',
        max_concurrent = 0, active_attempts = 0, last_seen_at = NULL,
        paired_at = excluded.paired_at, revoked_at = NULL
    `).run(identity.nodeId, identity.publicKey, name, timestamp)
    return this.getPeer(identity.nodeId) as PeerRecord
  }

  getPeer(nodeId: string): PeerRecord | null {
    const row = this.db.prepare('SELECT * FROM peers WHERE node_id = ?').get(nodeId) as SqliteRow | undefined
    return row ? decodePeer(row) : null
  }

  listPeers(): PeerRecord[] {
    return (this.db.prepare('SELECT * FROM peers ORDER BY paired_at ASC').all() as SqliteRow[]).map(decodePeer)
  }

  recordPeerHeartbeat(nodeId: string, heartbeat: PeerHeartbeat, now = new Date()): PeerRecord {
    const peer = this.getPeer(nodeId)
    if (!peer || peer.trustStatus !== 'TRUSTED') throw new PeerConflictError('peer is not trusted')
    if (!['READY', 'BUSY', 'DEGRADED', 'LAUNCHABLE', 'PROJECT_COMPATIBLE', 'NEEDS_CONFIG', 'DETECTED', 'NOT_INSTALLED'].includes(heartbeat.pluginStatus)) {
      throw new PeerConflictError('peer plugin status is invalid')
    }
    if (!Number.isInteger(heartbeat.maxConcurrent) || heartbeat.maxConcurrent < 0 || heartbeat.maxConcurrent > 32 ||
      !Number.isInteger(heartbeat.activeAttempts) || heartbeat.activeAttempts < 0 || heartbeat.activeAttempts > 32 ||
      !Array.isArray(heartbeat.aedtVersions) || heartbeat.aedtVersions.length > 32 ||
      heartbeat.aedtVersions.some(value => typeof value !== 'string' || value.length > 40)) {
      throw new PeerConflictError('peer capacity heartbeat is invalid')
    }
    this.db.prepare(`
      UPDATE peers SET plugin_status = ?, aedt_versions_json = ?, max_concurrent = ?,
        active_attempts = ?, last_seen_at = ? WHERE node_id = ? AND trust_status = 'TRUSTED'
    `).run(heartbeat.pluginStatus, JSON.stringify(heartbeat.aedtVersions), heartbeat.maxConcurrent,
      heartbeat.activeAttempts, now.toISOString(), nodeId)
    return this.getPeer(nodeId) as PeerRecord
  }

  listAvailablePeers(requiredAedtVersion?: string, now = new Date()): PeerRecord[] {
    const staleBefore = now.getTime() - 30_000
    return this.listPeers().filter(peer => peer.trustStatus === 'TRUSTED' && peer.pluginStatus === 'READY' &&
      peer.lastSeenAt !== null && Date.parse(peer.lastSeenAt) >= staleBefore &&
      Math.max(peer.activeAttempts, this.activeLeaseCount(peer.nodeId, now)) < peer.maxConcurrent &&
      (!requiredAedtVersion || peer.aedtVersions.includes(requiredAedtVersion)))
      .sort((left, right) => (left.activeAttempts / left.maxConcurrent) - (right.activeAttempts / right.maxConcurrent) || left.nodeId.localeCompare(right.nodeId))
  }

  getLease(id: string): LeaseRecord | null {
    const row = this.db.prepare('SELECT * FROM leases WHERE id = ?').get(id) as SqliteRow | undefined
    return row ? decodeLease(row) : null
  }

  listTaskLeases(taskId: string): LeaseRecord[] {
    return (this.db.prepare('SELECT * FROM leases WHERE task_id = ? ORDER BY epoch ASC').all(taskId) as SqliteRow[]).map(decodeLease)
  }

  remoteExecutionEnabled(): boolean {
    const row = this.db.prepare('SELECT enabled FROM remote_execution_settings WHERE singleton = 1').get() as SqliteRow
    return Number(row.enabled) === 1
  }

  setRemoteExecutionEnabled(enabled: boolean): boolean {
    this.db.prepare('UPDATE remote_execution_settings SET enabled = ? WHERE singleton = 1').run(enabled ? 1 : 0)
    return this.remoteExecutionEnabled()
  }

  getRemoteJob(attemptId: string): RemoteJobRecord | null {
    const row = this.db.prepare('SELECT * FROM remote_jobs WHERE attempt_id = ?').get(attemptId) as SqliteRow | undefined
    return row ? decodeRemoteJob(row) : null
  }

  listRemoteJobs(): RemoteJobRecord[] {
    return (this.db.prepare('SELECT * FROM remote_jobs ORDER BY created_at DESC').all() as SqliteRow[]).map(decodeRemoteJob)
  }

  acceptRemoteJob(input: Omit<RemoteJobRecord, 'status' | 'errorCode' | 'errorMessage' | 'createdAt' | 'updatedAt'>): RemoteJobRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.getRemoteJob(input.attemptId)
      if (existing) {
        const sameWork = existing.taskId === input.taskId && existing.runId === input.runId &&
          existing.ownerNodeId === input.ownerNodeId && existing.executorNodeId === input.executorNodeId &&
          existing.inputSha256 === input.inputSha256 && existing.inputSizeBytes === input.inputSizeBytes &&
          existing.inputOriginalName === input.inputOriginalName &&
          JSON.stringify(existing.parameters) === JSON.stringify(input.parameters)
        if (!sameWork || input.epoch < existing.epoch ||
          (input.epoch === existing.epoch && input.leaseId !== existing.leaseId) ||
          (input.epoch > existing.epoch && !['OFFERED', 'TRANSFERRING', 'INPUT_READY'].includes(existing.status))) {
          throw new PeerConflictError('remote job attempt was offered with conflicting details')
        }
        if (input.epoch > existing.epoch) {
          this.db.prepare(`
            UPDATE remote_jobs SET lease_id = ?, epoch = ?, status = 'OFFERED',
              error_code = NULL, error_message = NULL, updated_at = ? WHERE attempt_id = ?
          `).run(input.leaseId, input.epoch, new Date().toISOString(), input.attemptId)
        }
        this.db.exec('COMMIT')
        return this.getRemoteJob(input.attemptId) as RemoteJobRecord
      }
      const busy = this.db.prepare(`
        SELECT attempt_id FROM remote_jobs
        WHERE status IN ('OFFERED', 'TRANSFERRING', 'INPUT_READY', 'RUNNING', 'SYNCING_RESULTS') LIMIT 1
      `).get() as SqliteRow | undefined
      if (busy) throw new PeerConflictError('executor already has an active remote job')
      const now = new Date().toISOString()
      this.db.prepare(`
        INSERT INTO remote_jobs(
          attempt_id, task_id, run_id, owner_node_id, executor_node_id, lease_id, epoch,
          input_sha256, input_size_bytes, input_original_name, parameters_json, status,
          error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OFFERED', NULL, NULL, ?, ?)
      `).run(input.attemptId, input.taskId, input.runId, input.ownerNodeId, input.executorNodeId,
        input.leaseId, input.epoch, input.inputSha256, input.inputSizeBytes,
        input.inputOriginalName, JSON.stringify(input.parameters), now, now)
      const job = this.getRemoteJob(input.attemptId) as RemoteJobRecord
      this.db.exec('COMMIT')
      return job
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  transitionRemoteJob(
    attemptId: string, leaseId: string, epoch: number,
    from: RemoteJobRecord['status'], to: RemoteJobRecord['status'],
    error?: { code: string; message: string },
  ): RemoteJobRecord {
    const allowed: Record<RemoteJobRecord['status'], readonly RemoteJobRecord['status'][]> = {
      OFFERED: ['TRANSFERRING', 'FAILED', 'CANCELLED'],
      TRANSFERRING: ['OFFERED', 'INPUT_READY', 'FAILED', 'CANCELLED'],
      INPUT_READY: ['RUNNING', 'FAILED', 'CANCELLED'],
      RUNNING: ['SYNCING_RESULTS', 'FAILED', 'CANCELLED'],
      SYNCING_RESULTS: ['COMPLETED', 'FAILED', 'CANCELLED'],
      COMPLETED: [], FAILED: [], CANCELLED: [],
    }
    if (!allowed[from].includes(to)) throw new PeerConflictError(`remote job transition ${from} -> ${to} is invalid`)
    const updated = this.db.prepare(`
      UPDATE remote_jobs SET status = ?, error_code = ?, error_message = ?, updated_at = ?
      WHERE attempt_id = ? AND lease_id = ? AND epoch = ? AND status = ?
    `).run(to, error?.code?.slice(0, 100) ?? null, error?.message?.slice(0, 2_000) ?? null,
      new Date().toISOString(), attemptId, leaseId, epoch, from)
    if (Number(updated.changes) !== 1) throw new PeerConflictError('remote job was changed or its lease is stale')
    return this.getRemoteJob(attemptId) as RemoteJobRecord
  }

  recordRemoteJobError(attemptId: string, leaseId: string, epoch: number, code: string, message: string): void {
    const updated = this.db.prepare(`
      UPDATE remote_jobs SET error_code = ?, error_message = ?, updated_at = ?
      WHERE attempt_id = ? AND lease_id = ? AND epoch = ? AND status IN ('OFFERED', 'TRANSFERRING')
    `).run(code.slice(0, 100), message.slice(0, 2_000), new Date().toISOString(), attemptId, leaseId, epoch)
    if (Number(updated.changes) !== 1) throw new PeerConflictError('remote job was changed or its lease is stale')
  }

  claimQueuedTaskLease(
    taskId: string, executorNodeId: string, ownerNodeId: string,
    expectedVersion: number, ttlMs: number, now = new Date(),
  ): { task: TaskRecord; lease: LeaseRecord } {
    if (!Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 4 * 60 * 60_000) throw new LeaseConflictError('lease TTL is invalid')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const task = this.getTask(taskId)
      if (!task) throw new TaskNotFoundError(taskId)
      if (task.version !== expectedVersion) throw new VersionConflictError(expectedVersion, task.version)
      if (task.ownerNodeId !== ownerNodeId) throw new LeaseConflictError('this node does not own the task')
      if (task.executionStatus !== 'QUEUED') throw new LeaseConflictError('task must be QUEUED before leasing')
      const peer = this.getPeer(executorNodeId)
      const requiredAedtVersion = typeof task.requirementSnapshot.aedtVersion === 'string' ? task.requirementSnapshot.aedtVersion : undefined
      if (!peer || !this.listAvailablePeers(requiredAedtVersion, now).some(item => item.nodeId === executorNodeId)) {
        throw new LeaseConflictError('executor peer is not trusted, ready, fresh, or idle')
      }
      const activeCount = this.activeLeaseCount(executorNodeId, now)
      if (Math.max(activeCount, peer.activeAttempts) >= peer.maxConcurrent) throw new LeaseConflictError('executor peer has no free capacity')
      const epoch = Number((this.db.prepare('SELECT COALESCE(MAX(epoch), 0) AS epoch FROM leases WHERE task_id = ?')
        .get(taskId) as SqliteRow).epoch) + 1
      const issuedAt = now.toISOString()
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
      const leaseId = randomUUID()
      this.db.prepare(`
        INSERT INTO leases(id, task_id, executor_node_id, epoch, status, issued_at, expires_at,
          renewed_at, released_at, revoke_reason)
        VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, NULL, NULL, NULL)
      `).run(leaseId, taskId, executorNodeId, epoch, issuedAt, expiresAt)
      this.db.prepare(`
        UPDATE tasks SET execution_status = 'LEASED', executor_node_id = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(executorNodeId, task.version + 1, issuedAt, taskId, task.version)
      this.insertEvent({
        id: randomUUID(), taskId, eventType: 'task.lease_claimed', fromStatus: 'QUEUED', toStatus: 'LEASED',
        reason: null, payload: { leaseId, epoch, executorNodeId, expiresAt }, createdAt: issuedAt,
      })
      this.db.exec('COMMIT')
      return { task: this.getTask(taskId) as TaskRecord, lease: this.getLease(leaseId) as LeaseRecord }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  renewLease(leaseId: string, executorNodeId: string, epoch: number, ttlMs: number, now = new Date()): LeaseRecord {
    if (!Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 4 * 60 * 60_000) throw new LeaseConflictError('lease TTL is invalid')
    const lease = this.getLease(leaseId)
    if (!lease || lease.executorNodeId !== executorNodeId || lease.epoch !== epoch || lease.status !== 'ACTIVE' ||
      Date.parse(lease.expiresAt) <= now.getTime() || this.getPeer(executorNodeId)?.trustStatus !== 'TRUSTED' ||
      !this.isCurrentLease(leaseId, lease.taskId, executorNodeId, epoch, now)) throw new LeaseConflictError('lease is not current')
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
    const updated = this.db.prepare(`
      UPDATE leases SET expires_at = ?, renewed_at = ? WHERE id = ? AND status = 'ACTIVE' AND expires_at > ?
    `).run(expiresAt, now.toISOString(), leaseId, now.toISOString())
    if (Number(updated.changes) !== 1) throw new LeaseConflictError('lease was changed during renewal')
    return this.getLease(leaseId) as LeaseRecord
  }

  isCurrentLease(leaseId: string, taskId: string, executorNodeId: string, epoch: number, now = new Date()): boolean {
    const lease = this.getLease(leaseId)
    const task = this.getTask(taskId)
    return Boolean(lease && lease.taskId === taskId && lease.executorNodeId === executorNodeId &&
      lease.epoch === epoch && lease.status === 'ACTIVE' && Date.parse(lease.expiresAt) > now.getTime() &&
      this.getPeer(executorNodeId)?.trustStatus === 'TRUSTED' &&
      task?.executorNodeId === executorNodeId && ['LEASED', 'TRANSFERRING', 'RUNNING', 'SYNCING_RESULTS'].includes(task.executionStatus))
  }

  reconcileLeases(now = new Date()): LeaseRecord[] {
    const expired = (this.db.prepare(`
      SELECT leases.* FROM leases JOIN peers ON peers.node_id = leases.executor_node_id
      WHERE leases.status = 'ACTIVE' AND (leases.expires_at <= ? OR peers.trust_status = 'REVOKED')
      ORDER BY leases.expires_at ASC
    `).all(now.toISOString()) as SqliteRow[]).map(decodeLease)
    for (const lease of expired) {
      const revoked = this.getPeer(lease.executorNodeId)?.trustStatus === 'REVOKED'
      this.endLease(lease.id, revoked ? 'REVOKED' : 'EXPIRED', now, revoked ? 'peer revoked' : 'lease expired')
    }
    return expired
  }

  revokePeer(nodeId: string, now = new Date()): PeerRecord {
    const peer = this.getPeer(nodeId)
    if (!peer) throw new PeerConflictError('peer was not found')
    this.db.prepare(`UPDATE peers SET trust_status = 'REVOKED', revoked_at = ?, last_seen_at = NULL WHERE node_id = ?`)
      .run(now.toISOString(), nodeId)
    const active = (this.db.prepare(`SELECT id FROM leases WHERE executor_node_id = ? AND status = 'ACTIVE'`)
      .all(nodeId) as SqliteRow[]).map(row => String(row.id))
    for (const leaseId of active) this.endLease(leaseId, 'REVOKED', now, 'peer revoked')
    return this.getPeer(nodeId) as PeerRecord
  }

  private endLease(id: string, status: 'EXPIRED' | 'REVOKED', now: Date, reason: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const lease = this.getLease(id)
      if (!lease || lease.status !== 'ACTIVE') { this.db.exec('COMMIT'); return }
      const task = this.getTask(lease.taskId)
      this.db.prepare(`UPDATE leases SET status = ?, released_at = ?, revoke_reason = ? WHERE id = ? AND status = 'ACTIVE'`)
        .run(status, now.toISOString(), reason, id)
      if (task && task.executorNodeId === lease.executorNodeId && ['LEASED', 'TRANSFERRING', 'RUNNING', 'SYNCING_RESULTS'].includes(task.executionStatus)) {
        const nextStatus: ExecutionStatus = ['RUNNING', 'SYNCING_RESULTS'].includes(task.executionStatus) ? 'ESCALATED' : 'QUEUED'
        this.db.prepare(`
          UPDATE tasks SET execution_status = ?, executor_node_id = NULL, version = ?, updated_at = ?
          WHERE id = ? AND version = ?
        `).run(nextStatus, task.version + 1, now.toISOString(), task.id, task.version)
        this.insertEvent({
          id: randomUUID(), taskId: task.id, eventType: `task.lease_${status.toLowerCase()}`,
          fromStatus: task.executionStatus, toStatus: nextStatus, reason,
          payload: { leaseId: id, epoch: lease.epoch, executorNodeId: lease.executorNodeId }, createdAt: now.toISOString(),
        })
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private activeLeaseCount(executorNodeId: string, now: Date): number {
    return Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM leases WHERE executor_node_id = ? AND status = 'ACTIVE' AND expires_at > ?
    `).get(executorNodeId, now.toISOString()) as SqliteRow).count)
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
      if (current.approvalStatus === 'PENDING') throw new TaskApprovalConflictError('task already has a pending approval')
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

  approveCandidateAction(id: string, expectedVersion?: number, reason?: string): TaskRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as SqliteRow | undefined
      if (!row) throw new TaskNotFoundError(id)
      const current = decodeTask(row)
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion, current.version)
      }
      if (current.executionStatus !== 'WAITING_FOR_APPROVAL' || current.approvalStatus !== 'PENDING') {
        throw new TaskApprovalConflictError('task is not waiting for candidate approval')
      }
      if (current.thermalVerdict !== 'FAIL') {
        throw new TaskApprovalConflictError('a fan candidate can only continue a converged FAIL baseline')
      }
      assertTaskTransition(current.executionStatus, 'QUEUED')
      const now = new Date().toISOString()
      const version = current.version + 1
      this.db.prepare(`
        UPDATE tasks SET execution_status = 'QUEUED', approval_status = 'APPROVED',
          version = ?, updated_at = ? WHERE id = ? AND version = ?
      `).run(version, now, id, current.version)
      this.insertEvent({
        id: randomUUID(), taskId: id, eventType: 'task.candidate_approved',
        fromStatus: current.executionStatus, toStatus: 'QUEUED',
        reason: reason?.trim().slice(0, 500) || null,
        payload: { previousVerdict: current.thermalVerdict, approvalStatus: 'APPROVED', previousVersion: current.version, version },
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

  prepareRemoteBaseline(
    taskId: string, ownerNodeId: string, executorNodeId: string, expectedVersion: number,
    inputArtifactSha256: string, parameters: Record<string, unknown>, pluginVersion: string,
  ): { task: TaskRecord; run: RunRecord; attempt: AttemptRecord } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const task = this.getTask(taskId)
      if (!task) throw new TaskNotFoundError(taskId)
      if (task.ownerNodeId !== ownerNodeId) throw new PeerConflictError('this node does not own the task')
      if (task.version !== expectedVersion) throw new VersionConflictError(expectedVersion, task.version)
      if (task.executionStatus !== 'READY' || this.listTaskRuns(taskId).length > 0) {
        throw new PeerConflictError('remote baseline requires a READY task without an existing Run')
      }
      if (!this.getArtifact(inputArtifactSha256)) throw new PeerConflictError('input artifact is not stored locally')
      const now = new Date().toISOString()
      const runId = randomUUID()
      const attemptId = randomUUID()
      this.db.prepare(`
        INSERT INTO runs(id, task_id, kind, sequence, status, selected_attempt_id, created_at, updated_at)
        VALUES (?, ?, 'BASELINE', 1, 'PLANNED', NULL, ?, ?)
      `).run(runId, taskId, now, now)
      this.db.prepare(`
        INSERT INTO attempts(
          id, run_id, executor_node_id, status, plugin_id, plugin_version,
          parameters_json, progress_stage, input_artifact_sha256, output_artifact_sha256,
          started_at, heartbeat_at, finished_at, error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, 'QUEUED', 'icepak-pyaedt', ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(attemptId, runId, executorNodeId, pluginVersion, JSON.stringify(parameters), inputArtifactSha256, now, now)
      this.db.prepare(`
        INSERT INTO attempt_artifacts(attempt_id, sha256, role, created_at)
        VALUES (?, ?, 'INPUT_PROJECT', ?)
      `).run(attemptId, inputArtifactSha256, now)
      this.db.prepare(`
        UPDATE tasks SET execution_status = 'QUEUED', version = ?, updated_at = ? WHERE id = ? AND version = ?
      `).run(task.version + 1, now, taskId, task.version)
      this.insertEvent({ id: randomUUID(), taskId, eventType: 'run.remote_baseline_prepared',
        fromStatus: 'READY', toStatus: 'QUEUED', reason: '用户显式选择远程 Baseline',
        payload: { runId, attemptId, executorNodeId, inputArtifactSha256 }, createdAt: now })
      this.db.exec('COMMIT')
      return { task: this.getTask(taskId) as TaskRecord, run: this.getRun(runId) as RunRecord,
        attempt: this.getAttempt(attemptId) as AttemptRecord }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  retryRun(runId: string, expectedTaskVersion: number): { run: RunRecord; attempt: AttemptRecord; task: TaskRecord } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const runRow = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as SqliteRow | undefined
      if (!runRow) throw new Error(`run ${runId} was not found`)
      const run = decodeRun(runRow)
      if (!['FAILED', 'CANCELLED'].includes(run.status)) throw new Error('run must be failed or cancelled before retry')
      const task = this.getTask(run.taskId)
      if (!task) throw new TaskNotFoundError(run.taskId)
      if (task.version !== expectedTaskVersion) throw new VersionConflictError(expectedTaskVersion, task.version)
      if (!['FAILED', 'CANCELLED'].includes(task.executionStatus)) throw new Error('task must be failed or cancelled before retry')
      const attempts = this.listRunAttempts(runId)
      if (attempts.length >= 3) throw new Error('run exceeds the maximum of 3 attempts')
      const previous = attempts.at(-1)
      if (!previous || !['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(previous.status)) {
        throw new Error('run must have a terminal failed attempt before retry')
      }
      if (!previous.inputArtifactSha256) throw new Error('retry requires an immutable input artifact')
      const now = new Date().toISOString()
      const attempt: AttemptRecord = {
        ...previous,
        id: randomUUID(),
        status: 'QUEUED',
        progressStage: null,
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
        INSERT INTO attempts(
          id, run_id, executor_node_id, status, plugin_id, plugin_version,
          parameters_json, progress_stage, input_artifact_sha256, output_artifact_sha256,
          started_at, heartbeat_at, finished_at, error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, 'QUEUED', ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(attempt.id, runId, attempt.executorNodeId, attempt.pluginId, attempt.pluginVersion,
        JSON.stringify(attempt.parameters), attempt.inputArtifactSha256, now, now)
      this.db.prepare("UPDATE runs SET status = 'PLANNED', selected_attempt_id = NULL, updated_at = ? WHERE id = ?")
        .run(now, runId)
      const taskVersion = task.version + 1
      this.db.prepare(`
        UPDATE tasks SET execution_status = 'QUEUED', thermal_verdict = 'PENDING',
          version = ?, updated_at = ? WHERE id = ? AND version = ?
      `).run(taskVersion, now, task.id, task.version)
      this.insertEvent({
        id: randomUUID(), taskId: task.id, eventType: 'run.retry_queued',
        fromStatus: task.executionStatus, toStatus: 'QUEUED', reason: '用户显式重试失败的 Run',
        payload: { runId, previousAttemptId: previous.id, attemptId: attempt.id, attemptNumber: attempts.length + 1 },
        createdAt: now,
      })
      this.db.exec('COMMIT')
      return {
        run: this.getRun(runId) as RunRecord,
        attempt: this.getAttempt(attempt.id) as AttemptRecord,
        task: this.getTask(task.id) as TaskRecord,
      }
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

  linkLeasedResultArtifact(
    ownerNodeId: string, executorNodeId: string, taskId: string, attemptId: string,
    leaseId: string, epoch: number, artifact: ArtifactRecord,
    role: 'SOLVED_PROJECT' | 'SOLVER_RESULT' | 'CONVERGENCE_EVIDENCE' | 'LOG',
  ): AttemptArtifactRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const task = this.getTask(taskId)
      const attempt = this.getAttempt(attemptId)
      const run = attempt ? this.getRun(attempt.runId) : null
      if (!task || task.ownerNodeId !== ownerNodeId || !run || run.taskId !== taskId ||
        attempt?.executorNodeId !== executorNodeId ||
        !['QUEUED', 'STARTING', 'RUNNING'].includes(attempt.status) ||
        this.listTaskRuns(taskId).at(-1)?.id !== run.id ||
        this.listRunAttempts(run.id).at(-1)?.id !== attemptId ||
        !this.isCurrentLease(leaseId, taskId, executorNodeId, epoch)) {
        throw new LeaseConflictError('result artifact is not authorized by the current attempt lease')
      }
      const conflicting = this.listAttemptArtifacts(attemptId).find(item => item.role === role && item.sha256 !== artifact.sha256)
      if (conflicting) throw new PeerConflictError(`attempt already has a different ${role} artifact`)
      this.upsertArtifact(artifact)
      const record: AttemptArtifactRecord = { attemptId, sha256: artifact.sha256, role, createdAt: new Date().toISOString() }
      this.linkAttemptArtifact(record)
      this.db.exec('COMMIT')
      return record
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
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

  createTaskFromSkill(
    skillId: string,
    task: TaskRecord,
    parameters: Record<string, unknown>,
    initialEvidence: Record<string, Record<string, unknown>> = {},
  ): { task: TaskRecord; run: SkillRunDetail } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const skill = this.getSkill(skillId)
      if (!skill) throw new SkillNotFoundError(skillId)
      if (skill.status !== 'ENABLED') throw new SkillConflictError('skill must be ENABLED before it can run')
      this.db.prepare(`
        INSERT INTO tasks(
          id, title, description, owner_node_id, executor_node_id,
          execution_status, thermal_verdict, approval_status,
          requirement_snapshot_json, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(task.id, task.title, task.description, task.ownerNodeId, task.executorNodeId,
        task.executionStatus, task.thermalVerdict, task.approvalStatus,
        JSON.stringify(task.requirementSnapshot), task.version, task.createdAt, task.updatedAt)
      this.insertEvent({
        id: randomUUID(), taskId: task.id, eventType: 'task.created_from_skill', fromStatus: null,
        toStatus: task.executionStatus, reason: null,
        payload: { skillId, skillVersion: skill.activeVersion }, createdAt: task.createdAt,
      })
      const runId = randomUUID()
      this.db.prepare(`
        INSERT INTO skill_runs(id, skill_id, version, task_id, status, parameters_json, result_summary, started_at, finished_at)
        VALUES (?, ?, ?, ?, 'RUNNING', ?, '', ?, NULL)
      `).run(runId, skillId, skill.activeVersion, task.id, JSON.stringify(parameters), task.createdAt)
      for (const [index, step] of skill.version.definition.steps.entries()) {
        const evidence = initialEvidence[step.id]
        const status: SkillStepStatus = evidence ? 'COMPLETED' : 'PENDING'
        this.db.prepare(`
          INSERT INTO skill_run_steps(
            id, run_id, step_id, step_index, title, status, evidence_json,
            error_code, error_message, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
        `).run(randomUUID(), runId, step.id, index, step.title, status, JSON.stringify(evidence ?? {}),
          evidence ? task.createdAt : null, evidence ? task.createdAt : null)
      }
      this.db.prepare(`
        UPDATE skills SET run_count = run_count + 1, last_run_at = ?, updated_at = ? WHERE id = ?
      `).run(task.createdAt, task.createdAt, skillId)
      this.db.exec('COMMIT')
      return { task: this.getTask(task.id) as TaskRecord, run: this.getSkillRunForTask(task.id) as SkillRunDetail }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getSkillRunForTask(taskId: string): SkillRunDetail | null {
    const row = this.db.prepare('SELECT * FROM skill_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(taskId) as SqliteRow | undefined
    if (!row) return null
    const run = decodeSkillRun(row)
    const steps = this.db.prepare('SELECT * FROM skill_run_steps WHERE run_id = ? ORDER BY step_index ASC').all(run.id) as SqliteRow[]
    return { ...run, steps: steps.map(decodeSkillRunStep) }
  }

  updateSkillRunStep(
    taskId: string,
    stepId: string,
    status: SkillStepStatus,
    evidence: Record<string, unknown> = {},
    error?: { code: string; message: string },
  ): SkillRunDetail | null {
    const run = this.getSkillRunForTask(taskId)
    if (!run || run.status !== 'RUNNING') return run
    const step = run.steps.find(item => item.stepId === stepId)
    if (!step) return run
    const now = new Date().toISOString()
    const startedAt = step.startedAt ?? (status === 'RUNNING' || status === 'COMPLETED' || status === 'FAILED' ? now : null)
    const finishedAt = status === 'COMPLETED' || status === 'FAILED' || status === 'SKIPPED' ? now : null
    this.db.prepare(`
      UPDATE skill_run_steps SET status = ?, evidence_json = ?, error_code = ?, error_message = ?,
        started_at = ?, finished_at = ? WHERE id = ?
    `).run(status, JSON.stringify({ ...step.evidence, ...evidence }), error?.code ?? null,
      error?.message.slice(0, 2_000) ?? null, startedAt, finishedAt, step.id)
    return this.getSkillRunForTask(taskId)
  }

  finishSkillRunForTask(taskId: string, success: boolean, summary: string): { run: SkillRunDetail; skill: SkillDetail } | null {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.getSkillRunForTask(taskId)
      if (!run || run.status !== 'RUNNING') { this.db.exec('COMMIT'); return null }
      const now = new Date().toISOString()
      const status: SkillRunStatus = success ? 'COMPLETED' : 'FAILED'
      this.db.prepare('UPDATE skill_runs SET status = ?, result_summary = ?, finished_at = ? WHERE id = ?')
        .run(status, summary.slice(0, 2_000), now, run.id)
      if (success) {
        this.db.prepare(`
          UPDATE skills SET success_count = success_count + 1, consecutive_failures = 0, updated_at = ? WHERE id = ?
        `).run(now, run.skillId)
      } else {
        this.db.prepare(`
          UPDATE skills SET consecutive_failures = consecutive_failures + 1,
            status = CASE WHEN consecutive_failures + 1 >= 3 THEN 'NEEDS_REPAIR' ELSE status END,
            updated_at = ? WHERE id = ?
        `).run(now, run.skillId)
      }
      this.insertEvent({
        id: randomUUID(), taskId, eventType: success ? 'skill.run_completed' : 'skill.run_failed',
        fromStatus: null, toStatus: null, reason: summary.slice(0, 500),
        payload: { skillId: run.skillId, skillRunId: run.id, version: run.version }, createdAt: now,
      })
      this.db.exec('COMMIT')
      return {
        run: this.getSkillRunForTask(taskId) as SkillRunDetail,
        skill: this.getSkill(run.skillId) as SkillDetail,
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  clearSkillPublishedPath(id: string): SkillDetail {
    const result = this.db.prepare('UPDATE skills SET published_path = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
    if (Number(result.changes) !== 1) throw new SkillNotFoundError(id)
    return this.getSkill(id) as SkillDetail
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

function validatePeerIdentity(identity: PeerIdentity): void {
  if (identity.algorithm !== 'Ed25519' || !/^node-[a-f0-9]{32}$/u.test(identity.nodeId) ||
    typeof identity.publicKey !== 'string' || identity.publicKey.length > 512) {
    throw new PeerConflictError('peer identity is invalid')
  }
  try {
    const bytes = Buffer.from(identity.publicKey, 'base64url')
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' })
    const expected = `node-${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`
    if (key.asymmetricKeyType !== 'ed25519' || expected !== identity.nodeId) throw new Error('identity mismatch')
  } catch {
    throw new PeerConflictError('peer identity public key does not match its node ID')
  }
}

function decodePeer(row: SqliteRow): PeerRecord {
  return {
    nodeId: String(row.node_id), algorithm: 'Ed25519', publicKey: String(row.public_key),
    displayName: String(row.display_name), trustStatus: row.trust_status as PeerRecord['trustStatus'],
    pluginStatus: row.plugin_status as PeerRecord['pluginStatus'],
    aedtVersions: JSON.parse(String(row.aedt_versions_json)) as string[],
    maxConcurrent: Number(row.max_concurrent), activeAttempts: Number(row.active_attempts),
    lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at),
    pairedAt: String(row.paired_at), revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
  }
}

function decodeLease(row: SqliteRow): LeaseRecord {
  return {
    id: String(row.id), taskId: String(row.task_id), executorNodeId: String(row.executor_node_id),
    epoch: Number(row.epoch), status: row.status as LeaseRecord['status'],
    issuedAt: String(row.issued_at), expiresAt: String(row.expires_at),
    renewedAt: row.renewed_at === null ? null : String(row.renewed_at),
    releasedAt: row.released_at === null ? null : String(row.released_at),
    revokeReason: row.revoke_reason === null ? null : String(row.revoke_reason),
  }
}

function decodeRemoteJob(row: SqliteRow): RemoteJobRecord {
  return {
    attemptId: String(row.attempt_id), taskId: String(row.task_id), runId: String(row.run_id),
    ownerNodeId: String(row.owner_node_id), executorNodeId: String(row.executor_node_id),
    leaseId: String(row.lease_id), epoch: Number(row.epoch),
    inputSha256: String(row.input_sha256), inputSizeBytes: Number(row.input_size_bytes),
    inputOriginalName: String(row.input_original_name), parameters: parseObject(row.parameters_json),
    status: row.status as RemoteJobRecord['status'],
    errorCode: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
    errorMessage: row.error_message === null || row.error_message === undefined ? null : String(row.error_message),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
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
    runCount: Number(row.run_count ?? 0),
    successCount: Number(row.success_count ?? 0),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    lastRunAt: row.last_run_at === null || row.last_run_at === undefined ? null : String(row.last_run_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function decodeSkillRun(row: SqliteRow): SkillRunRecord {
  return {
    id: String(row.id), skillId: String(row.skill_id), version: Number(row.version), taskId: String(row.task_id),
    status: row.status as SkillRunStatus, parameters: parseObject(row.parameters_json), resultSummary: String(row.result_summary),
    startedAt: String(row.started_at), finishedAt: row.finished_at === null ? null : String(row.finished_at),
  }
}

function decodeSkillRunStep(row: SqliteRow): SkillRunStepRecord {
  return {
    id: String(row.id), runId: String(row.run_id), stepId: String(row.step_id), stepIndex: Number(row.step_index),
    title: String(row.title), status: row.status as SkillStepStatus, evidence: parseObject(row.evidence_json),
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
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
