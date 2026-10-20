import { useEffect, useState } from 'react'
import { Button, Checkbox, Field, Input } from '@fluentui/react-components'
import { scriptParameterValues, type Script } from './DynamicScriptWorkspace'
type Bound = { enabled: boolean; minimum: string; maximum: string; step: string; minimumStep: string }
type Plan = { parameters: Record<string, unknown>; adjustable: Array<{ name: string; minimum: number; maximum: number; step: number; minimumStep: number }>; targetTmaxC: number; maxRounds: number; maxDurationMs: number; setup: string }
type Job = { id: string; status: string; stopReason?: string; bestRound?: number; error?: string; plan: Plan; rounds: Array<{ number: number; status: string; parameters: Record<string, unknown>; tmaxC?: number; error?: string; executionKind?: string }> }
type Context = { taskVersion: number; planConfirmed: boolean; busy: boolean; iterations: Job[] }
const reasons: Record<string, string> = { TARGET_REACHED: '达到设定目标', ROUND_LIMIT: '达到轮数上限', TIME_LIMIT: '达到耗时上限', SEARCH_EXHAUSTED: '当前搜索步长内无新方案', EXECUTION_FAILED: '执行或证据检查失败', CANCELLED: '已取消', INTERRUPTED: '运行中断' }
async function api<T>(path: string, value?: unknown): Promise<T> {
  const response = await fetch(path, value === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error?.message ?? '迭代操作失败')
  return body
}
export function ScriptIterationPanel({ taskId, script, values }: { taskId: string; script?: Script; values: Record<string, string> }) {
  const [bounds, setBounds] = useState<Record<string, Bound>>({})
  const [target, setTarget] = useState('')
  const [rounds, setRounds] = useState('6')
  const [minutes, setMinutes] = useState('60')
  const [setup, setSetup] = useState('')
  const [context, setContext] = useState<Context | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  useEffect(() => { setBounds({}) }, [script?.id])
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try { const next = await api<Context>(`/api/tasks/${taskId}/script-context`); if (active) setContext(next) }
      catch (err) { if (active) setError(String(err)) }
      finally { if (active) timer = setTimeout(refresh, 2500) }
    }
    void refresh(); return () => { active = false; clearTimeout(timer) }
  }, [taskId])
  const boundFor = (name: string): Bound => bounds[name] ?? { enabled: false, minimum: String(script?.parameters[name].minimum ?? ''), maximum: String(script?.parameters[name].maximum ?? ''), step: '', minimumStep: '' }
  const change = (name: string, value: Partial<Bound>) => setBounds(current => ({ ...current, [name]: { ...boundFor(name), ...value } }))
  async function action(work: () => Promise<unknown>) {
    setPending(true); setError('')
    try { await work(); setContext(await api<Context>(`/api/tasks/${taskId}/script-context`)) }
    catch (err) { setError(String(err)) } finally { setPending(false) }
  }
  function draft() {
    return action(async () => {
      if (!script) throw new Error('请先选择脚本')
      if (!target.trim() || !setup.trim() || !rounds.trim() || !minutes.trim()) throw new Error('请填写目标、setup 和预算')
      const adjustable = Object.keys(script.parameters).filter(name => boundFor(name).enabled).map(name => {
        const b = boundFor(name)
        if ([b.minimum, b.maximum, b.step, b.minimumStep].some(value => !value.trim())) throw new Error(`请填写 ${name} 的范围和步长`)
        return { name, minimum: Number(b.minimum), maximum: Number(b.maximum), step: Number(b.step), minimumStep: Number(b.minimumStep) }
      })
      await api(`/api/tasks/${taskId}/script-iterations`, { scriptId: script.id, parameters: scriptParameterValues(script, values), adjustable,
        targetTmaxC: Number(target), setup, maxRounds: Number(rounds), maxDurationMs: Number(minutes) * 60_000 })
    })
  }
  return <div className="script-iteration-panel"><h3>自动仿真迭代</h3><p>使用上方脚本和初始参数。每轮从任务原始工程副本开始，以已收敛的最高温度选择下一组参数。</p>
    {script && <details><summary>设置参数范围与运行预算</summary>
      {Object.entries(script.parameters).filter(([, spec]) => ['number', 'integer'].includes(spec.type) && !spec.enum).map(([name]) => <div key={name}>
        <Checkbox label={`自动调整 ${name}`} checked={boundFor(name).enabled} onChange={(_, data) => change(name, { enabled: !!data.checked })} />
        {boundFor(name).enabled && <div className="dynamic-script-fields">{(['minimum', 'maximum', 'step', 'minimumStep'] as const).map((key, index) => <Field key={key} label={`${name} ${['下限', '上限', '初始步长', '最小步长'][index]}`}><Input type="number" value={boundFor(name)[key]} onChange={(_, data) => change(name, { [key]: data.value })} /></Field>)}</div>}
      </div>)}
      <div className="dynamic-script-fields"><Field label="目标最高温度 (°C)"><Input type="number" value={target} onChange={(_, d) => setTarget(d.value)} /></Field><Field label="求解 setup"><Input value={setup} onChange={(_, d) => setSetup(d.value)} /></Field><Field label="最多轮数"><Input type="number" min={1} max={64} value={rounds} onChange={(_, d) => setRounds(d.value)} /></Field><Field label="总耗时上限 (分钟)"><Input type="number" min={1} max={1440} value={minutes} onChange={(_, d) => setMinutes(d.value)} /></Field></div>
      <Button disabled={pending} onClick={() => void draft()}>保存迭代计划</Button>
    </details>}
    {error && <p role="alert">{error}</p>}
    {!context?.iterations.length && <p>尚无迭代计划。也可以让 AI 根据工程生成计划，在此检查后启动。</p>}
    {context?.iterations.slice().reverse().map(job => <article className="dynamic-script-run" key={job.id}>
      <strong>{job.status === 'DRAFT' ? '待确认计划' : job.status === 'RUNNING' ? '自动迭代进行中' : reasons[job.stopReason ?? ''] ?? '已停止'}</strong>
      <p>目标 ≤ {job.plan.targetTmaxC} °C · 最多 {job.plan.maxRounds} 轮 · {job.plan.maxDurationMs / 60_000} 分钟 · {job.plan.setup}</p>
      <p>允许调整：{job.plan.adjustable.map(b => `${b.name} [${b.minimum}, ${b.maximum}]，步长 ${b.step} → ${b.minimumStep}`).join('；')}</p>
      <details><summary>查看初始参数</summary><pre>{JSON.stringify(job.plan.parameters, null, 2)}</pre></details>
      {job.status === 'DRAFT' && <Button disabled={pending || context.busy || !context.planConfirmed} onClick={() => void action(() => api(`/api/tasks/${taskId}/script-iterations/${job.id}/start`, { expectedTaskVersion: context.taskVersion }))}>确认范围与预算并启动求解</Button>}
      {job.status === 'RUNNING' && <Button disabled={pending} onClick={() => void action(() => api(`/api/tasks/${taskId}/script-iterations/${job.id}/cancel`, {}))}>停止自动迭代</Button>}
      {job.error && <p role="alert">{job.error}</p>}
      {job.bestRound && <p>当前最佳：第 {job.bestRound} 轮 · {job.rounds[job.bestRound - 1]?.tmaxC} °C</p>}
      {job.rounds.some(round => round.executionKind === 'test-double') && <p>包含测试替身结果，不代表真实 Icepak 收敛。</p>}
      {job.rounds.map(round => <details key={round.number}><summary>第 {round.number} 轮 · {({ APPLYING: '调整参数', SOLVING: '求解中', SUCCEEDED: '已收敛', FAILED: '失败', CANCELLED: '已取消' } as Record<string, string>)[round.status]}{round.tmaxC === undefined ? '' : ` · ${round.tmaxC} °C`}</summary><pre>{JSON.stringify(round.parameters, null, 2)}</pre>{round.error && <p>{round.error}</p>}</details>)}
    </article>)}
  </div>
}
