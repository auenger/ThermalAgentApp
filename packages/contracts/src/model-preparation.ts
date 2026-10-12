/** CAD intake and deterministic thermal model preparation, independent of Agent. */
export type ModelJobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED'
export type ModelValueSource = 'USER_INPUT' | 'CAD_METADATA' | 'TEMPLATE_DEFAULT' | 'AGENT_PROPOSAL'
export interface ModelValue<T> {
  value: T
  source: ModelValueSource
  reference: string
  confirmed: boolean
}
export interface CadObject {
  key: string
  name: string
  type: 'Solid' | 'Sheet' | 'Line'
  boundingBox: number[]
  volume: number | null
  materialName: string | null
}
export interface CadObjectCatalog {
  schemaVersion: 1
  inspectionId: string
  sourceSha256: string
  units: string
  boundingBox: number[]
  objects: CadObject[]
  diagnostics: Array<{ code: string; severity: 'INFO' | 'WARNING' | 'ERROR'; message: string; objectKeys?: string[] }>
}
export interface ThermalModelObject {
  objectKey: string
  included: boolean
  role: 'HEAT_SOURCE' | 'HEATSINK' | 'SOLID' | 'EXCLUDED'
  material: ModelValue<string>
  powerW: ModelValue<number>
  monitor: boolean
  exclusionReason: string
}
export interface ThermalModelSpec {
  schemaVersion: 1
  sourceSha256: string
  inspectionId: string
  catalogSha256: string
  templateId: 'steady-natural-convection-v1'
  templateVersion: 1
  aedtVersion: string
  units: string
  dimensionsConfirmed: boolean
  objects: ThermalModelObject[]
  ambientTemperatureC: ModelValue<number>
  gravity: ModelValue<'-X' | '+X' | '-Y' | '+Y' | '-Z' | '+Z'>
  /** Percent of model dimensions on each side, with a minimum absolute padding. */
  regionPaddingPercent: ModelValue<number>
  regionMinPaddingMm: ModelValue<number>
  meshLevel: ModelValue<number>
  maxIterations: ModelValue<number>
  flowConvergence: ModelValue<number>
  energyConvergence: ModelValue<number>
  targetTmaxC: number
  /** Explicit first-version assumption: ideal touching contacts, gaps retained, no radiation. */
  assumptionsConfirmed: boolean
  contactNotes: string
  author: string
  reason: string
}
export interface ModelArtifactLink { role: string; sha256: string; originalName: string }
export interface ModelPreparationJob {
  id: string
  taskId: string
  kind: 'INSPECT' | 'PREPARE' | 'VALIDATE'
  inspectionId: string
  preparationId: string | null
  requestId: string
  requestSha256: string
  status: ModelJobStatus
  stage: string
  input: Record<string, unknown>
  artifacts: ModelArtifactLink[]
  error: { code: string; message: string } | null
  createdAt: string
  updatedAt: string
}
export interface CadInspection {
  id: string
  taskId: string
  sourceSha256: string
  version: string
  healing: boolean
  status: ModelJobStatus
  catalog: CadObjectCatalog | null
  projectSha256: string | null
  catalogSha256: string | null
  previewSha256: string | null
  environment: Record<string, unknown> | null
  createdAt: string
}
export interface ThermalModelDraft { taskId: string; version: number; spec: ThermalModelSpec; updatedAt: string }
export interface ModelPreparation {
  id: string
  taskId: string
  revision: number
  inspectionId: string
  spec: ThermalModelSpec
  specSha256: string
  status: 'PREPARING' | 'PREPARED' | 'VALIDATING' | 'VERIFIED' | 'FAILED' | 'INTERRUPTED' | 'CANCELLED'
  projectSha256: string | null
  validationSha256: string | null
  validatedDesign?: string
  validatedSetup?: string
  createdAt: string
  updatedAt: string
}
export interface CadPluginInput {
  sourcePath: string
  sourceSha256: string
  inspectionId: string
  outputDir: string
  version: string
  healing: boolean
}
export interface ModelPluginInput {
  projectPath: string
  projectSha256: string
  catalog: CadObjectCatalog
  spec: ThermalModelSpec
  specSha256: string
  outputDir: string
}
export interface ModelPluginResult {
  status: 'ok'
  operation: 'inspect_cad' | 'prepare_model' | 'validate_model'
  inputSha256: string
  specSha256?: string
  projectPath?: string
  catalog?: CadObjectCatalog
  environment: Record<string, unknown>
  artifacts: Array<{ role: string; path: string }>
  validation?: {
    verified: boolean
    checks: string[]
    selfContained: boolean
    meshGenerated: boolean
    design: string
    setup: string
    actual: Record<string, unknown>
  }
}
export interface ModelPreparationContext {
  inspections: CadInspection[]
  draft: ThermalModelDraft | null
  preparations: ModelPreparation[]
  jobs: ModelPreparationJob[]
  recovery?: { operationId: string; method: string; message: string } | null
  materials: string[]
  template: { id: string; version: number; qualification: 'REQUIRES_WINDOWS_ACCEPTANCE'; assumptions: string[] }
}

