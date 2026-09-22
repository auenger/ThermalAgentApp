import type { OptimizationSkillGuidance, ThermalSkillDefinition } from '@thermal-agent/contracts'

export interface OptimizationSkillSeed {
  key: string
  name: string
  description: string
  guidance: OptimizationSkillGuidance
}

export function optimizationDefinition(guidance: OptimizationSkillGuidance): ThermalSkillDefinition {
  return {
    parameters: [],
    steps: [
      { id: 'diagnose', title: '核对诊断依据', description: guidance.diagnosticBasis, verification: '有模型、测点或风扇曲线证据；缺少证据时仅列为待验证假设。' },
      { id: 'propose', title: '提出优化措施', description: guidance.measure, verification: `核对约束：${guidance.constraints}` },
      { id: 'simulate', title: '人工确认后仿真', description: '用户确认任务和具体改动后，才可在工程副本上执行受管 Icepak 模拟。', verification: '比较相同边界条件下的 Baseline 和候选结果；经验降温幅度不可作为验收结论。' },
    ],
    permissions: ['仅供需求分析与方案建议', '不得自动修改 AEDT 工程或启动昂贵求解', '客户系统建议项不得作为本机可执行改动'],
    successCriteria: ['诊断证据与措施对应', '约束和改动权限明确', '降温效果由真实求解结果验证'],
    failureStrategy: '证据不足时标记待验证；不根据经验估计宣称降温达标。',
    optimization: guidance,
  }
}

/** User-provided starting heuristics. Estimates are not guaranteed Icepak results. */
export const OPTIMIZATION_SKILL_SEEDS: readonly OptimizationSkillSeed[] = [
  {
    key: 'optimization-01-tim', name: '导热贴厚度与导热性能',
    description: '优先排查芯片到散热器底座的界面接触热阻。',
    guidance: {
      priority: 1, mechanism: '界面接触热阻（芯片壳温 → 散热器底座）',
      diagnosticBasis: '芯片壳温到鳍片根部温差较大，提示传导瓶颈；也可作为低结构改动的首选排查项。',
      measure: '在装配允许范围内减薄导热贴，或选用更高导热系数材料。',
      expectedTemperatureDrop: '3～10 ℃（经验估计，待模型验证）', applicability: 'LOCAL_ADJUSTABLE',
      constraints: '基本不改变其他结构；必须核对压缩后厚度下限、接触压力和装配公差。',
      keywords: ['导热贴', '导热垫', 'TIM', '界面热阻', '接触热阻', '壳温', '底座'],
    },
  },
  {
    key: 'optimization-02-fin-geometry', name: '片间距与片厚',
    description: '排查鳍片换热面积与风阻之间的平衡。',
    guidance: {
      priority: 2, mechanism: '鳍片到空气的对流换热面积与通道阻力',
      diagnosticBasis: '鳍片根部到环境空气温差较大，且面积或对流能力可能成为瓶颈。',
      measure: '在空间与风量约束下调整片间距、片厚和鳍片数量，比较净换热收益。',
      expectedTemperatureDrop: '1～3 ℃（经验估计，待模型验证）', applicability: 'LOCAL_ADJUSTABLE',
      constraints: '过密会增加风阻并可能降低实际风量；须联动检查风扇工作点与制造空间。',
      keywords: ['鳍片', '片间距', '片厚', 'fin', '散热面积', '风阻'],
    },
  },
  {
    key: 'optimization-03-heat-spreader', name: '热管与均温板（HP / VC）',
    description: '排查散热器内部扩散热阻和热点均温能力。',
    guidance: {
      priority: 3, mechanism: '散热器内部扩散热阻与均温性',
      diagnosticBasis: '散热器内部存在较大温差，例如超过 10 ℃；需由测点或仿真结果确认。',
      measure: '评估增加热管或均温板以降低热点并改善内部温度分布。',
      expectedTemperatureDrop: '约 5 ℃（经验估计，待模型验证）', applicability: 'LOCAL_ADJUSTABLE',
      constraints: '增加成本、重量或工艺复杂度；需检查安装方向、可用空间和热接触。',
      keywords: ['热管', '均温板', 'VC', 'HP', '均温', '内部温差', '热点'],
    },
  },
  {
    key: 'optimization-04-fan-selection', name: '风扇选型',
    description: '排查系统工作点、风量和静压对对流换热的限制。',
    guidance: {
      priority: 4, mechanism: '风量与静压决定的对流换热系数',
      diagnosticBasis: '有风量或静压不足的证据，且风扇曲线与系统阻力曲线表明工作点可改善。',
      measure: '比较更高静压或更高风量风扇的实际系统工作点与温度结果。',
      expectedTemperatureDrop: '5～20 ℃（经验估计，待模型验证）', applicability: 'LOCAL_ADJUSTABLE',
      constraints: '必须确认工作点未落入失速区；同时核对噪声、功耗、尺寸和啸叫风险。',
      keywords: ['风扇', '风量', '静压', '失速', '工作点', '风机曲线'],
    },
  },
  {
    key: 'optimization-05-system-vents', name: '系统进风口与出风口面积',
    description: '作为客户系统结构建议，排查进出风口造成的整体流阻。',
    guidance: {
      priority: 5, mechanism: '系统空气流动阻力',
      diagnosticBasis: '鳍片根部到环境空气温差较大，同时系统风量受进出风口限制。',
      measure: '建议客户增大进风口或出风口有效面积，并重新验证系统风量。',
      expectedTemperatureDrop: '约 5 ℃（经验估计，待模型验证）', applicability: 'CUSTOMER_RECOMMENDATION',
      constraints: '涉及客户系统结构更改；仅形成建议，不在当前散热器工程中自动执行。',
      keywords: ['进风口', '出风口', '开孔', '风口面积', '系统风阻', '风道'],
    },
  },
  {
    key: 'optimization-06-copper', name: '散热器材质：铝改铜',
    description: '前序低代价方案不足时，评估导热材质升级。',
    guidance: {
      priority: 6, mechanism: '底座到鳍片的纵向传导热阻',
      diagnosticBasis: '芯片壳温到鳍片根部温差仍大，且前序可行措施已评估或用尽。',
      measure: '比较铝材与铜材在同等边界条件下的温度、重量和成本。',
      expectedTemperatureDrop: '3～10 ℃（经验估计，待模型验证）', applicability: 'COST_WEIGHT_TRADEOFF',
      constraints: '成本与重量显著增加，优先级靠后；需要重新核算制造和装配影响。',
      keywords: ['铝', '铜', '材质', '材料', '底座导热', '纵向热阻'],
    },
  },
] as const
