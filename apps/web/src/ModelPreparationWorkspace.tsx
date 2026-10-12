import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Badge, Button, Field, Input, Select, Spinner, Textarea } from '@fluentui/react-components'
import { createThermalModelSpec, validateThermalModelSpec } from '@thermal-agent/contracts'
import type { ModelPreparationContext, ModelValue, TaskRecord, ThermalModelSpec } from '@thermal-agent/contracts'

import type { DisplayObjectReference } from './cad-viewer/CadStepViewer'
const CadStepViewer = lazy(() => import('./cad-viewer/CadStepViewer').then(m => ({ default: m.CadStepViewer })))

async function api<T>(path: string, value?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(path, value === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error?.message ?? '建模操作失败')
  return body as T
}
const statusNames: Record<string, string> = { QUEUED: '排队中', RUNNING: '执行中', SUCCEEDED: '成功', FAILED: '失败', CANCELLED: '已取消', INTERRUPTED: '已中断', PREPARING: '生成中', PREPARED: '已生成 · 待验证', VALIDATING: '验证与网格检查中', VERIFIED: '模型准备已验证' }
const sourceNames: Record<string, string> = { USER_INPUT: '用户填写', TEMPLATE_DEFAULT: '模板默认值', CAD_METADATA: 'CAD 元数据', AGENT_PROPOSAL: 'Agent 建议' }