export const THERMAL_MODEL_MATERIALS = ['aluminum', 'copper', 'silicon', 'steel', 'FR4_epoxy'] as const
export const NATURAL_CONVECTION_TEMPLATE = {
  id: 'steady-natural-convection-v1', version: 1,
  qualification: 'REQUIRES_WINDOWS_ACCEPTANCE' as const,
  assumptions: ['稳态开放环境自然对流', '直接接触采用理想接触，间隙保留', '不启用辐射', '温度监测位于所选实体中心，不代表全模型最高温度'],
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value as Record<string, unknown>
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error(`${label} 必须填写`)
  return value.trim()
}
function hash(value: unknown, label: string): string {
  const text = string(value, label)
  if (!/^[a-f0-9]{64}$/u.test(text)) throw new Error(`${label} SHA256 无效`)
  return text
}
function number(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} 必须在 ${min}–${max} 范围内`)
  return value
}
function sourced<T>(value: unknown, label: string, parse: (v: unknown) => T): ModelValue<T> {
  const v = object(value, label)
  if (!['USER_INPUT', 'CAD_METADATA', 'TEMPLATE_DEFAULT', 'AGENT_PROPOSAL'].includes(String(v.source))) throw new Error(`${label} 来源无效`)
  if (typeof v.confirmed !== 'boolean') throw new Error(`${label} 确认状态无效`)
  return { value: parse(v.value), source: v.source as ModelValueSource, reference: string(v.reference, `${label} 来源依据`), confirmed: v.confirmed }
}

/** Parse a draft without requiring every engineering confirmation yet. */
export function parseThermalModelSpec(value: unknown): ThermalModelSpec {
  const v = object(value, '建模配置')
  if (v.schemaVersion !== 1 || v.templateId !== NATURAL_CONVECTION_TEMPLATE.id || v.templateVersion !== 1) throw new Error('不支持的建模配置或模板版本')
  const bool = (key: string) => { if (typeof v[key] !== 'boolean') throw new Error(`${key} 无效`); return v[key] as boolean }
  if (!Array.isArray(v.objects) || v.objects.length < 1 || v.objects.length > 10000) throw new Error('实体配置数量无效')
  const objects = v.objects.map(raw => {
    const item = object(raw, '实体配置')
    if (!['HEAT_SOURCE', 'HEATSINK', 'SOLID', 'EXCLUDED'].includes(String(item.role)) || typeof item.included !== 'boolean' || typeof item.monitor !== 'boolean') throw new Error('实体角色/参与计算/监测状态无效')
    return { objectKey: string(item.objectKey, '实体键'), included: item.included, role: item.role as ThermalModelObject['role'],
      material: sourced(item.material, '材料', x => { if (typeof x !== 'string') throw new Error('材料无效'); return x }),
      powerW: sourced(item.powerW, '功率 W', x => number(x, '功率 W', 0, 1e7)), monitor: item.monitor,
      exclusionReason: typeof item.exclusionReason === 'string' ? item.exclusionReason.slice(0, 2000) : '' }
  })
  if (new Set(objects.map(o => o.objectKey)).size !== objects.length) throw new Error('实体配置重复')
  const integer = (x: unknown, label: string, min: number, max: number) => { const n = number(x, label, min, max); if (!Number.isInteger(n)) throw new Error(`${label} 必须是整数`); return n }
  const version = string(v.aedtVersion, 'AEDT 版本')
  if (!/^20\d{2}\.[12]$/u.test(version)) throw new Error('AEDT 版本格式应为 2024.2')
  return { schemaVersion: 1, templateId: 'steady-natural-convection-v1', templateVersion: 1,
    sourceSha256: hash(v.sourceSha256, '源 CAD'), inspectionId: string(v.inspectionId, '导入 ID'), catalogSha256: hash(v.catalogSha256, '对象清单'),
    aedtVersion: version, units: string(v.units, '单位'), dimensionsConfirmed: bool('dimensionsConfirmed'), objects,
    ambientTemperatureC: sourced(v.ambientTemperatureC, '环境温度 °C', x => number(x, '环境温度 °C', -100, 500)),
    gravity: sourced(v.gravity, '重力', x => { if (!['-X', '+X', '-Y', '+Y', '-Z', '+Z'].includes(String(x))) throw new Error('重力方向无效'); return x as ThermalModelSpec['gravity']['value'] }),
    regionPaddingPercent: sourced(v.regionPaddingPercent, '计算域余量 %', x => number(x, '计算域余量 %', 10, 1000)),
    regionMinPaddingMm: sourced(v.regionMinPaddingMm, '最小余量 mm', x => number(x, '最小余量 mm', 1, 10000)),
    meshLevel: sourced(v.meshLevel, '网格等级', x => integer(x, '网格等级', 1, 5)),
    maxIterations: sourced(v.maxIterations, '最大迭代数', x => integer(x, '最大迭代数', 10, 10000)),
    flowConvergence: sourced(v.flowConvergence, '流动收敛阈值', x => number(x, '流动收敛阈值', 1e-12, 0.1)),
    energyConvergence: sourced(v.energyConvergence, '能量收敛阈值', x => number(x, '能量收敛阈值', 1e-12, 0.1)),
    targetTmaxC: number(v.targetTmaxC, '温度目标 °C', -100, 1000), assumptionsConfirmed: bool('assumptionsConfirmed'),
    contactNotes: typeof v.contactNotes === 'string' ? v.contactNotes.slice(0, 2000) : '',
    author: typeof v.author === 'string' ? v.author.trim().slice(0, 2000) : '', reason: typeof v.reason === 'string' ? v.reason.trim().slice(0, 2000) : '' }
}

export function validateThermalModelSpec(spec: ThermalModelSpec, inspection: CadInspection): string[] {
  const issues: string[] = []
  const catalog = inspection.catalog
  if (inspection.status !== 'SUCCEEDED' || !catalog || !inspection.projectSha256 || spec.inspectionId !== inspection.id || spec.sourceSha256 !== inspection.sourceSha256 || spec.catalogSha256 !== inspection.catalogSha256) return ['导入工程/对象清单身份不一致或尚未导入成功']
  if (spec.aedtVersion !== inspection.version || spec.units !== catalog.units) issues.push('AEDT 版本或单位与导入工程不一致')
  if (!spec.author.trim() || !spec.reason.trim()) issues.push('请填写记录人和建模依据')
  if (!spec.dimensionsConfirmed) issues.push('请核对并确认模型单位与尺寸')
  if (!spec.assumptionsConfirmed || !spec.contactNotes.trim()) issues.push('请核对接触、间隙和模板假设，并填写接触说明')
  if (catalog.diagnostics.some(d => d.severity === 'ERROR')) issues.push('CAD 存在尚未解决的致命几何问题')
  const catalogKeys = new Set(catalog.objects.map(o => o.key))
  if (spec.objects.length !== catalogKeys.size || spec.objects.some(o => !catalogKeys.has(o.objectKey))) issues.push('实体映射缺失或引用了其他导入版本')
  let power = 0
  let monitors = 0
  for (const o of spec.objects) {
    const name = catalog.objects.find(c => c.key === o.objectKey)?.name ?? o.objectKey
    if (!o.included) { if (o.role !== 'EXCLUDED' || !o.exclusionReason.trim() || o.monitor || o.powerW.value !== 0) issues.push(`${name}：排除对象须说明原因且不能发热/监测`); continue }
    if (o.role === 'EXCLUDED' || catalog.objects.find(c => c.key === o.objectKey)?.type !== 'Solid') issues.push(`${name}：首版仅支持固体实体参与计算`)
    if (!(THERMAL_MODEL_MATERIALS as readonly string[]).includes(o.material.value) || !o.material.confirmed) issues.push(`${name}：请选择并确认材料`)
    if (o.role === 'HEAT_SOURCE') { power += o.powerW.value; if (o.powerW.value <= 0 || !o.powerW.confirmed) issues.push(`${name}：请填写并确认热源功率`) }
    else if (o.powerW.value !== 0) issues.push(`${name}：非热源不能施加功率`)
    if (o.monitor) monitors++
  }
  if (power <= 0) issues.push('至少需要一个正功率热源')
  if (!monitors) issues.push('至少选择一个实体温度监测')
  for (const key of ['ambientTemperatureC', 'gravity', 'regionPaddingPercent', 'regionMinPaddingMm', 'meshLevel', 'maxIterations', 'flowConvergence', 'energyConvergence'] as const) {
    if (!spec[key].confirmed) issues.push(`${key} 尚未确认（来源：${spec[key].source}）`)
  }
  return issues
}

export function createThermalModelSpec(inspection: CadInspection): ThermalModelSpec {
  if (!inspection.catalog || !inspection.catalogSha256) throw new Error('请先完成 CAD 导入')
  const user = <T>(value: T): ModelValue<T> => ({ value, source: 'USER_INPUT', reference: 'App 表单', confirmed: false })
  const template = <T>(value: T): ModelValue<T> => ({ value, source: 'TEMPLATE_DEFAULT', reference: 'steady-natural-convection-v1 / 1（待案例验收）', confirmed: false })
  return { schemaVersion: 1, sourceSha256: inspection.sourceSha256, inspectionId: inspection.id, catalogSha256: inspection.catalogSha256,
    templateId: 'steady-natural-convection-v1', templateVersion: 1, aedtVersion: inspection.version, units: inspection.catalog.units, dimensionsConfirmed: false,
    objects: inspection.catalog.objects.map(o => ({ objectKey: o.key, included: o.type === 'Solid', role: o.type === 'Solid' ? 'SOLID' : 'EXCLUDED',
      material: o.materialName ? { value: o.materialName, source: 'CAD_METADATA', reference: `CAD 实体 ${o.name}`, confirmed: false } : user(''),
      powerW: user(0), monitor: false, exclusionReason: '' })),
    ambientTemperatureC: user(25), gravity: template('-Z'), regionPaddingPercent: template(100), regionMinPaddingMm: template(20),
    meshLevel: template(3), maxIterations: template(500), flowConvergence: template(0.001), energyConvergence: template(1e-7),
    targetTmaxC: 85, assumptionsConfirmed: false, contactNotes: '', author: '', reason: '' }
}
