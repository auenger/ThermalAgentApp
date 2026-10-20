import { useEffect, useState } from 'react'
import { Button, Field, Input, Select } from '@fluentui/react-components'

type Parameter = { type: 'number' | 'integer' | 'string' | 'boolean'; description: string; required?: boolean; unit?: string; default?: string | number | boolean; minimum?: number; maximum?: number; enum?: Array<string | number | boolean> }
type Script = { id: string; name: string; version: string; description: string; source: string; disabled: boolean; parameters: Record<string, Parameter>; applicability: { aedtVersions: string[]; requiredObjects: string[] } }
type Run = { id: string; scriptId: string; status: string; parameters: Record<string, unknown>; error?: string; startedAt: string; evidence?: { kind: string; projectSha256: string; artifactSha256: string } }
type Context = { source: { sha256: string; originalName: string } | null; planConfirmed: boolean; aedtVersion?: string; runs: Run[]; busy: boolean; pendingEngineeringCleanup: boolean }
async function api<T>(path: string, value?: unknown): Promise<T> {
  const response = await fetch(path, value === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error?.message ?? '脚本操作失败')
  return body
}
const statusName: Record<string, string> = { RUNNING: '执行中', SUCCEEDED: '持久工程读回通过', FAILED: '失败', CANCELLED: '已取消', INTERRUPTED: '执行中断' }
export function DynamicScriptWorkspace({ taskId }: { taskId: string }) {
  const [context, setContext] = useState<Context | null>(null)
  const [scripts, setScripts] = useState<Script[]>([])
  const [selected, setSelected] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [source, setSource] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const script = scripts.find(item => item.id === selected)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const [next, library] = await Promise.all([api<Context>(`/api/tasks/${taskId}/script-context`), api<{ scripts: Script[] }>('/api/dynamic-scripts')])
        if (active) { setContext(next); setScripts(library.scripts) }
      } catch (err) { if (active) setError(String(err)) }
      finally { if (active) timer = setTimeout(refresh, 3000) }
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [taskId])
  async function run() {
    if (!script) return
    setPending(true); setError('')
    try {
      const parameters: Record<string, unknown> = {}
      for (const [name, spec] of Object.entries(script.parameters)) {
        const value = values[name] ?? (spec.default === undefined ? '' : String(spec.default))
        if (value === '' && !spec.required) continue
        if (value === '' && spec.type !== 'string') throw new Error(`请填写 ${name}`)
        parameters[name] = spec.type === 'boolean' ? value === 'true' : spec.type === 'string' ? value : Number(value)
        if (typeof parameters[name] === 'number' && !Number.isFinite(parameters[name])) throw new Error(`${name} 必须为有限数字`)
      }
      const response = await api<{ run: Run }>(`/api/tasks/${taskId}/script-runs`, { scriptId: script.id, parameters, ...(source ? { projectSha256: source } : {}) })
      setContext(current => current ? { ...current, busy: true, runs: [...current.runs, response.run] } : current)
    } catch (err) { setError(String(err)) } finally { setPending(false) }
  }
  async function cancel(runId: string) {
    setPending(true); setError('')
    try { await api(`/api/tasks/${taskId}/script-runs/${runId}/cancel`, {}); setError('已请求取消，正在等待执行退出。') }
    catch (err) { setError(String(err)) } finally { setPending(false) }
  }
  const compatible = script && context?.aedtVersion && script.applicability.aedtVersions.includes(context.aedtVersion)
  return <section className="dynamic-script-workspace">
    <h2>可复用 Python 操作</h2>
    <p>通过 AI 对话生成工程操作，验证后复用脚本调整参数。每次操作使用工程副本；读回通过后仍需按仿真流程求解。</p>
    {!context && <p>正在读取脚本与任务信息…</p>}
    {context && !context.source && <p>请先为任务绑定 AEDT 工程。</p>}
    {context && !context.planConfirmed && <p>执行前请先在任务中确认仿真计划。</p>}
    {context?.pendingEngineeringCleanup && <p>前次工程进程尚未完成清理，暂时不能开始新操作。</p>}
    <Field label="选择已保存脚本"><Select value={selected} onChange={(_, data) => { setSelected(data.value); setValues({}) }}>
      <option value="">选择脚本</option>{scripts.filter(item => !item.disabled).map(item => <option key={item.id} value={item.id}>{item.name} · {item.version} · {item.id.slice(0, 8)}</option>)}
    </Select></Field>
    {!scripts.length && <p>还没有保存的脚本。可在 AI 对话中说明需要调整的对象和参数。</p>}
    {script && <>
      <p>{script.description} · 适用 AEDT：{script.applicability.aedtVersions.join('、')}</p>
      {script.applicability.requiredObjects.length > 0 && <p>执行前检查对象：{script.applicability.requiredObjects.join('、')}</p>}
      <details><summary>查看 Python 源码</summary><pre>{script.source}</pre></details>
      <div className="dynamic-script-fields">{Object.entries(script.parameters).map(([name, spec]) => <Field key={name} label={`${name}${spec.unit ? ` (${spec.unit})` : ''} · ${spec.description}`} required={spec.required}>
        {spec.type === 'boolean' || spec.enum ? <Select value={values[name] ?? (spec.default === undefined ? '' : String(spec.default))} onChange={(_, data) => setValues(v => ({ ...v, [name]: data.value }))}>
          <option value="">请选择</option>{(spec.enum ?? [true, false]).map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}
        </Select> : <Input type={spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text'} value={values[name] ?? (spec.default === undefined ? '' : String(spec.default))} onChange={(_, data) => setValues(v => ({ ...v, [name]: data.value }))} min={spec.minimum} max={spec.maximum} step={spec.type === 'integer' ? 1 : 'any'} />}
      </Field>)}</div>
      <Field label="输入工程"><Select value={source} onChange={(_, data) => setSource(data.value)}><option value="">任务原始工程</option>{context?.runs.filter(run => run.status === 'SUCCEEDED' && run.evidence).map(run => <option key={run.id} value={run.evidence!.projectSha256}>脚本产物 · {new Date(run.startedAt).toLocaleString()}</option>)}</Select></Field>
      <Button appearance="primary" disabled={pending || context?.busy || !context?.planConfirmed || !context.source || context.pendingEngineeringCleanup || !compatible} onClick={() => void run()}>在工程副本上执行</Button>
      {context?.aedtVersion && !compatible && <p>当前任务 AEDT 版本与该脚本声明不匹配。</p>}
    </>}
    {error && <p role="alert">{error}</p>}
    <h3>执行记录</h3>
    {!context?.runs.length && <p>尚无动态脚本执行记录。</p>}
    {context?.runs.slice().reverse().map(run => <article className="dynamic-script-run" key={run.id}>
      <strong>{scripts.find(item => item.id === run.scriptId)?.name ?? run.scriptId.slice(0, 12)} · {statusName[run.status] ?? run.status}</strong>
      <span>{new Date(run.startedAt).toLocaleString()}</span>
      <pre>{JSON.stringify(run.parameters, null, 2)}</pre>
      {run.evidence?.kind === 'test-double' && <p>测试替身记录，不代表真实 Icepak 验证。</p>}
      {run.error && <p role="alert">{run.error}</p>}
      {run.evidence && <details><summary>查看产物标识</summary><p>工程：<code>{run.evidence.projectSha256}</code></p><p>回执：<code>{run.evidence.artifactSha256}</code></p></details>}
      {run.status === 'RUNNING' && <Button disabled={pending} onClick={() => void cancel(run.id)}>取消执行</Button>}
    </article>)}
  </section>
}
