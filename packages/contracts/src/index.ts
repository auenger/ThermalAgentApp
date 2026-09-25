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

export const SKILL_STATUSES = ['DRAFT', 'ENABLED', 'DISABLED', 'NEEDS_REPAIR'] as const
export type SkillStatus = (typeof SKILL_STATUSES)[number]
export const SKILL_RUN_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED'] as const
export type SkillRunStatus = (typeof SKILL_RUN_STATUSES)[number]
export const SKILL_STEP_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED'] as const
export type SkillStepStatus = (typeof SKILL_STEP_STATUSES)[number]

export interface ThermalSkillStep {
  id: string
  title: string
  description: string
  verification: string
}

export interface ThermalSkillDefinition {
  parameters: Array<{ key: string; description: string; required: boolean }>
  steps: ThermalSkillStep[]
  permissions: string[]
  successCriteria: string[]
  failureStrategy: string
  optimization?: OptimizationSkillGuidance
}

/** Built-in engineering hypothesis, not a validated cooling result or executable Skill Run. */
export interface OptimizationSkillGuidance {
  priority: number
  mechanism: string
  diagnosticBasis: string
  measure: string
  expectedTemperatureDrop: string
  applicability: 'LOCAL_ADJUSTABLE' | 'CUSTOMER_RECOMMENDATION' | 'COST_WEIGHT_TRADEOFF'
  constraints: string
  keywords: string[]
}

export interface OptimizationSkillInput {
  name: string
  description: string
  guidance: OptimizationSkillGuidance
}

export interface UpdateOptimizationSkillInput extends OptimizationSkillInput {
  expectedVersion: number
  changeSummary: string
}

export interface OptimizationRecommendation {
  skillId: string
  activeVersion: number
  key: string
  name: string
  guidance: OptimizationSkillGuidance
  matchedSignals: string[]
  suggested: boolean
  evidenceStatus: 'UNVERIFIED'
}

export interface ModelCapabilityAssessment {
  modelSha256: string
  modelKind: 'AEDT' | 'CAD'
  status: 'READY_FOR_BASELINE' | 'NEEDS_MODEL_PREPARATION' | 'INSPECTION_FAILED'
  checkedAt: string
  aedtVersion: string | null
  projectName: string | null
  activeDesign: string | null
  setups: string[]
  items: Array<{
    skillKey: string
    status: 'EXECUTABLE' | 'ADVISORY_ONLY' | 'NEEDS_MAPPING' | 'UNAVAILABLE'
    targetNames: string[]
    reason: string
  }>
  diagnostics: string[]
  parameterCatalog?: IcepakParameterCatalog
}

/** Read-only AEDT inventory. Discovery does not authorize an edit. */
export interface IcepakParameterCatalog {
  schemaVersion: 1
  variables: Array<{ name: string; scope: 'design' | 'project'; expression: string; units: string; used: boolean | null; readOnly: boolean }>
  materials: Array<{ objectName: string; materialName: string }>
  boundaries: Array<{ name: string; type: string; properties: Record<string, unknown> }>
  fans: Array<{ name: string; flowType: string; properties: Record<string, unknown>; actionStatus: 'DISCOVERED' | 'VERIFIED' }>
  setups: string[]
  diagnostics: string[]
}

