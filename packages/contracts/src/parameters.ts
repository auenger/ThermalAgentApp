export type ParameterRole = 'design' | 'operating-condition' | 'unclassified'
export interface IcepakEditableParameter {
  id: string
  label: string
  adapter: 'variable' | 'material' | 'boundary-power' | 'fan'
  target: string
  currentValue: string
  fingerprint: string
  unit: string
  role: ParameterRole
  min?: number
  max?: number
  choices?: string[]
}
export interface IcepakParameterChange {
  parameter: IcepakEditableParameter
  value: string
  role: Exclude<ParameterRole, 'unclassified'>
}
export interface IcepakActionResult {
  parameterId: string
  target: string
  before: string
  after: string
  verifiedAfter: string
  verified: boolean
}
export interface ParameterPlan {
  id: string
  taskId: string
  revision: number
  sourceAttemptId: string
  sourceSha256: string
  design: string
  setup: string
  aedtVersion: string
  changes: IcepakParameterChange[]
  purpose: 'design' | 'operating-condition'
  author: string
  reason: string
  status: 'CHECKING' | 'VERIFIED' | 'FAILED' | 'STARTING' | 'EXECUTED'
  createdAt: string
  updatedAt: string
  error: string | null
  verifiedProjectSha256: string | null
  evidenceSha256: string | null
  actionResults: IcepakActionResult[]
  executionTaskId: string | null
  runId: string | null
}
export interface ParameterPlanRequest {
  sourceAttemptId: string
  author: string
  reason: string
  changes: Array<{ parameterId: string; value: string; role: 'design' | 'operating-condition' }>
}

export function parseParameterPlanRequest(value: unknown): ParameterPlanRequest {
  const object = value as Record<string, unknown> | null
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('修改方案必须是对象')
  const text = (value: unknown, label: string, max: number) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}不能为空且不得超过 ${max} 字符`)
    return value.trim()
  }
  if (!Array.isArray(object.changes) || !object.changes.length || object.changes.length > 50) throw new Error('请选择 1–50 个参数')
  const seen = new Set<string>()
  const changes = object.changes.map(item => {
    if (!item || typeof item !== 'object') throw new Error('参数修改格式无效')
    const parameterId = text(item.parameterId, '参数', 500)
    if (seen.has(parameterId)) throw new Error('同一参数不能重复修改')
    seen.add(parameterId)
    if (item.role !== 'design' && item.role !== 'operating-condition') throw new Error('请标明参数属于结构设计还是工况')
    return { parameterId, value: text(item.value, '目标值', 200), role: item.role as 'design' | 'operating-condition' }
  })
  return { sourceAttemptId: text(object.sourceAttemptId, '基准记录', 100), author: text(object.author, '记录人', 100),
    reason: text(object.reason, '修改原因', 2000), changes }
}

export function resolveParameterChanges(parameters: IcepakEditableParameter[], request: ParameterPlanRequest): IcepakParameterChange[] {
  return request.changes.map(change => {
    const parameter = parameters.find(item => item.id === change.parameterId)
    if (!parameter) throw new Error(`参数不存在或不支持修改：${change.parameterId}`)
    if (parameter.role === 'operating-condition' && change.role !== parameter.role) throw new Error(`${parameter.label} 属于工况，需建立新工况基准`)
    if (parameter.choices) {
      if (!parameter.choices.includes(change.value)) throw new Error(`${parameter.label} 的目标材料不在可选列表中`)
    } else {
      const match = change.value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\s]*)$/u)
      if (!match || !Number.isFinite(Number(match[1])) || match[2] !== parameter.unit) throw new Error(`${parameter.label} 请填写数值及单位 ${parameter.unit || '（无单位）'}`)
      const number = Number(match[1])
      if ((parameter.min !== undefined && number < parameter.min) || (parameter.max !== undefined && number > parameter.max) ||
        (parameter.adapter === 'fan' && number <= 1)) throw new Error(`${parameter.label} 超出允许范围`)
    }
    const old = parameter.currentValue.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\s]*)$/u)
    const next = change.value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\s]*)$/u)
    if (change.value === parameter.currentValue || (old && next && old[2] === next[2] && Number(old[1]) === Number(next[1]))) throw new Error(`${parameter.label} 与原值相同`)
    return { parameter, value: change.value, role: change.role }
  })
}
