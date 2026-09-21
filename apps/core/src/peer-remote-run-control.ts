import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import type { IcepakProjectOperationResult } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'
import { determineThermalVerdict } from './execution-manager.js'

export class PeerRemoteRunError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

interface RemoteRunReference {
  taskId: string
  attemptId: string
  leaseId: string
  epoch: number
}

export class PeerRemoteRunControl {
  constructor(
    private readonly localNodeId: string,
    private readonly database: LocalDatabase,
    private readonly artifacts: ArtifactStore,
  ) {}

  start(peerNodeId: string, value: unknown): { operation: 'task.baseline.started'; attemptId: string } {
    const reference = parseReference(value, 'task.baseline.start')
    try {
      this.database.startLeasedRemoteBaseline(this.localNodeId, peerNodeId, reference.taskId,
        reference.attemptId, reference.leaseId, reference.epoch)
    } catch {
      throw new PeerRemoteRunError('RUN_NOT_AUTHORIZED', 'remote baseline cannot start under this lease and attempt')
    }
    this.database.updateSkillRunStep(reference.taskId, 'solve', 'RUNNING', { attemptId: reference.attemptId })
    return { operation: 'task.baseline.started', attemptId: reference.attemptId }
  }

  async complete(peerNodeId: string, value: unknown): Promise<{ operation: 'task.baseline.completed'; attemptId: string; verdict: string }> {
    const reference = parseReference(value, 'task.baseline.complete')
    if (!isObject(value) || !isSha(value.solvedSha256) || !isSha(value.resultSha256)) {
      throw new PeerRemoteRunError('INVALID_RESULT', 'result artifact references are invalid')
    }
    const task = this.database.getTask(reference.taskId)
    const attempt = this.database.getAttempt(reference.attemptId)
    const run = attempt ? this.database.getRun(attempt.runId) : null
    const lease = this.database.getLease(reference.leaseId)
    if (task && attempt && run && lease?.status === 'RELEASED' &&
      lease.taskId === task.id && lease.executorNodeId === peerNodeId && lease.epoch === reference.epoch &&
      task.ownerNodeId === this.localNodeId && this.database.getPeer(peerNodeId)?.trustStatus === 'TRUSTED' &&
      attempt.executorNodeId === peerNodeId && attempt.status === 'SUCCEEDED' &&
      attempt.outputArtifactSha256 === value.solvedSha256 && run.selectedAttemptId === attempt.id &&
      this.database.listTaskRuns(task.id).at(-1)?.id === run.id &&
      this.database.listAttemptArtifacts(attempt.id).some(item => item.role === 'SOLVER_RESULT' && item.sha256 === value.resultSha256)) {
      return { operation: 'task.baseline.completed', attemptId: attempt.id, verdict: task.thermalVerdict }
    }
    if (!task || task.ownerNodeId !== this.localNodeId || !run || run.taskId !== task.id ||
      attempt?.executorNodeId !== peerNodeId || attempt.inputArtifactSha256 === null ||
      !this.database.isCurrentLease(reference.leaseId, task.id, peerNodeId, reference.epoch)) {
      throw new PeerRemoteRunError('RUN_NOT_AUTHORIZED', 'remote baseline completion is not authorized')
    }
    const resultArtifact = this.database.getArtifact(value.resultSha256)
    const solvedArtifact = this.database.getArtifact(value.solvedSha256)
    const links = this.database.listAttemptArtifacts(attempt.id)
    if (!resultArtifact || !solvedArtifact || resultArtifact.sizeBytes > 10 * 1024 * 1024 ||
      !links.some(item => item.role === 'SOLVER_RESULT' && item.sha256 === resultArtifact.sha256) ||
      !links.some(item => item.role === 'SOLVED_PROJECT' && item.sha256 === solvedArtifact.sha256)) {
      throw new PeerRemoteRunError('MISSING_EVIDENCE', 'required result artifacts are not linked to this attempt')
    }
    let result: IcepakProjectOperationResult
    try {
      const resultPath = this.artifacts.resolveArtifact(resultArtifact.sha256)
      const solvedPath = this.artifacts.resolveArtifact(solvedArtifact.sha256)
      if ((await stat(resultPath)).size !== resultArtifact.sizeBytes ||
        (await stat(solvedPath)).size !== solvedArtifact.sizeBytes ||
        await hashFile(solvedPath) !== solvedArtifact.sha256) {
        throw new Error('result artifact size changed')
      }
      const resultBytes = await readFile(resultPath)
      if (createHash('sha256').update(resultBytes).digest('hex') !== resultArtifact.sha256) throw new Error('result artifact hash changed')
      result = JSON.parse(resultBytes.toString('utf8')) as IcepakProjectOperationResult
    } catch {
      throw new PeerRemoteRunError('INVALID_RESULT', 'stored result JSON is unreadable or inconsistent')
    }
    if (!isObject(result) || result.status !== 'ok' || result.mode !== 'solve' ||
      result.inputSha256 !== attempt.inputArtifactSha256 || !isObject(result.validation) ||
      typeof result.validation.verified !== 'boolean' ||
      (result.metrics !== undefined && !isObject(result.metrics))) {
      throw new PeerRemoteRunError('INVALID_RESULT', 'solver result does not match the input or Baseline contract')
    }
    const verdict = determineThermalVerdict(result, task.requirementSnapshot)
    try {
      this.database.completeLeasedRemoteBaseline(this.localNodeId, peerNodeId, task.id, attempt.id,
        reference.leaseId, reference.epoch, solvedArtifact.sha256, resultArtifact.sha256, verdict)
    } catch {
      throw new PeerRemoteRunError('RUN_NOT_AUTHORIZED', 'remote baseline changed before completion')
    }
    this.database.updateSkillRunStep(task.id, 'solve', 'COMPLETED', { attemptId: attempt.id, outputArtifactSha256: solvedArtifact.sha256 })
    this.database.updateSkillRunStep(task.id, 'judge', 'RUNNING', { attemptId: attempt.id })
    return { operation: 'task.baseline.completed', attemptId: attempt.id, verdict }
  }