export interface SkillRecord {
  id: string
  key: string
  kind: 'WORKFLOW' | 'OPTIMIZATION'
  name: string
  description: string
  status: SkillStatus
  activeVersion: number
  sourceTaskCount: number
  publishedPath: string | null
  runCount: number
  successCount: number
  consecutiveFailures: number
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SkillRunRecord {
  id: string
  skillId: string
  version: number
  taskId: string
  status: SkillRunStatus
  parameters: Record<string, unknown>
  resultSummary: string
  startedAt: string
  finishedAt: string | null
}

export interface SkillRunStepRecord {
  id: string
  runId: string
  stepId: string
  stepIndex: number
  title: string
  status: SkillStepStatus
  evidence: Record<string, unknown>
  errorCode: string | null
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface SkillRunDetail extends SkillRunRecord { steps: SkillRunStepRecord[] }

export interface CreateSkillRunInput {
  title: string
  description: string
  projectPath: string
  targetTmaxC?: number
  version?: string
  cores?: number
}

export interface SkillVersionRecord {
  id: string
  skillId: string
  version: number
  definition: ThermalSkillDefinition
  changeSummary: string
  createdAt: string
}

export interface SkillSourceRecord {
  skillId: string
  taskId: string
  evidence: Record<string, unknown>
  createdAt: string
}

export interface SkillDetail extends SkillRecord {
  version: SkillVersionRecord
  sources: SkillSourceRecord[]
}

export interface SkillReviewInput {
  reviewer: string
  expectedUpdatedAt: string
}

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

export interface PeerIdentity {
  nodeId: string
  algorithm: 'Ed25519'
  publicKey: string
}

export interface PeerRecord extends PeerIdentity {
  displayName: string
  trustStatus: 'TRUSTED' | 'REVOKED'
  pluginStatus: PluginStatus
  aedtVersions: string[]
  maxConcurrent: number
  activeAttempts: number
  freeDiskBytes: number | null
  lastSeenAt: string | null
  pairedAt: string
  revokedAt: string | null
}

export interface PeerHeartbeat {
  pluginStatus: PluginStatus
  aedtVersions: string[]
  maxConcurrent: number
  activeAttempts: number
  freeDiskBytes?: number
}

export const PEER_SECURE_PROTOCOL = 'thermal-agent-secure-peer-v1' as const
export const PEER_SECURE_MAX_PLAINTEXT_BYTES = 256 * 1024

export interface LeaseRecord {
  id: string
  taskId: string
  executorNodeId: string
  epoch: number
  status: 'ACTIVE' | 'EXPIRED' | 'RELEASED' | 'REVOKED'
  issuedAt: string
  expiresAt: string
  renewedAt: string | null
  releasedAt: string | null
  revokeReason: string | null
}

export interface RemoteJobRecord {
  attemptId: string
  taskId: string
  runId: string
  ownerNodeId: string
  executorNodeId: string
  leaseId: string
  epoch: number
  inputSha256: string
  inputSizeBytes: number
  inputOriginalName: string
  parameters: Record<string, unknown>
  status: 'OFFERED' | 'TRANSFERRING' | 'INPUT_READY' | 'RUNNING' | 'SYNCING_RESULTS' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  solvedSha256: string | null
  resultSha256: string | null
  convergenceSha256: string | null
  errorCode: string | null
  errorMessage: string | null
  failureNotificationStatus: 'PENDING' | 'ACKED' | 'EXPIRED' | null
  createdAt: string
  updatedAt: string
}

export interface AutoDispatchRecord {
  taskId: string
  inputSha256: string
  parameters: Record<string, unknown>
  status: 'WAITING' | 'DELIVERED' | 'CANCELLED' | 'FAILED'
  selectedPeerNodeId: string | null
  errorCode: string | null
  errorMessage: string | null
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

export interface TaskApprovalDecisionInput {
  decision: 'APPROVED' | 'REJECTED'
  expectedVersion?: number
  reason?: string
}

export interface ExpectedVersionInput { expectedVersion: number }

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

export interface AttemptArtifactRecord {
  attemptId: string
  sha256: string
  role: 'INPUT_PROJECT' | 'SOLVED_PROJECT' | 'SOLVER_RESULT' | 'CONVERGENCE_EVIDENCE' | 'REPORT' | 'LOG'
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
  readinessVerifiedAt?: string
  readinessExpiresAt?: string
}

export interface IcepakReadinessRecord {
  version: string
  pluginVersion: string
  resultSha256: string
  source: 'LOCAL_ATTEMPT' | 'REMOTE_JOB'
  sourceId: string
  verifiedAt: string
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

export interface IcepakCandidateInput {
  expectedVersion?: number
  version?: string
  setup?: string
  cores?: number
  fanSpeedRatio: number
  flowConvergenceCriterion?: number
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
  parameterCatalog?: IcepakParameterCatalog
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

export function parseTaskApprovalDecisionInput(value: unknown): TaskApprovalDecisionInput {
  if (!isObject(value)) throw new Error('request body must be an object')
  if (value.decision !== 'APPROVED' && value.decision !== 'REJECTED') throw new Error('decision is invalid')
  if (value.expectedVersion !== undefined && (!Number.isInteger(value.expectedVersion) || Number(value.expectedVersion) < 1)) {
    throw new Error('expectedVersion must be a positive integer')
  }
  return {
    decision: value.decision,
    expectedVersion: value.expectedVersion === undefined ? undefined : Number(value.expectedVersion),
    reason: typeof value.reason === 'string' ? value.reason.trim().slice(0, 500) : undefined,
  }
}

export function parseExpectedVersionInput(value: unknown): ExpectedVersionInput {
  if (!isObject(value)) throw new Error('request body must be an object')
  if (!Number.isInteger(value.expectedVersion) || Number(value.expectedVersion) < 1) {
    throw new Error('expectedVersion must be a positive integer')
  }
  return { expectedVersion: Number(value.expectedVersion) }
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

export function parseIcepakCandidateInput(value: unknown): IcepakCandidateInput {
  if (!isObject(value)) throw new Error('request body must be an object')
  const fanSpeedRatio = Number(value.fanSpeedRatio)
  if (!Number.isFinite(fanSpeedRatio) || fanSpeedRatio <= 1 || fanSpeedRatio > 1.5) {
    throw new Error('fanSpeedRatio must be greater than 1.0 and at most 1.5')
  }
  if (value.cores !== undefined && (!Number.isInteger(value.cores) || Number(value.cores) < 1)) {
    throw new Error('cores must be a positive integer')
  }
  if (value.expectedVersion !== undefined && (!Number.isInteger(value.expectedVersion) || Number(value.expectedVersion) < 1)) {
    throw new Error('expectedVersion must be a positive integer')
  }
  const flowConvergenceCriterion = value.flowConvergenceCriterion === undefined ? undefined : Number(value.flowConvergenceCriterion)
  if (flowConvergenceCriterion !== undefined && (!Number.isFinite(flowConvergenceCriterion) || flowConvergenceCriterion <= 0)) {
    throw new Error('flowConvergenceCriterion must be positive')
  }
  const minImprovementC = value.minImprovementC === undefined ? undefined : Number(value.minImprovementC)
  if (minImprovementC !== undefined && (!Number.isFinite(minImprovementC) || minImprovementC < 0)) {
    throw new Error('minImprovementC must not be negative')
  }
  return {
    fanSpeedRatio,
    expectedVersion: value.expectedVersion === undefined ? undefined : Number(value.expectedVersion),
    version: typeof value.version === 'string' && value.version.trim() ? value.version.trim().slice(0, 50) : undefined,
    setup: typeof value.setup === 'string' && value.setup.trim() ? value.setup.trim().slice(0, 200) : undefined,
    cores: value.cores === undefined ? undefined : Number(value.cores),
    flowConvergenceCriterion,
    minImprovementC,
  }
}

export function parseSkillReviewInput(value: unknown): SkillReviewInput {
  if (!isObject(value)) throw new Error('request body must be an object')
  const expectedUpdatedAt = requiredText(value.expectedUpdatedAt, 'expectedUpdatedAt', 100)
  if (Number.isNaN(Date.parse(expectedUpdatedAt))) throw new Error('expectedUpdatedAt is invalid')
  return {
    reviewer: requiredText(value.reviewer, 'reviewer', 200),
    expectedUpdatedAt,
  }
}

export function parseOptimizationSkillInput(value: unknown): OptimizationSkillInput {
  if (!isObject(value) || !isObject(value.guidance)) throw new Error('optimization skill and guidance must be objects')
  const guidance = value.guidance
  const priority = Number(guidance.priority)
  if (!Number.isInteger(priority) || priority < 1 || priority > 999) throw new Error('priority must be an integer from 1 to 999')
  const applicability = guidance.applicability
  if (!['LOCAL_ADJUSTABLE', 'CUSTOMER_RECOMMENDATION', 'COST_WEIGHT_TRADEOFF'].includes(String(applicability))) {
    throw new Error('applicability is invalid')
  }
  const rawKeywords = typeof guidance.keywords === 'string'
    ? guidance.keywords.split(/[,，、;；\n]/u)
    : guidance.keywords
  if (!Array.isArray(rawKeywords) || rawKeywords.length > 30 || rawKeywords.some(item => typeof item !== 'string')) {
    throw new Error('keywords must be a string or an array of at most 30 strings')
  }
  const keywords = [...new Set(rawKeywords.map(item => item.trim()).filter(Boolean))]
  if (!keywords.length || keywords.some(item => item.length > 50)) throw new Error('keywords must contain 1 to 30 terms of at most 50 characters')
  return {
    name: requiredText(value.name, 'name', 200),
    description: requiredText(value.description, 'description', 2_000),
    guidance: {
      priority,
      mechanism: requiredText(guidance.mechanism, 'mechanism', 2_000),
      diagnosticBasis: requiredText(guidance.diagnosticBasis, 'diagnosticBasis', 4_000),
      measure: requiredText(guidance.measure, 'measure', 4_000),
      expectedTemperatureDrop: requiredText(guidance.expectedTemperatureDrop, 'expectedTemperatureDrop', 500),
      applicability: applicability as OptimizationSkillGuidance['applicability'],
      constraints: requiredText(guidance.constraints, 'constraints', 4_000),
      keywords,
    },
  }
}

export function parseUpdateOptimizationSkillInput(value: unknown): UpdateOptimizationSkillInput {
  if (!isObject(value)) throw new Error('request body must be an object')
  if (!Number.isInteger(value.expectedVersion) || Number(value.expectedVersion) < 1) throw new Error('expectedVersion must be a positive integer')
  return {
    ...parseOptimizationSkillInput(value),
    expectedVersion: Number(value.expectedVersion),
    changeSummary: requiredText(value.changeSummary, 'changeSummary', 500),
  }
}

export function parseCreateSkillRunInput(value: unknown): CreateSkillRunInput {
  if (!isObject(value)) throw new Error('request body must be an object')
  const projectPath = requiredText(value.projectPath, 'projectPath', 4_096)
  if (!projectPath.toLowerCase().endsWith('.aedt')) throw new Error('projectPath must reference an .aedt file')
  if (value.targetTmaxC !== undefined && !Number.isFinite(Number(value.targetTmaxC))) {
    throw new Error('targetTmaxC must be a finite number')
  }
  if (value.cores !== undefined && (!Number.isInteger(value.cores) || Number(value.cores) < 1)) {
    throw new Error('cores must be a positive integer')
  }
  return {
    title: requiredText(value.title, 'title', 200),
    description: typeof value.description === 'string' ? value.description.trim().slice(0, 20_000) : '',
    projectPath,
    targetTmaxC: value.targetTmaxC === undefined ? undefined : Number(value.targetTmaxC),
    version: typeof value.version === 'string' && value.version.trim() ? value.version.trim().slice(0, 50) : undefined,
    cores: value.cores === undefined ? undefined : Number(value.cores),
  }
}
