import type { IcepakProjectOperationResult, ModelCapabilityAssessment } from '@thermal-agent/contracts'

export const CAD_EXTENSIONS = new Set(['.step', '.stp', '.iges', '.igs', '.x_t', '.x_b', '.sat', '.sab'])

type Item = ModelCapabilityAssessment['items'][number]

function advisoryItems(): Item[] {
  return [
    { skillKey: 'optimization-01-tim', status: 'NEEDS_MAPPING', targetNames: [], reason: '需识别导热贴或接触热阻对应的模型对象；尚无自动修改器。' },
    { skillKey: 'optimization-02-fin-geometry', status: 'NEEDS_MAPPING', targetNames: [], reason: '需识别鳍片参数化几何及风阻约束；尚无自动修改器。' },
    { skillKey: 'optimization-03-heat-spreader', status: 'NEEDS_MAPPING', targetNames: [], reason: '需识别热管或 VC 几何与材料；尚无自动修改器。' },
    { skillKey: 'optimization-04-fan-selection', status: 'UNAVAILABLE', targetNames: [], reason: '尚未发现可验证的曲线型原生 Fan。' },
    { skillKey: 'optimization-05-system-vents', status: 'ADVISORY_ONLY', targetNames: [], reason: '涉及客户系统进出风结构，只形成建议，不自动修改。' },
    { skillKey: 'optimization-06-copper', status: 'NEEDS_MAPPING', targetNames: [], reason: '需指定散热器对象并核对重量、成本；尚无自动修改器。' },
  ]
}

export function cadModelAssessment(modelSha256: string): ModelCapabilityAssessment {
  return {
    modelSha256, modelKind: 'CAD', status: 'NEEDS_MODEL_PREPARATION', checkedAt: new Date().toISOString(),
    aedtVersion: null, projectName: null, activeDesign: null, setups: [],
    items: advisoryItems().map(item => ({ ...item, status: item.status === 'ADVISORY_ONLY' ? 'ADVISORY_ONLY' : 'UNAVAILABLE',
      reason: item.status === 'ADVISORY_ONLY' ? item.reason : '仅有 CAD 几何；需建立 Icepak 工程、材料、热源、边界条件及监测点后再判断。' })),
    diagnostics: ['CAD 文件已归档，但不是可直接求解的 AEDT 工程。', '尚未验证 CAD 导入、几何修复或 Icepak 建模。'],
  }
}

export function curveFanNames(result: IcepakProjectOperationResult): string[] {
  return result.project.nativeComponents.flatMap(component => {
    const properties = component.properties
    const provider = properties && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, unknown>).NativeComponentDefinitionProvider : null
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return []
    const values = provider as Record<string, unknown>
    return values.Type === 'Fan' && values.FlowType === 'Curve' && Array.isArray(values.X) && values.X.length > 0 &&
      Array.isArray(values.Y) && values.Y.length > 0 ? [String(component.name ?? '')] : []
  }).filter(Boolean)
}

export function aedtModelAssessment(
  modelSha256: string, requestedVersion: string, inspected: IcepakProjectOperationResult,
  fanCheck: IcepakProjectOperationResult | null, fanCheckError: string | null,
): ModelCapabilityAssessment {
  const items = advisoryItems()
  const fan = items.find(item => item.skillKey === 'optimization-04-fan-selection') as Item
  const names = curveFanNames(inspected)
  const verifiedFans = fanCheck?.fanAction?.verified === true
  const checkedNames = Array.isArray(fanCheck?.fanAction?.fans)
    ? (fanCheck.fanAction.fans as Array<Record<string, unknown>>).map(item => String(item.name ?? '')).filter(Boolean) : []
  if (names.length && verifiedFans && fanCheck?.validation.verified === true && checkedNames.length === names.length && names.every(name => checkedNames.includes(name))) {
    fan.status = 'EXECUTABLE'
    fan.targetNames = checkedNames
    fan.reason = '曲线型原生 Fan 的 +10% 动作已在工程副本上写入并读回验证；当前动作会同时调节列出的全部风扇。'
  } else if (names.length) {
    fan.targetNames = names
    fan.reason = `找到曲线型 Fan，但动作尚未通过写入／读回验证：${fanCheckError ?? '验证结果不完整'}`
  }
  const validSetup = inspected.validation.verified === true && inspected.project.setups.length > 0
  return {
    modelSha256, modelKind: 'AEDT', status: validSetup ? 'READY_FOR_BASELINE' : 'NEEDS_MODEL_PREPARATION',
    checkedAt: new Date().toISOString(), aedtVersion: requestedVersion,
    projectName: inspected.project.name, activeDesign: inspected.project.activeDesign, setups: inspected.project.setups,
    items, diagnostics: validSetup ? [] : ['工程检查未验证通过或缺少可用 Setup；不能启动 Baseline。'],
  }
}

export function failedAedtAssessment(modelSha256: string, version: string, reason: string): ModelCapabilityAssessment {
  return {
    modelSha256, modelKind: 'AEDT', status: 'INSPECTION_FAILED', checkedAt: new Date().toISOString(),
    aedtVersion: version, projectName: null, activeDesign: null, setups: [], items: advisoryItems(), diagnostics: [reason],
  }
}
