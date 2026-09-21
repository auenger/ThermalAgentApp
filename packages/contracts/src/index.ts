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

export const RUN_KINDS = ['BASELINE', 'CANDIDATE', 'VALIDATION'] as const
export type RunKind = (typeof RUN_KINDS)[number]

export const RUN_STATUSES = ['PLANNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const ATTEMPT_STATUSES = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
] as const
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]

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

export interface RunRecord {
  id: string
  taskId: string
  kind: RunKind
  sequence: number
  status: RunStatus
  selectedAttemptId: string | null
  createdAt: string
  updatedAt: string
}

export interface AttemptRecord {
  id: string
  runId: string
  executorNodeId: string
  status: AttemptStatus
  pluginId: string
  pluginVersion: string
  parameters: Record<string, unknown>
  progressStage: string | null
  inputArtifactSha256: string | null
  outputArtifactSha256: string | null
  startedAt: string | null
  heartbeatAt: string | null
  finishedAt: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateRunInput {
  taskId: string
  kind: RunKind
  executorNodeId: string
  pluginId: string
  pluginVersion: string
  parameters: Record<string, unknown>
  inputArtifactSha256?: string | null
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

export interface IcepakProjectOperationInput {
  projectPath: string
  version?: string
  design?: string
  setup?: string
  cores?: number
  nonGraphical?: boolean
  expectedProfile?: Record<string, unknown>
  fanSpeedRatio?: number
  flowConvergenceCriterion?: number
  baselineMetrics?: Record<string, unknown>
  minImprovementC?: number
}

export interface IcepakProjectOperationResult {
  status: 'ok'
  mode: 'inspect' | 'fan-check' | 'solve' | 'fan-solve'
  sourceProject: string
  workingProject: string
  inputSha256: string
  project: {
    name: string
    aedtVersion: string
    activeDesign: string
    designs: string[]
    setups: string[]
    boundaries: Array<Record<string, unknown>>
    nativeComponents: Array<Record<string, unknown>>
    monitors: string[]
    objects: string[]
  }
  validation: { verified: boolean; checks: string[] }
  fanAction?: Record<string, unknown>
  solve?: Record<string, unknown>
  metrics?: Record<string, unknown>
  artifacts?: Record<string, unknown>
  comparison?: Record<string, unknown>
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

export function parseIcepakProjectOperationInput(value: unknown): IcepakProjectOperationInput {
  if (!isObject(value)) throw new Error('request body must be an object')
  const projectPath = requiredText(value.projectPath, 'projectPath', 4_096)
  if (!projectPath.toLowerCase().endsWith('.aedt')) throw new Error('projectPath must reference an .aedt file')
  if (value.expectedProfile !== undefined && !isObject(value.expectedProfile)) {
    throw new Error('expectedProfile must be an object')
  }
  if (value.fanSpeedRatio !== undefined) {
    const ratio = Number(value.fanSpeedRatio)
    if (!Number.isFinite(ratio) || ratio <= 1 || ratio > 1.5) {
      throw new Error('fanSpeedRatio must be greater than 1.0 and at most 1.5')
    }
  }
  if (value.cores !== undefined && (!Number.isInteger(value.cores) || Number(value.cores) < 1)) {
    throw new Error('cores must be a positive integer')
  }
  if (value.flowConvergenceCriterion !== undefined) {
    const criterion = Number(value.flowConvergenceCriterion)
    if (!Number.isFinite(criterion) || criterion <= 0) throw new Error('flowConvergenceCriterion must be positive')
  }
  if (value.baselineMetrics !== undefined && !isObject(value.baselineMetrics)) {
    throw new Error('baselineMetrics must be an object')
  }
  if (value.minImprovementC !== undefined) {
    const threshold = Number(value.minImprovementC)
    if (!Number.isFinite(threshold) || threshold < 0) throw new Error('minImprovementC must not be negative')
  }
  return {
    projectPath,
    version: typeof value.version === 'string' && value.version.trim() ? value.version.trim().slice(0, 50) : undefined,
    design: typeof value.design === 'string' && value.design.trim() ? value.design.trim().slice(0, 200) : undefined,
    setup: typeof value.setup === 'string' && value.setup.trim() ? value.setup.trim().slice(0, 200) : undefined,
    cores: value.cores === undefined ? undefined : Number(value.cores),
    nonGraphical: value.nonGraphical !== false,
    expectedProfile: value.expectedProfile as Record<string, unknown> | undefined,
    fanSpeedRatio: value.fanSpeedRatio === undefined ? undefined : Number(value.fanSpeedRatio),
    flowConvergenceCriterion: value.flowConvergenceCriterion === undefined ? undefined : Number(value.flowConvergenceCriterion),
    baselineMetrics: value.baselineMetrics as Record<string, unknown> | undefined,
    minImprovementC: value.minImprovementC === undefined ? undefined : Number(value.minImprovementC),
  }
}
