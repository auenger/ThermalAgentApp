import { useEffect, useState } from 'react'
import { Button, Switch } from '@fluentui/react-components'

interface PluginStatus {
  automaticUpdates: boolean
  held: Record<string, string>
  active: Record<string, { current: string; previous?: string }>
  revisions: Array<{ digest: string; manifest: { id: string; version: string } }>
  releases: { releases: Array<{ digest: string; publisherId: string; id: string }>; errors: string[] }
  runtimes: Array<{ id: string; phase: string; busy: boolean; error?: string; inspectedAt: number | null;
    environment?: { platform: string; architecture: string; versions: Record<string, string> };
    result?: { status: string; diagnostics: string[] } }>
}
const names: Record<string, string> = { 'icepak-pyaedt': 'Icepak 仿真插件', 'report-reportlab': 'PDF 报告插件' }
const phases: Record<string, string> = { pending: '等待环境检查', checking: '正在检查', unavailable: '暂不可用', ready: '运行时已就绪' }

export function PluginSettings() {
  const [status, setStatus] = useState<PluginStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    let pending = false
    async function load() {
      if (pending) return
      pending = true
      try {
        const response = await fetch('/api/plugin-runtime')
        if (!response.ok) throw new Error('无法读取本机插件状态')
        const value = await response.json() as PluginStatus
        if (active) setStatus(value)
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : '读取失败') }
      finally { pending = false }
    }
    void load()
    const timer = setInterval(() => void load(), 3000)
    return () => { active = false; clearInterval(timer) }
  }, [])

  async function action(operation: string, value: object = {}) {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/plugin-runtime/${operation}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error?.message ?? '插件操作失败')
      setStatus(result)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '插件操作失败') }
    finally { setBusy(false) }
  }

  return <section className="task-detail-section" id="plugin-runtime-settings">
    <h2>插件与自适应升级</h2>
    <p>按本机环境检查已信任的插件版本，在任务空闲时切换。已开始的工程作业会继续使用原版本。</p>
    <div className="model-file-actions">
      <Switch label="自动检查与适配更新" checked={status?.automaticUpdates ?? false} disabled={busy || !status}
        onChange={(_, data) => void action('policy', { automaticUpdates: data.checked })} />
      <Button disabled={busy} onClick={() => void action('reconcile')}>{busy ? '正在处理…' : '立即检查环境与插件'}</Button>
    </div>
    <label>导入签名插件包 <input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      if (file.size > 48 * 1024 * 1024) { setError('插件包超过 48 MiB'); return }
      void file.text().then(text => action('install', JSON.parse(text))).catch(() => setError('无法读取插件包 JSON'))
    }} /></label>
    <p>导入后点击检查进行验证。发布者须由本机管理员预先配置；仿真插件候选还需工程兼容性验证。</p>
    {status?.releases.releases.map(release => <p key={release.digest}>受信发布者：{release.publisherId} · {release.id} · {status.active[release.id]?.current === release.digest ? '当前使用' : '已登记候选'}</p>)}
    {status?.releases.errors.map((detail, index) => <p key={index} role="alert">{detail}</p>)}
    {status?.runtimes.map(runtime => {
      const active = status.active[runtime.id]
      const revision = status.revisions.find(item => item.digest === active?.current)
      return <div key={runtime.id} className="task-detail-section">
        <h3>{names[runtime.id] ?? runtime.id} {revision ? `v${revision.manifest.version}` : ''}</h3>
        <p>{runtime.busy ? '正在执行，等待空闲后更新' : phases[runtime.phase] ?? runtime.phase}{status.held[runtime.id] ? ' · 已保持回退版本' : ''}</p>
        {runtime.environment && <p>{runtime.environment.platform} / {runtime.environment.architecture} · Python {runtime.environment.versions.python}
          {runtime.environment.versions.pyaedt && ` · PyAEDT ${runtime.environment.versions.pyaedt === 'missing' ? '未安装' : runtime.environment.versions.pyaedt}`}</p>}
        {runtime.inspectedAt && <p>最近检查：{new Date(runtime.inspectedAt).toLocaleString()}</p>}
        {runtime.error && <p role="alert">{runtime.error}</p>}
        {runtime.result?.diagnostics.map((detail, index) => <p key={index}>{detail}</p>)}
        <div className="model-file-actions">
          <Button disabled={busy || runtime.busy || !active?.previous} onClick={() => void action('rollback', { id: runtime.id })}>回退并保持上一版本</Button>
          {status.held[runtime.id] && <Button disabled={busy} onClick={() => void action('resume', { id: runtime.id })}>恢复版本自动选择</Button>}
        </div>
      </div>
    })}
    <p>环境与插件启动检查不代表工程通过或求解许可证可用。插件来源：App 内置插件及已配置发布者的签名包。</p>
    {error && <p role="alert">{error}</p>}
  </section>
}