export function ModelPreparationWorkspace({ task, onChanged }: { task: TaskRecord; onChanged(): Promise<void> }) {
  const path = `/api/tasks/${task.id}`
  const localKey = `thermal-model-spec:${task.id}`
  const [context, setContext] = useState<ModelPreparationContext | null>(null)
  const [spec, setSpec] = useState<ThermalModelSpec | null>(null)
  const [version, setVersion] = useState('2024.2')
  const [healing, setHealing] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [filter, setFilter] = useState('')
  const [selection, setSelection] = useState<{ taskId: string; inspectionId: string; sourceSha256: string; catalogSha256: string; objectKey: string } | null>(null)
  const [displayReference, setDisplayReference] = useState<DisplayObjectReference | null>(null)
  const [draftVersion, setDraftVersion] = useState(0)
  const loaded = useRef(false)
  const localApp = ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)
  const editable = task.executionStatus === 'DRAFT' && localApp
  const running = context?.jobs.some(j => ['QUEUED', 'RUNNING'].includes(j.status)) ?? false
  const inspection = context?.inspections.find(i => i.id === spec?.inspectionId)
  const selectionCurrent = !!selection && selection.taskId === task.id && selection.inspectionId === inspection?.id &&
    selection.sourceSha256 === inspection.sourceSha256 && selection.catalogSha256 === inspection.catalogSha256 &&
    spec?.sourceSha256 === inspection.sourceSha256 && spec.catalogSha256 === inspection.catalogSha256
  useEffect(() => {
    if (selection && !selectionCurrent) {
      setSelection(null); setDisplayReference(null)
      setNotice('导入或目录身份已变化，请重新选择对象。')
    }
  }, [selection, selectionCurrent])
  const selectedGeometry = selectionCurrent ? inspection?.catalog?.objects.find(o => o.key === selection!.objectKey) : undefined
  const selectedConfiguration = selectedGeometry ? spec?.objects.find(o => o.objectKey === selectedGeometry.key) : undefined
  const issues = spec && inspection ? validateThermalModelSpec(spec, inspection) : []
  const refresh = async () => {
    const next = await api<ModelPreparationContext>(`${path}/model-preparations`)
    setContext(next)
    if (!loaded.current) {
      let local: { spec?: ThermalModelSpec; draftVersion?: number } | null = null
      try { local = JSON.parse(localStorage.getItem(localKey) ?? 'null') } catch { /* use persisted draft */ }
      const matching = local?.spec && next.inspections.some(i => i.id === local!.spec!.inspectionId && i.status === 'SUCCEEDED') && local.draftVersion === (next.draft?.version ?? 0)
      setSpec(matching ? local!.spec! : next.draft?.spec ?? null)
      setDraftVersion(next.draft?.version ?? 0)
      loaded.current = true
    }
  }
  useEffect(() => {
    let live = true
    let pending = false
    const poll = async () => {
      if (pending) return
      pending = true
      try { if (live) await refresh() } catch (e) { if (live) setError((e as Error).message) }
      finally { pending = false }
    }
    void poll()
    const timer = setInterval(() => void poll(), 2500)
    return () => { live = false; clearInterval(timer) }
  }, [task.id])
  useEffect(() => { if (spec) { try { localStorage.setItem(localKey, JSON.stringify({ spec, draftVersion })) } catch { /* server save remains available */ } } }, [spec, draftVersion, localKey])
  const edit = (patch: Partial<ThermalModelSpec>) => { setSpec(s => s ? { ...s, ...patch } : s); setNotice('') }
  async function act(label: string, action: () => Promise<void>) {
    setBusy(label); setError(''); setNotice('')
    try { await action(); await refresh(); await onChanged() }
    catch (e) { setError((e as Error).message) }
    finally { setBusy('') }
  }
  function selectObject(objectKey: string) {
    if (!inspection?.catalogSha256 || !inspection.catalog?.objects.some(o => o.key === objectKey)) return
    setDisplayReference(null)
    setSelection({ taskId: task.id, inspectionId: inspection.id, sourceSha256: inspection.sourceSha256, catalogSha256: inspection.catalogSha256, objectKey })
  }
  function exportSelection() {
    if (!selectedGeometry || !selectedConfiguration || !selectionCurrent) return
    const payload = { schemaVersion: 1, contextKind: 'CAD_OBJECT_DRAFT', ...selection,
      displaySelection: displayReference, units: inspection!.catalog!.units, geometry: selectedGeometry, configuration: selectedConfiguration,
      configurationState: 'EDITABLE_DRAFT', persistedDraftVersion: draftVersion,
      evidenceKind: inspection!.environment?.evidenceKind ?? 'ICEPAK_IMPORT',
      note: '选中对象与当前可编辑配置；不是求解证据或已批准修改。使用前须重新核对任务、导入和目录身份。' }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'cad-object-context.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function save() {
    const result = await api<{ draft: { version: number } }>(`${path}/model-spec`, { spec, expectedVersion: draftVersion }, 'PUT')
    setDraftVersion(result.draft.version)
    return result.draft.version
  }
  function numeric(key: 'ambientTemperatureC' | 'regionPaddingPercent' | 'regionMinPaddingMm' | 'meshLevel' | 'maxIterations' | 'flowConvergence' | 'energyConvergence', label: string, hint: string) {
    if (!spec) return null
    const field = spec[key]
    return <Field key={key} label={label} hint={`${hint} · ${sourceNames[field.source]}`}><Input type="number" value={String(field.value)} disabled={!editable} onChange={(_, data) => edit({ [key]: { value: Number(data.value), source: 'USER_INPUT', reference: 'App 表单', confirmed: false } })} /><label className="cad-confirm"><input type="checkbox" checked={field.confirmed} disabled={!editable} onChange={e => edit({ [key]: { ...field, confirmed: e.target.checked } })} />已核对此值</label></Field>
  }
  return <section className="task-detail-section cad-workspace" id="cad-workspace">
    <h2>CAD 转换与基础热模型</h2>
    <p>上传 CAD → 导入几何 → 配置材料与工况 → 生成工程 → 读回与网格验证 → Baseline</p>
    <p className="cad-muted">首版支持 STEP/STP、稳态自然对流。模板待 Windows 案例验收；全部步骤可通过表单完成。</p>
    {!localApp && <p className="cad-muted">当前为内网只读访问；导入、建模、恢复和取消操作请在任务所属的本机 App 执行。</p>}
    {(() => {
      const original = task.requirementSnapshot.sourceModel as { sha256?: string } | undefined
      const source = inspection?.sourceSha256 ?? original?.sha256 ?? (task.requirementSnapshot.modelKind === 'CAD' ? task.requirementSnapshot.modelSha256 : undefined)
      return typeof source === 'string' ? <Suspense fallback={<Spinner label="读取 3D 查看器" />}><CadStepViewer taskId={task.id} sourceSha256={source} inspection={inspection} selectedObjectKey={selectedGeometry?.key} onObjectSelect={(key, reference) => { selectObject(key); setDisplayReference(reference) }} onUnboundSelect={() => { setSelection(null); setDisplayReference(null) }} /></Suspense> : null
    })()}
    {context?.template && <ul className="cad-muted">{context.template.assumptions.map(a => <li key={a}>{a}</li>)}</ul>}
    {editable && <div className="cad-controls"><Field label="AEDT 版本"><Input value={version} onChange={(_, d) => setVersion(d.value)} /></Field><label><input type="checkbox" checked={healing} onChange={e => setHealing(e.target.checked)} />使用导入修复（记录选项，请核对薄层和间隙）</label><Button disabled={!!busy || running} onClick={() => void act('导入', async () => { await api(`${path}/cad-inspections`, { requestId: crypto.randomUUID(), version, healing }); setNotice('导入已提交，可离开页面。') })}>导入 CAD / 重新导入</Button></div>}
    {!context && <Spinner label="读取建模记录" />}
    {context?.recovery && <p role="alert" className="cad-error">{context.recovery.message}</p>}
    {context?.inspections.map(i => <details key={i.id} open={i.id === spec?.inspectionId || i.id === context.inspections.at(-1)?.id}><summary>CAD 导入 {i.id.slice(0, 8)} · {statusNames[i.status]} · {i.version}</summary>
      <p className="cad-muted">{i.environment?.evidenceKind === 'TEST_DOUBLE' ? '流程测试替身' : 'Icepak 导入记录'} · 源 SHA：{i.sourceSha256}</p>
      {i.catalog && <><p>单位：{i.catalog.units} · 总包围盒：{i.catalog.boundingBox.join(', ')} · 对象 {i.catalog.objects.length} 个</p>{i.catalog.diagnostics.map((d, n) => <p key={n}>{d.severity}：{d.message}</p>)}</>}
      {i.previewSha256 && <img className="cad-preview" src={`${path}/model-artifacts/${i.previewSha256}`} alt="导入 CAD 几何预览" />}
      {i.projectSha256 && <a href={`${path}/model-artifacts/${i.projectSha256}`} download>下载几何工程</a>}
      {editable && i.status === 'SUCCEEDED' && <Button disabled={!!busy || running} onClick={() => { setSpec(createThermalModelSpec(i)); setNotice('已载入此导入版本，请补齐材料、功率和环境。') }}>配置此导入版本</Button>}
    </details>)}
    {spec && inspection?.catalog && <div className="cad-spec"><h3>材料、热源与监测映射</h3><p className="cad-muted">草稿尚未作为求解输入。材料和功率须逐项确认；实体中心监测用于所选位置温度。</p>
      <aside className="cad-object-context" aria-label="选中对象上下文">
        <h4>对象选择（实验）</h4>
        <p className="cad-muted">从实体表中选择部件，核对配置并导出对象上下文。当前使用实体清单与静态预览。</p>
        {selectedGeometry && selectedConfiguration ? <>
          <p role="status">已选择：<strong>{selectedGeometry.name}</strong> · {selectedGeometry.type} · {selectedConfiguration.role}</p>
          <p>材料：{selectedConfiguration.material.value || '待填写'} · 功率：{selectedConfiguration.powerW.value} W · 中心监测：{selectedConfiguration.monitor ? '开启' : '关闭'}</p>
          <p className="cad-muted">导入版本：{inspection!.id} · 对象键：{selectedGeometry.key}</p>
          <div className="cad-controls"><Button onClick={() => { setFilter(''); requestAnimationFrame(() => document.getElementById('cad-selected-object')?.scrollIntoView({ block: 'center', behavior: 'smooth' })) }}>定位配置行</Button><Button onClick={exportSelection}>导出选中对象上下文</Button><Button onClick={() => { setSelection(null); setDisplayReference(null) }}>清除选择</Button></div>
        </> : <p role="status">{selection ? '选择已失效，请在当前导入版本重新选择。' : '尚未选择实体。'}</p>}
      </aside>
      <Input placeholder="搜索实体名称" aria-label="搜索实体名称" value={filter} onChange={(_, d) => setFilter(d.value)} />
      <div className="cad-table-scroll"><table className="cad-table"><thead><tr><th>实体 / 尺寸</th><th>角色</th><th>材料</th><th>功率 W</th><th>中心温度监测</th></tr></thead><tbody>{spec.objects.map((o, index) => {
        const c = inspection.catalog!.objects.find(c => c.key === o.objectKey)
        if (!c || !c.name.toLowerCase().includes(filter.toLowerCase())) return null
        const update = (patch: Partial<typeof o>) => edit({ objects: spec.objects.map((item, n) => n === index ? { ...item, ...patch } : item) })
        return <tr key={o.objectKey} id={selectedGeometry?.key === o.objectKey ? 'cad-selected-object' : undefined} className={selectedGeometry?.key === o.objectKey ? 'cad-object-selected' : undefined}><td><Button size="small" aria-label={`选择实体 ${c.name}`} aria-pressed={selectedGeometry?.key === o.objectKey} onClick={() => selectObject(o.objectKey)}>{c.name}</Button><small>{c.type} · {c.boundingBox.map(n => Number(n.toFixed(3))).join(', ')} {spec.units}</small></td>
          <td><Select aria-label={`${c.name} 角色`} value={o.role} disabled={!editable} onChange={(_, d) => update({ role: d.value as typeof o.role, included: d.value !== 'EXCLUDED', powerW: { ...o.powerW, value: 0, confirmed: false }, monitor: d.value !== 'EXCLUDED' && o.monitor })}><option value="SOLID">固体部件</option><option value="HEAT_SOURCE">发热器件</option><option value="HEATSINK">散热器</option><option value="EXCLUDED">排除</option></Select>{!o.included && <Input placeholder="排除原因" aria-label={`${c.name} 排除原因`} value={o.exclusionReason} onChange={(_, d) => update({ exclusionReason: d.value })} disabled={!editable} />}</td>
          <td><Select aria-label={`${c.name} 材料`} value={o.material.value} disabled={!editable || !o.included} onChange={(_, d) => update({ material: { value: d.value, source: 'USER_INPUT', reference: 'App 表单', confirmed: false } })}><option value="">请选择</option>{context!.materials.map(m => <option key={m} value={m}>{m}</option>)}</Select><small>{sourceNames[o.material.source]}{o.material.source === 'CAD_METADATA' ? `：${o.material.value}（需匹配）` : ''}</small><label><input type="checkbox" disabled={!editable || !o.included} checked={o.material.confirmed} onChange={e => update({ material: { ...o.material, confirmed: e.target.checked } })} />已核对材料</label></td>
          <td><Input type="number" aria-label={`${c.name} 功率 W`} value={String(o.powerW.value)} disabled={!editable || o.role !== 'HEAT_SOURCE'} onChange={(_, d) => update({ powerW: { value: Number(d.value), source: 'USER_INPUT', reference: 'App 表单', confirmed: false } })} /><label><input type="checkbox" disabled={!editable || o.role !== 'HEAT_SOURCE'} checked={o.powerW.confirmed} onChange={e => update({ powerW: { ...o.powerW, confirmed: e.target.checked } })} />已核对功率</label></td>
          <td><input aria-label={`${c.name} 中心监测`} type="checkbox" checked={o.monitor} disabled={!editable || !o.included} onChange={e => update({ monitor: e.target.checked })} /></td></tr>
      })}</tbody></table></div>
      <h3>环境与求解配置</h3><div className="cad-fields">
        {numeric('ambientTemperatureC', '环境温度 °C', '工况输入')}
        <Field label="重力方向" hint={sourceNames[spec.gravity.source]}><Select value={spec.gravity.value} disabled={!editable} onChange={(_, d) => edit({ gravity: { value: d.value as ThermalModelSpec['gravity']['value'], source: 'USER_INPUT', reference: 'App 表单', confirmed: false } })}>{['-X', '+X', '-Y', '+Y', '-Z', '+Z'].map(v => <option key={v}>{v}</option>)}</Select><label><input type="checkbox" checked={spec.gravity.confirmed} disabled={!editable} onChange={e => edit({ gravity: { ...spec.gravity, confirmed: e.target.checked } })} />已核对安装方向</label></Field>
        {numeric('regionPaddingPercent', '计算域各侧余量 %', '按模型尺寸计算')}{numeric('regionMinPaddingMm', '各侧最小余量 mm', '与比例余量取较大值')}
        {numeric('meshLevel', '网格等级 1–5', '初始网格，结果需检查敏感性')}{numeric('maxIterations', '最大迭代数', '模板参数')}{numeric('flowConvergence', '流动收敛阈值', '模板参数')}{numeric('energyConvergence', '能量收敛阈值', '模板参数')}
        <Field label="所选监测位置温度目标 °C"><Input type="number" value={String(spec.targetTmaxC)} disabled={!editable} onChange={(_, d) => edit({ targetTmaxC: Number(d.value) })} /></Field>
        <Field label="记录人"><Input value={spec.author} disabled={!editable} onChange={(_, d) => edit({ author: d.value })} /></Field>
      </div>
      <Field label="接触与间隙说明"><Textarea value={spec.contactNotes} disabled={!editable} onChange={(_, d) => edit({ contactNotes: d.value })} placeholder="哪些实体直接接触，是否有间隙或导热垫；确认模板适用" /></Field>
      <Field label="建模依据 / 说明"><Textarea value={spec.reason} disabled={!editable} onChange={(_, d) => edit({ reason: d.value })} /></Field>
      <label className="cad-confirm"><input type="checkbox" checked={spec.dimensionsConfirmed} disabled={!editable} onChange={e => edit({ dimensionsConfirmed: e.target.checked })} />已核对单位和实际尺寸</label>
      <label className="cad-confirm"><input type="checkbox" checked={spec.assumptionsConfirmed} disabled={!editable} onChange={e => edit({ assumptionsConfirmed: e.target.checked })} />已核对接触与间隙，接受当前稳态自然对流、理想接触、不启用辐射的假设</label>
      <p>参与计算 {spec.objects.filter(o => o.included).length} 个实体 · 热源合计 {spec.objects.reduce((sum, o) => sum + (o.included ? o.powerW.value : 0), 0)} W · 监测 {spec.objects.filter(o => o.monitor).length} 个位置</p>
      {issues.length > 0 && <details><summary>仍需完善 {issues.length} 项</summary><ul>{issues.map((issue, n) => <li key={n}>{issue}</li>)}</ul></details>}
      {editable && <div className="cad-controls"><Button disabled={!!busy} onClick={() => void act('保存', async () => { await save(); setNotice('配置草稿已保存到本机。') })}>保存配置草稿</Button><Button appearance="primary" disabled={!!busy || running || !!issues.length} onClick={() => void act('生成', async () => { const savedVersion = await save(); await api(`${path}/model-preparations`, { requestId: crypto.randomUUID(), draftVersion: savedVersion }); setNotice('已冻结配置并提交工程生成。') })}>生成基础热模型</Button></div>}
    </div>}
    <h3>工程版本与验证</h3>{context?.preparations.length === 0 && <p>尚未生成热模型。</p>}
    {context?.preparations.map(p => <details key={p.id} open><summary>模型 v{p.revision} · {statusNames[p.status]} · {p.spec.author}</summary><p>{p.spec.reason}</p><p className="cad-muted">源 CAD：{p.spec.sourceSha256} · 配置：{p.specSha256}</p>
      {p.projectSha256 && <a href={`${path}/model-artifacts/${p.projectSha256}`} download>下载生成工程</a>}{p.validationSha256 && <a href={`${path}/model-artifacts/${p.validationSha256}`} download>下载验证证据</a>}
      {editable && p.projectSha256 && !['PREPARING', 'VALIDATING'].includes(p.status) && <Button disabled={!!busy || running} onClick={() => void act('验证', async () => { await api(`${path}/model-preparations/${p.id}/validate`, { requestId: crypto.randomUUID() }); setNotice('已提交持久化读回与网格检查。') })}>验证工程 / 重试验证</Button>}
      {editable && p.status === 'VERIFIED' && <Button disabled={!!busy || running} appearance="primary" onClick={() => void act('激活', async () => { await api(`${path}/model-preparations/${p.id}/activate`, { expectedVersion: task.version }); setNotice('此版本已设为 Baseline 输入，可确认任务并求解。') })}>选为 Baseline 输入</Button>}
      {spec && editable && <Button disabled={!!busy || running} onClick={() => { setSpec(p.spec); setNotice('已载入历史配置草稿；修改后生成新版本。') }}>载入此版本配置</Button>}
    </details>)}
    <h3>作业记录</h3>{context?.jobs.slice().reverse().map(j => <details key={j.id} open={['FAILED', 'RUNNING', 'INTERRUPTED'].includes(j.status)}><summary><Badge>{statusNames[j.status]}</Badge> {j.kind} · {j.stage} · {new Date(j.createdAt).toLocaleString('zh-CN')}</summary>{j.error && <p role="alert">{j.error.code}：{j.error.message}</p>}{j.artifacts.map(a => <a key={a.role} href={`${path}/model-artifacts/${a.sha256}`} download>{a.role} / {a.originalName}</a>)}{localApp && ['QUEUED', 'RUNNING'].includes(j.status) && <Button disabled={!!busy || j.stage === 'cancelling'} onClick={() => void act('取消', async () => { await api(`${path}/model-preparation-jobs/${j.id}/cancel`, {}) })}>取消作业</Button>}</details>)}
    {busy && <Spinner label={busy} />}{notice && <p role="status">{notice}</p>}{error && <p role="alert" className="cad-error">{error}</p>}
  </section>
}
