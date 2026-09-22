import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArtifactRecord, AttemptArtifactRecord, AttemptRecord, RunRecord } from '@thermal-agent/contracts'
import { ArtifactStore } from '@thermal-agent/artifact-store'
import { LocalDatabase, TaskNotFoundError } from '@thermal-agent/sqlite-store'
import type { ReportPort } from './report-client.js'
import { TaskWorkspace } from './task-workspace.js'

export class ReportConflictError extends Error {}

export interface TaskReportRecord {
  artifact: ArtifactRecord
  link: AttemptArtifactRecord
}

export class ReportManager {
  private readonly pending = new Map<string, Promise<TaskReportRecord>>()
  private readonly workspace: TaskWorkspace

  constructor(
    private readonly home: string,
    private readonly database: LocalDatabase,
    private readonly artifacts: ArtifactStore,
    private readonly reporter: ReportPort,
  ) { this.workspace = new TaskWorkspace(home) }

  getTaskReport(taskId: string): TaskReportRecord | null {
    const selected = this.selectedAttempt(taskId)
    const link = this.database.listAttemptArtifacts(selected.id).find(item => item.role === 'REPORT')
    if (!link) return null
    const artifact = this.database.getArtifact(link.sha256)
    return artifact ? { artifact, link } : null
  }

  async createTaskReport(taskId: string): Promise<TaskReportRecord> {
    const inFlight = this.pending.get(taskId)
    if (inFlight) return inFlight
    const promise = this.renderTaskReport(taskId)
    this.pending.set(taskId, promise)
    try { return await promise }
    finally { this.pending.delete(taskId) }
  }

  private async renderTaskReport(taskId: string): Promise<TaskReportRecord> {
    const existing = this.getTaskReport(taskId)
    if (existing) return existing
    const task = this.database.getTask(taskId)
    if (!task) throw new TaskNotFoundError(taskId)
    if (task.executionStatus !== 'COMPLETED' || task.approvalStatus !== 'APPROVED') {
      throw new ReportConflictError('report requires a COMPLETED task with APPROVED evidence')
    }
    const selected = this.selectedAttempt(taskId)
    const roles = new Set(this.database.listAttemptArtifacts(selected.id).map(item => item.role))
    for (const role of ['INPUT_PROJECT', 'SOLVED_PROJECT', 'SOLVER_RESULT'] as const) {
      if (!roles.has(role)) throw new ReportConflictError(`selected attempt is missing ${role} evidence`)
    }
    const runs = await Promise.all(this.database.listTaskRuns(taskId).map(async run => this.hydrateRun(run)))
    const outputDir = join(this.workspace.ensure(taskId), 'reports')
    await mkdir(outputDir, { recursive: true })
    const outputPath = join(outputDir, `${taskId}.pdf`)
    await this.reporter.renderTaskReport({
      outputPath,
      generatedAt: new Date().toISOString(),
      task: task as unknown as Record<string, unknown>,
      runs,
      events: this.database.listTaskEvents(taskId) as unknown as Array<Record<string, unknown>>,
    })
    const artifact = await this.artifacts.importFile(outputPath, `${taskId}-thermal-report.pdf`, 'application/pdf')
    this.database.upsertArtifact(artifact)
    const link = this.database.linkAttemptArtifact({
      attemptId: selected.id,
      sha256: artifact.sha256,
      role: 'REPORT',
      createdAt: new Date().toISOString(),
    })
    return { artifact, link }
  }

  private selectedAttempt(taskId: string): AttemptRecord {
    const task = this.database.getTask(taskId)
    if (!task) throw new TaskNotFoundError(taskId)
    const run = this.database.listTaskRuns(taskId).filter(item => item.selectedAttemptId).at(-1)
    if (!run?.selectedAttemptId) throw new ReportConflictError('task has no selected successful attempt')
    const attempt = this.database.getAttempt(run.selectedAttemptId)
    if (!attempt || attempt.status !== 'SUCCEEDED') throw new ReportConflictError('selected attempt is not successful')
    return attempt
  }

  private async hydrateRun(run: RunRecord): Promise<Record<string, unknown>> {
    const attempts = await Promise.all(this.database.listRunAttempts(run.id).map(async attempt => {
      const links = this.database.listAttemptArtifacts(attempt.id)
      const resultLink = links.find(item => item.role === 'SOLVER_RESULT')
      let result: unknown = null
      if (resultLink) {
        try {
          result = JSON.parse(await readFile(this.artifacts.resolveArtifact(resultLink.sha256), 'utf8')) as unknown
        } catch {
          if (attempt.id === run.selectedAttemptId) throw new ReportConflictError('selected SOLVER_RESULT artifact could not be decoded')
          result = { evidenceError: 'SOLVER_RESULT artifact could not be decoded' }
        }
      }
      if (attempt.id === run.selectedAttemptId && (typeof result !== 'object' || result === null || !('metrics' in result))) {
        throw new ReportConflictError('selected SOLVER_RESULT has no metrics evidence')
      }
      return { ...attempt, artifacts: links, result }
    }))
    return { ...run, attempts }
  }
}
