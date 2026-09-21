import { randomUUID } from 'node:crypto'
import type { AttemptStatus, CreateTaskInput, ExecutionStatus, TaskRecord } from '@thermal-agent/contracts'

const TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['QUEUED', 'CANCELLED', 'ESCALATED'],
  QUEUED: ['LEASED', 'RUNNING', 'CANCELLED', 'ESCALATED'],
  LEASED: ['TRANSFERRING', 'RUNNING', 'QUEUED', 'CANCELLED', 'ESCALATED'],
  TRANSFERRING: ['RUNNING', 'QUEUED', 'FAILED', 'CANCELLED', 'ESCALATED'],
  RUNNING: ['WAITING_FOR_APPROVAL', 'SYNCING_RESULTS', 'COMPLETED', 'FAILED', 'CANCELLED', 'ESCALATED'],
  WAITING_FOR_APPROVAL: ['QUEUED', 'LEASED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'ESCALATED'],
  SYNCING_RESULTS: ['COMPLETED', 'FAILED', 'ESCALATED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  ESCALATED: [],
}

const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  QUEUED: ['STARTING', 'CANCELLED'],
  STARTING: ['RUNNING', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: [],
}

export class InvalidTaskTransitionError extends Error {
  constructor(readonly from: ExecutionStatus, readonly to: ExecutionStatus) {
    super(`task transition ${from} -> ${to} is not allowed`)
    this.name = 'InvalidTaskTransitionError'
  }
}

export class InvalidAttemptTransitionError extends Error {
  constructor(readonly from: AttemptStatus, readonly to: AttemptStatus) {
    super(`attempt transition ${from} -> ${to} is not allowed`)
    this.name = 'InvalidAttemptTransitionError'
  }
}

export function canTransitionTask(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertTaskTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (!canTransitionTask(from, to)) throw new InvalidTaskTransitionError(from, to)
}

export function assertAttemptTransition(from: AttemptStatus, to: AttemptStatus): void {
  if (!ATTEMPT_TRANSITIONS[from].includes(to)) throw new InvalidAttemptTransitionError(from, to)
}

export function createTask(input: CreateTaskInput, now = new Date().toISOString(), id = randomUUID()): TaskRecord {
  return {
    id,
    title: input.title,
    description: input.description,
    ownerNodeId: input.ownerNodeId,
    executorNodeId: null,
    executionStatus: 'DRAFT',
    thermalVerdict: 'PENDING',
    approvalStatus: 'NONE',
    requirementSnapshot: structuredClone(input.requirementSnapshot),
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
}

export function transitionTask(task: TaskRecord, to: ExecutionStatus, now = new Date().toISOString()): TaskRecord {
  assertTaskTransition(task.executionStatus, to)
  return {
    ...task,
    executionStatus: to,
    version: task.version + 1,
    updatedAt: now,
  }
}

export function isTerminalTaskStatus(status: ExecutionStatus): boolean {
  return TRANSITIONS[status].length === 0
}
