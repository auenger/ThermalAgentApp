export type ParameterRole = 'design' | 'operating-condition' | 'unclassified'
export interface ParameterValueSchema {
  version: 1
  type: 'number' | 'enum'
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  values?: string[]
  defaultValue?: string
  hint?: string
}
export interface IcepakEditableParameter {
  id: string
  label: string
  adapter: string
  adapterVersion?: string
  adapterLabel?: string
  valueSchema?: ParameterValueSchema
  target: string
  currentValue: string
  fingerprint: string
  unit: string
  role: ParameterRole
  min?: number
  max?: number
  choices?: string[]
}

/** Compatibility for archived catalogs; new adapters must carry their own declarative schema. */
export function parameterValueSchema(parameter: IcepakEditableParameter): ParameterValueSchema {
  if (parameter.valueSchema !== undefined) return parameter.valueSchema
  if (!['variable', 'material', 'boundary-power', 'fan'].includes(parameter.adapter)) throw new Error('新参数适配器必须提供 valueSchema')
  return { version: 1, type: parameter.choices ? 'enum' : 'number', values: parameter.choices,
    minimum: parameter.min, maximum: parameter.max,
    ...(parameter.adapter === 'fan' ? { exclusiveMinimum: 1, defaultValue: '1.1', hint: '1.1 表示转速 +10%，允许 >1 至 1.5' } : {}) }
}

/** Treat plugin catalogs as protocol input, not trusted TypeScript objects. */
export function parseEditableParameters(value: unknown): IcepakEditableParameter[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('参数目录格式无效')
  const seen = new Set<string>()
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数描述格式无效')
    const p = raw as IcepakEditableParameter
    for (const key of ['id', 'label', 'adapter', 'target', 'currentValue', 'fingerprint'] as const) {
      if (typeof p[key] !== 'string' || !p[key] || p[key].length > 500) throw new Error('参数描述缺少有效标识')
    }
    if (seen.has(p.id) || !/^[a-z][a-z0-9-]{0,79}$/u.test(p.adapter) || typeof p.unit !== 'string' || p.unit.length > 80 ||
      !['design', 'operating-condition', 'unclassified'].includes(p.role)) throw new Error('参数标识或用途无效')
    seen.add(p.id)
    if (p.adapterVersion !== undefined && (typeof p.adapterVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(p.adapterVersion))) throw new Error('参数适配器版本无效')
    if (p.valueSchema !== undefined && p.adapterVersion === undefined) throw new Error('参数 Schema 必须绑定适配器版本')
    if (p.adapterLabel !== undefined && (typeof p.adapterLabel !== 'string' || !p.adapterLabel || p.adapterLabel.length > 150)) throw new Error('参数适配器名称无效')
    const schema = parameterValueSchema(p)
    if (!schema || schema.version !== 1 || !['number', 'enum'].includes(schema.type)) throw new Error('不支持的参数 Schema')
    if (Object.keys(schema).some(key => !['version', 'type', 'minimum', 'maximum', 'exclusiveMinimum', 'values', 'defaultValue', 'hint'].includes(key))) throw new Error('不支持的参数 Schema 字段')
    for (const bound of [schema.minimum, schema.maximum, schema.exclusiveMinimum]) {
      if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) throw new Error('参数范围必须是有限数值')
    }
    if (schema.maximum !== undefined && ((schema.minimum !== undefined && schema.minimum > schema.maximum) ||
      (schema.exclusiveMinimum !== undefined && schema.exclusiveMinimum >= schema.maximum))) throw new Error('参数范围为空')
    if (schema.type === 'enum' && (!Array.isArray(schema.values) || !schema.values.length || schema.values.length > 1000 ||
      schema.values.some(item => typeof item !== 'string' || !item || item.length > 200) || new Set(schema.values).size !== schema.values.length)) throw new Error('参数选项无效')
    if (schema.type === 'number' && schema.values !== undefined) throw new Error('数值参数不得包含枚举选项')
    for (const key of ['defaultValue', 'hint'] as const) {
      if (schema[key] !== undefined && (typeof schema[key] !== 'string' || schema[key]!.length > 500)) throw new Error('参数提示无效')
    }
    return structuredClone(p)
  })
}

/** Same physical-value comparison used by Python readback; enum labels remain exact strings. */
export function parameterValuesEqual(parameter: IcepakEditableParameter, actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false
  if (parameterValueSchema(parameter).type === 'enum') return actual === expected
  const numeric = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\s]*)\s*$/u
  const a = actual.match(numeric), b = expected.match(numeric)
  if (!a || !b || a[2] !== parameter.unit || b[2] !== parameter.unit) return false
  const left = Number(a[1]), right = Number(b[1])
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= Math.max(1e-12, 1e-9 * Math.max(Math.abs(left), Math.abs(right)))
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
  parameters = parseEditableParameters(parameters)
  return request.changes.map(change => {
    const parameter = parameters.find(item => item.id === change.parameterId)
    if (!parameter) throw new Error(`参数不存在或不支持修改：${change.parameterId}`)
    if (parameter.role === 'operating-condition' && change.role !== parameter.role) throw new Error(`${parameter.label} 属于工况，需建立新工况基准`)
    const schema = parameterValueSchema(parameter)
    if (schema.type === 'enum') {
      if (!schema.values!.includes(change.value)) throw new Error(`${parameter.label} 的目标值不在可选列表中`)
    } else {
      const match = change.value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\s]*)$/u)
      if (!match || !Number.isFinite(Number(match[1])) || match[2] !== parameter.unit) throw new Error(`${parameter.label} 请填写数值及单位 ${parameter.unit || '（无单位）'}`)
      const number = Number(match[1])
      if ((schema.minimum !== undefined && number < schema.minimum) || (schema.maximum !== undefined && number > schema.maximum) ||
        (schema.exclusiveMinimum !== undefined && number <= schema.exclusiveMinimum)) throw new Error(`${parameter.label} 超出允许范围`)
    }
    if (parameterValuesEqual(parameter, change.value, parameter.currentValue)) throw new Error(`${parameter.label} 与原值相同`)
    return { parameter, value: change.value, role: change.role }
  })
}
