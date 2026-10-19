import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Field, Input, Select, Spinner, Textarea } from '@fluentui/react-components'
import { Add20Regular, ArrowDownload20Regular, ArrowClockwise20Regular, Delete20Regular, Play20Regular, Save20Regular } from '@fluentui/react-icons'
import { resolveParameterChanges, parameterValueSchema } from '@thermal-agent/contracts'
import type { IcepakEditableParameter, ParameterPlan, ParameterPlanRequest, TaskRecord } from '@thermal-agent/contracts'

type DraftRow = { parameterId: string; value: string; role: 'design' | 'operating-condition' | '' }
type Draft = { author: string; reason: string; rows: DraftRow[]; sourceAttemptId: string }
type ExecutionSummary = { status: string; tmaxC: number | null; converged: boolean | null; deltaC: number | null; error: string | null }
type Context = { sourceAttemptId: string; sourceSha256: string; design: string; setup: string; aedtVersion: string;
  baselineTmaxC: number | null; parameters: IcepakEditableParameter[]; canOptimize: boolean; plans: ParameterPlan[];
  executions?: Record<string, ExecutionSummary> }
const adapterNames: Record<string, string> = { variable: '模型变量', material: '对象材料', 'boundary-power': '热源功率', fan: '风扇转速比' }
const adapterName = (p: IcepakEditableParameter) => p.adapterLabel ?? adapterNames[p.adapter] ?? p.adapter
const statusNames = { CHECKING: '验证中', VERIFIED: '已验证 · 待执行', FAILED: '失败', STARTING: '启动中', EXECUTED: '已提交求解' }
const emptyDraft: Draft = { author: '', reason: '', rows: [], sourceAttemptId: '' }
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function api<T>(url: string, value?: unknown): Promise<T> {
  const response = await fetch(url, value === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error?.message ?? '操作失败，请重试')
  return body as T
}