  fail(peerNodeId: string, value: unknown): { operation: 'task.baseline.failed'; attemptId: string } {
    const reference = parseReference(value, 'task.baseline.fail')
    if (!isObject(value) || typeof value.code !== 'string' || !/^[A-Z0-9_]{1,100}$/u.test(value.code) ||
      typeof value.message !== 'string' || !value.message.trim() || value.message.length > 2_000) {
      throw new PeerRemoteRunError('INVALID_RUN_REQUEST', 'remote failure details are invalid')
    }
    try {
      this.database.failLeasedRemoteBaseline(this.localNodeId, peerNodeId, reference.taskId,
        reference.attemptId, reference.leaseId, reference.epoch, value.code, value.message)
    } catch {
      throw new PeerRemoteRunError('RUN_NOT_AUTHORIZED', 'remote baseline failure is not authorized')
    }
    this.database.updateSkillRunStep(reference.taskId, 'solve', 'FAILED', { attemptId: reference.attemptId },
      { code: value.code, message: value.message })
    return { operation: 'task.baseline.failed', attemptId: reference.attemptId }
  }
}

function parseReference(value: unknown, operation: string): RemoteRunReference {
  if (!isObject(value) || value.operation !== operation || !isId(value.taskId) ||
    !isId(value.attemptId) || !isId(value.leaseId) || !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1) {
    throw new PeerRemoteRunError('INVALID_RUN_REQUEST', 'remote baseline reference is invalid')
  }
  return { taskId: value.taskId, attemptId: value.attemptId, leaseId: value.leaseId, epoch: Number(value.epoch) }
}
function isId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9-]{36}$/iu.test(value) }
function isSha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
