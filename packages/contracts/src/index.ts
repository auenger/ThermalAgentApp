export const EXECUTION_STATUSES = [
  'DRAFT',
  'READY',
  'QUEUED',
  'LEASED',
  'TRANSFERRING',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'SYNCING_RESULTS',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'ESCALATED',
] as const

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number]

export const THERMAL_VERDICTS = ['PENDING', 'PASS', 'FAIL', 'INVALID', 'DIVERGED'] as const
export type ThermalVerdict = (typeof THERMAL_VERDICTS)[number]

export const APPROVAL_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const PLUGIN_STATUSES = [
  'NOT_INSTALLED',
  'DETECTED',
  'NEEDS_CONFIG',
  'LAUNCHABLE',
  'PROJECT_COMPATIBLE',
  'READY',
  'BUSY',
  'DEGRADED',
] as const

export type PluginStatus = (typeof PLUGIN_STATUSES)[number]

export interface TaskRecord {
  id: string
  title: string
  description: string
  ownerNodeId: string
  executorNodeId: string | null
  executionStatus: ExecutionStatus
  thermalVerdict: ThermalVerdict
  approvalStatus: ApprovalStatus
  requirementSnapshot: Record<string, unknown>
  version: number
  createdAt: string
  updatedAt: string
}

export interface CreateTaskInput {
  title: string
  description: string
  ownerNodeId: string
  requirementSnapshot: Record<string, unknown>
}

export interface TaskTransitionInput {
  status: ExecutionStatus
  expectedVersion?: number
  reason?: string
}

export interface TaskEvent {
  id: string
  taskId: string
  eventType: string
  fromStatus: ExecutionStatus | null
  toStatus: ExecutionStatus | null
  reason: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export interface ArtifactRecord {
  sha256: string
  sizeBytes: number
  mediaType: string
  originalName: string
  relativePath: string
  createdAt: string
}

export interface IcepakEnvironmentProbe {
  pluginId: string
  pluginVersion: string
  protocolVersion: string
  status: PluginStatus
  platform: string
  aedtVersions: string[]
  selectedVersion: string | null
  pyaedtAvailable: boolean
  licenseStatus: 'UNKNOWN' | 'AVAILABLE' | 'UNAVAILABLE'
  capabilities: string[]
  diagnostics: string[]
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  protocolVersion: string
  entrypoint: string[]
  platforms: string[]
  capabilities: string[]
  maxConcurrency: number
}

export interface RpcRequest {
  id: string
  method: string
  params?: Record<string, unknown>
}

export interface RpcSuccess {
  id: string
  ok: true
  result: unknown
}

export interface RpcFailure {
  id: string
  ok: false
  error: { code: string; message: string; details?: unknown }
}

export type RpcResponse = RpcSuccess | RpcFailure

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`)
  return normalized
}

export function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return typeof value === 'string' && (EXECUTION_STATUSES as readonly string[]).includes(value)
}

export function parseCreateTaskInput(value: unknown): CreateTaskInput {
  if (!isObject(value)) throw new Error('request body must be an object')
  const requirementSnapshot = value.requirementSnapshot ?? {}
  if (!isObject(requirementSnapshot)) throw new Error('requirementSnapshot must be an object')
  return {
    title: requiredText(value.title, 'title', 200),
    description: typeof value.description === 'string' ? value.description.trim().slice(0, 20_000) : '',
    ownerNodeId: requiredText(value.ownerNodeId, 'ownerNodeId', 200),
    requirementSnapshot,
  }
}

export function parseTaskTransitionInput(value: unknown): TaskTransitionInput {
  if (!isObject(value)) throw new Error('request body must be an object')
  if (!isExecutionStatus(value.status)) throw new Error('status is invalid')
  if (value.expectedVersion !== undefined && (!Number.isInteger(value.expectedVersion) || Number(value.expectedVersion) < 1)) {
    throw new Error('expectedVersion must be a positive integer')
  }
  return {
    status: value.status,
    expectedVersion: value.expectedVersion === undefined ? undefined : Number(value.expectedVersion),
    reason: typeof value.reason === 'string' ? value.reason.trim().slice(0, 500) : undefined,
  }
}