export function ParameterWorkspace({ task, onChanged, onOpenTask }: { task: TaskRecord; onChanged(): Promise<void>; onOpenTask(id: string): void }) {
  const draftKey = `thermal-parameter-draft:${task.id}`
  const [draft, setDraft] = useState<Draft>(() => {
    try { const saved = JSON.parse(localStorage.getItem(draftKey) ?? 'null'); return saved && Array.isArray(saved.rows) ? saved : emptyDraft } catch { return emptyDraft }
  })
  const [draftPersisted, setDraftPersisted] = useState(false)
  const [context, setContext] = useState<Context | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [contextError, setContextError] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [expanded, setExpanded] = useState('')
  const [compare, setCompare] = useState('')
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const editorRef = useRef<HTMLDivElement>(null)
  const available = context?.parameters ?? []
  useEffect(() => { try { localStorage.setItem(draftKey, JSON.stringify(draft)); setDraftPersisted(true) } catch { setDraftPersisted(false) } }, [draftKey, draft])
  useEffect(() => {
    let active = true
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const value = await api<Context>(`/api/tasks/${task.id}/parameters`)
        if (active) { setContext(value); setContextError('') }
      } catch (reason) { if (active) setContextError(reason instanceof Error ? reason.message : '参数读取失败') }
      finally { pending = false; if (active) setLoading(false) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 4000)
    return () => { active = false; clearInterval(timer) }
  }, [task.id, task.version])

  function edit(patch: Partial<Draft>) { setDraft(current => ({ ...current, ...patch })); setError(''); setNotice('') }
  function rowError(row: DraftRow) {
    if (!row.role) return '请确认此变量控制结构设计还是工况'
    try { resolveParameterChanges(available, { author: 'preview', reason: 'preview', sourceAttemptId: '', changes: [row as ParameterPlanRequest['changes'][number]] }); return '' }
    catch (reason) { return reason instanceof Error ? reason.message : '参数无效' }
  }
  const dirty = draft.rows.length > 0
  const stale = !!context && dirty && !!draft.sourceAttemptId && draft.sourceAttemptId !== context.sourceAttemptId
  const checking = context?.plans.some(plan => plan.status === 'CHECKING' || plan.status === 'STARTING')
  const hasCondition = draft.rows.some(row => row.role === 'operating-condition')
  const filtered = available.filter(p => !draft.rows.some(row => row.parameterId === p.id) &&
    `${p.label} ${adapterName(p)}`.toLowerCase().includes(query.toLowerCase()))

  function add() {
    const p = available.find(p => p.id === selected)
    if (!p || draft.rows.some(row => row.parameterId === p.id)) return
    edit({ rows: [...draft.rows, { parameterId: p.id, value: parameterValueSchema(p).defaultValue ?? p.currentValue,
      role: p.role === 'unclassified' ? '' : p.role }], sourceAttemptId: context!.sourceAttemptId })
    setSelected('')
  }
  async function refreshCatalog() {
    setBusy('refresh'); setError('')
    try {
      setContext(await api<Context>(`/api/tasks/${task.id}/parameters/refresh`, {}))
      setNotice('已从基准工程副本重新读取参数，历史版本保留。')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '重新读取失败') }
    finally { setBusy('') }
  }
  async function save() {
    setTouched(Object.fromEntries(draft.rows.map(row => [row.parameterId, true])))
    if (!context || stale || !dirty || draft.rows.some(row => rowError(row))) return
    setBusy('save'); setError('')
    try {
      const { plan } = await api<{ plan: ParameterPlan }>(`/api/tasks/${task.id}/parameter-plans`, {
        sourceAttemptId: context.sourceAttemptId, author: draft.author, reason: draft.reason, changes: draft.rows,
      })
      setContext(current => current ? { ...current, plans: [plan, ...current.plans] } : current)
      setExpanded(plan.id)
      setDraft({ ...emptyDraft, author: draft.author })
      setNotice(`已保存 v${plan.revision}。验证进度见版本记录，可离开页面后继续查看。`)
      await onChanged()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败') }
    finally { setBusy('') }
  }
  async function execute(plan: ParameterPlan) {
    setBusy(plan.id); setError('')
    try {
      const { plan: updated } = await api<{ plan: ParameterPlan }>(`/api/tasks/${task.id}/parameter-plans/${plan.id}/execute`, { expectedVersion: task.version })
      setContext(current => current ? { ...current, plans: current.plans.map(p => p.id === plan.id ? updated : p) } : current)
      setNotice(updated.purpose === 'design' ? `v${plan.revision} 已开始候选求解。` : `已创建关联工况任务，原 Baseline 保留。`)
      await onChanged()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '启动失败') }
    finally { setBusy('') }
  }
  function copy(plan: ParameterPlan) {
    if (dirty) { setError('当前有未提交修改，请先保存或清空编辑，再复制历史版本。'); return }
    setDraft({ author: plan.author, reason: plan.reason, sourceAttemptId: context!.sourceAttemptId,
      rows: plan.changes.map(change => ({ parameterId: change.parameter.id, value: change.value, role: change.role })) })
    setTouched({}); setNotice(`已复制 v${plan.revision}，编辑后将保存为新版本。`)
    editorRef.current?.focus()
  }
  const left = context?.plans.find(p => p.id === expanded)
  const right = context?.plans.find(p => p.id === compare)
  return <section className="task-detail-section parameter-workspace" id="parameter-workspace" aria-label="参数修改与追溯">
    <div className="parameter-heading"><div><h2>参数修改与追溯</h2><p>以 Baseline 为起点，每次提交保留独立版本、修改原因和验证证据。</p></div><Badge appearance="outline">{context?.plans.length ?? 0} 个版本</Badge></div>
    {typeof task.requirementSnapshot.parentTaskId === 'string' && <p>此任务为独立工况基准。<Button appearance="transparent" onClick={() => onOpenTask(String(task.requirementSnapshot.parentTaskId))}>查看来源任务与修改记录</Button></p>}
    {loading && <Spinner size="small" label="正在读取基准参数" />}
    {contextError && <p className="parameter-message" role="status">{contextError}</p>}
    {context && <>
      <div className="parameter-baseline"><strong>基准 {context.sourceAttemptId.slice(0, 8)}</strong><span>{context.design} / {context.setup}</span><span>最高温度 {context.baselineTmaxC ?? '—'} °C</span><details><summary>工程标识</summary><code>{context.sourceSha256}</code><p>AEDT {context.aedtVersion}</p></details></div>
      {typeof task.requirementSnapshot.adjustmentBounds === 'string' && task.requirementSnapshot.adjustmentBounds.trim() && <p className="parameter-message"><strong>本任务调整约束：</strong>{task.requirementSnapshot.adjustmentBounds}</p>}
      <div ref={editorRef} tabIndex={-1} className="parameter-editor">
        <div className="parameter-heading"><h3>编辑修改方案</h3><Button appearance="subtle" disabled={!!busy || !!checking || task.executionStatus === 'RUNNING'} onClick={() => void refreshCatalog()}>{busy === 'refresh' ? '正在打开工程读取参数…' : '重新读取参数'}</Button>{dirty && <Badge appearance="outline">{draftPersisted ? '未提交 · 本机暂存' : '未提交 · 暂存不可用'}</Badge>}</div>
        {!available.length ? <p className="parameter-message">此基准尚无可编辑参数。旧版本工程结果需重新读取参数；变量需已被模型引用且为数值，材料需已加载到工程。</p> : <>
          <div className="parameter-picker"><Field label="搜索参数"><Input value={query} placeholder="对象名、变量名或类型" onChange={(_, d) => { setQuery(d.value); setSelected('') }} /></Field>
            <Field label="选择参数"><Select value={selected} onChange={(_, d) => setSelected(d.value)}><option value="">{filtered.length ? `可添加 ${filtered.length} 项` : '没有匹配的参数'}</option>{filtered.map(p => <option key={p.id} value={p.id}>{p.label} · {adapterName(p)}</option>)}</Select></Field>
            <Button icon={<Add20Regular />} disabled={!selected || stale} onClick={add}>添加</Button></div>
          {dirty ? <div className="parameter-edit-rows">{draft.rows.map((row, index) => {
            const p = available.find(p => p.id === row.parameterId)
            const schema = p ? parameterValueSchema(p) : undefined
            const validation = rowError(row)
            const update = (patch: Partial<DraftRow>) => edit({ rows: draft.rows.map((r, i) => i === index ? { ...r, ...patch } : r) })
            return <div className="parameter-edit-row" key={row.parameterId}>
              <div className="parameter-row-name"><strong>{p?.label ?? row.parameterId}</strong><span>{p ? adapterName(p) : '参数已不可用'}</span><small>原值：{p?.currentValue ?? '未知'}</small></div>
              <Field label="目标值" validationState={touched[row.parameterId] && validation ? 'error' : 'none'} validationMessage={touched[row.parameterId] ? validation : undefined}
                hint={schema?.hint ?? (p?.unit ? `保留单位 ${p.unit}，例如 ${p.currentValue}` : undefined)}>
                {schema?.type === 'enum' ? <Select value={row.value} onChange={(_, d) => { update({ value: d.value }); setTouched(t => ({ ...t, [row.parameterId]: true })) }}>{schema.values!.map(value => <option key={value}>{value}</option>)}</Select>
                  : <Input aria-label={`${p?.label ?? row.parameterId} 目标值`} value={row.value} onChange={(_, d) => update({ value: d.value })} onBlur={() => setTouched(t => ({ ...t, [row.parameterId]: true }))} />}</Field>
              <Field label="参数用途">{p?.role === 'unclassified' ? <Select aria-label={`${p.label} 参数用途`} value={row.role} onChange={(_, d) => update({ role: d.value as DraftRow['role'] })}><option value="">请确认模型含义</option><option value="design">结构设计</option><option value="operating-condition">工况条件</option></Select> : <span className="parameter-role">{row.role === 'operating-condition' ? '工况条件' : '结构设计'}</span>}</Field>
              <Button appearance="subtle" icon={<Delete20Regular />} aria-label={`移除 ${p?.label ?? row.parameterId}`} onClick={() => edit({ rows: draft.rows.filter((_, i) => i !== index) })} />
            </div>
          })}</div> : <p className="parameter-empty">选择要调整的参数。添加后可逐项比较原值与目标值。</p>}
          {dirty && <><div className="parameter-purpose">{hasCondition ? '包含工况变更：执行时创建关联的新工况任务，单独计算 Baseline。' : '结构设计修改：执行时基于当前 Baseline 生成候选方案并比较温度。'}<p>变量用途请按它在模型中的实际作用选择。厚度、间距属于结构；功耗、环境和入口条件属于工况。</p></div>
            <div className="parameter-reason"><Field label="记录人" required><Input value={draft.author} maxLength={100} onChange={(_, d) => edit({ author: d.value })} /></Field><Field label="修改原因" required hint="记录诊断依据、预期作用和适用约束，便于后续复核。"><Textarea value={draft.reason} maxLength={2000} onChange={(_, d) => edit({ reason: d.value })} /></Field></div>
            {stale && <p role="alert" className="parameter-error">基准已变化，请清空编辑并基于新清单重新选择参数。</p>}
            <div className="parameter-actions"><Button appearance="primary" icon={<Save20Regular />} disabled={!!busy || !!checking || stale || !draft.author.trim() || !draft.reason.trim()} onClick={() => void save()}>{busy === 'save' ? '正在保存' : '保存新版本并验证'}</Button><Button disabled={!!busy} onClick={() => { edit({ rows: [], reason: '', sourceAttemptId: '' }); setTouched({}) }}>清空编辑</Button><span>验证不会启动求解</span></div>
          </>}
        </>}
      </div>
      <div className="parameter-history"><div className="parameter-heading"><h3>修改版本与执行结果</h3><Button appearance="subtle" icon={<ArrowDownload20Regular />} disabled={!context.plans.length} onClick={() => download({ taskId: task.id, ...context }, `parameter-history-${task.id.slice(0, 8)}.json`)}>导出追溯记录</Button></div>
        {!context.plans.length && <p className="parameter-empty">尚未提交修改。保存后，这里会保留每版方案和验证结果。</p>}
        {context.plans.map(plan => {
          const summary = context.executions?.[plan.id]
          return <article className="parameter-version" key={plan.id}>
            <button className="parameter-version-toggle" aria-expanded={expanded === plan.id} onClick={() => { setExpanded(expanded === plan.id ? '' : plan.id); setCompare('') }}><strong>v{plan.revision} · {plan.changes.length} 项修改</strong><span>{plan.purpose === 'design' ? '结构候选' : '新工况'}</span><Badge appearance="outline" color={plan.status === 'VERIFIED' ? 'success' : plan.status === 'FAILED' ? 'danger' : 'informative'}>{statusNames[plan.status]}</Badge><span>{expanded === plan.id ? '收起' : '查看详情'}</span></button>
            <p className="parameter-version-meta">{plan.author}（记录人填写） · {new Date(plan.createdAt).toLocaleString('zh-CN')}</p><p>{plan.reason}</p>
            {plan.status === 'CHECKING' && <Spinner size="tiny" label="正在写入、保存并重新打开工程验证" />}
            {summary && <p className="parameter-outcome">求解：{summary.status} · 最高温度 {summary.tmaxC ?? '—'} °C · {summary.converged == null ? '收敛待验证' : summary.converged ? '已收敛' : '未收敛'}{plan.purpose === 'design' && summary.deltaC != null ? ` · 相对 Baseline ${summary.deltaC > 0 ? '+' : ''}${summary.deltaC.toFixed(2)} °C` : ''}{summary.error ? ` · ${summary.error}` : ''}</p>}
            {plan.error && <p className="parameter-error" role="alert">{plan.error}</p>}
            {expanded === plan.id && <>
              <div className="parameter-diff" role="table" aria-label={`版本 ${plan.revision} 参数变更`}><div role="row" className="parameter-diff-head"><span role="columnheader">参数 / 对象</span><span role="columnheader">原值 → 目标值</span><span role="columnheader">保存后验证</span></div>
                {plan.changes.map(change => { const action = plan.actionResults.find(a => a.parameterId === change.parameter.id); return <div role="row" key={change.parameter.id}><span role="cell"><strong>{change.parameter.label}</strong><small>{adapterName(change.parameter)} · {change.role === 'design' ? '结构' : '工况'}</small></span><span role="cell">{change.parameter.currentValue} → <strong>{change.value}</strong></span><span role="cell">{action?.verified ? `已确认 ${action.verifiedAfter}` : plan.status === 'FAILED' ? '未验证通过' : '待验证'}</span></div> })}
              </div>
              <details className="parameter-identities"><summary>基准、工程与证据标识</summary><dl><dt>基准记录</dt><dd>{plan.sourceAttemptId}</dd><dt>输入工程 SHA256</dt><dd>{plan.sourceSha256}</dd><dt>验证工程 SHA256</dt><dd>{plan.verifiedProjectSha256 ?? '待生成'}</dd><dt>验证证据 SHA256</dt><dd>{plan.evidenceSha256 ?? '待生成'}</dd><dt>运行 ID</dt><dd>{plan.runId ?? '尚未执行'}</dd><dt>设计 / Setup / AEDT</dt><dd>{plan.design} / {plan.setup} / {plan.aedtVersion}</dd></dl></details>
              {context.plans.length > 1 && <Field label="与其他版本比较"><Select value={compare} onChange={(_, d) => setCompare(d.value)}><option value="">选择对比版本</option>{context.plans.filter(p => p.id !== plan.id).map(p => <option key={p.id} value={p.id}>v{p.revision} · {p.reason.slice(0, 35)}</option>)}</Select></Field>}
              {right && left?.id === plan.id && <div className="parameter-diff" role="table" aria-label="版本比较"><div role="row" className="parameter-diff-head"><span role="columnheader">参数</span><span role="columnheader">v{right.revision}</span><span role="columnheader">v{left.revision}</span></div>{[...new Set([...right.changes, ...left.changes].map(c => c.parameter.id))].map(id => {
                const a = right.changes.find(c => c.parameter.id === id), b = left.changes.find(c => c.parameter.id === id)
                return <div role="row" key={id}><span role="cell">{(a ?? b)!.parameter.label}</span><span role="cell">{a?.value ?? (left.sourceSha256 === right.sourceSha256 ? b!.parameter.currentValue : '未修改 / 基准不同')}</span><span role="cell">{b?.value ?? (left.sourceSha256 === right.sourceSha256 ? a!.parameter.currentValue : '未修改 / 基准不同')}</span></div>
              })}</div>}
              <div className="parameter-actions">
                {plan.status === 'VERIFIED' && <Button appearance="primary" icon={<Play20Regular />} disabled={!!busy || !!checking || task.executionStatus === 'RUNNING' || (plan.purpose === 'design' && !context.canOptimize)} onClick={() => void execute(plan)}>{busy === plan.id ? '启动中' : plan.purpose === 'design' ? `执行 v${plan.revision} 候选求解` : `创建并求解 v${plan.revision} 新工况`}</Button>}
                <Button icon={<ArrowClockwise20Regular />} disabled={!!busy || plan.status === 'CHECKING'} onClick={() => copy(plan)}>复制为新版本</Button>
                {plan.verifiedProjectSha256 && <Button as="a" href={`/api/tasks/${task.id}/parameter-plans/${plan.id}/project`} download>下载验证工程</Button>}
                {plan.evidenceSha256 && <Button as="a" href={`/api/tasks/${task.id}/parameter-plans/${plan.id}/evidence`} download>下载验证证据</Button>}
                <Button icon={<ArrowDownload20Regular />} onClick={() => download({ plan, execution: summary }, `parameter-plan-v${plan.revision}.json`)}>导出此版本</Button>
                {plan.executionTaskId && plan.executionTaskId !== task.id && <Button onClick={() => onOpenTask(plan.executionTaskId!)}>打开工况任务</Button>}
              </div>
              {plan.status === 'VERIFIED' && plan.purpose === 'design' && !context.canOptimize && <p className="parameter-message">结构候选需 Baseline 判定 FAIL 且本任务尚未执行过候选。验证记录仍会保留。</p>}
            </>}
          </article>
        })}
      </div>
    </>}
    {notice && <p className="parameter-message" role="status">{notice}</p>}
    {error && <p className="parameter-error" role="alert">{error}</p>}
  </section>
}
