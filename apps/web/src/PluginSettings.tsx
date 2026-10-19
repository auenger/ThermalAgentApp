import { useEffect, useState } from 'react'
import { Button, Switch } from '@fluentui/react-components'

interface PluginStatus {
  automaticUpdates: boolean
  held: Record<string, string>
  active: Record<string, { current: string; previous?: string }>
  revisions: Array<{ digest: string; manifest: { id: string; version: string } }>
  validations: Array<{ packageDigest: string; environmentDigest: string; passed: boolean; validatedAt: string;
    checks: Array<{ name: string; passed: boolean; detail: string }> }>
  releases: { releases: Array<{ digest: string; publisherId: string; id: string }>; errors: string[] }
  updates: { phase: string; checkedAt: string | null; downloaded: number; cached: number; error?: string;
    sources: Array<{ id: string; downloaded: number; cached: number; errors: string[] }> }
  runtimes: Array<{ id: string; phase: string; busy: boolean; error?: string; inspectedAt: number | null;
    dependencyMode?: 'isolated' | 'base'; pythonExecutable?: string;
    aedtInstallations?: Array<{ source: string; root: string; status: string; fileCount: number }>;
    engineeringValidation?: { configured: boolean; diagnostic?: string; supportedCapabilities: string[] };
    environment?: { platform: string; architecture: string; versions: Record<string, string> };
    result?: { status: string; diagnostics: string[] } }>
}
const names: Record<string, string> = { 'icepak-pyaedt': 'Icepak 仿真插件', 'report-reportlab': 'PDF 报告插件' }
const phases: Record<string, string> = { pending: '等待环境检查', checking: '正在检查', unavailable: '暂不可用', ready: '运行时已就绪' }

export function PluginSettings() {
  const [status, setStatus] = useState<PluginStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [policyBusy, setPolicyBusy] = useState(false)
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
    const setPending = operation === 'policy' ? setPolicyBusy : setBusy
    setPending(true); setError('')
    try {
      const response = await fetch(`/api/plugin-runtime/${operation}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error?.message ?? '插件操作失败')
      setStatus(result)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '插件操作失败') }
    finally { setPending(false) }
  }

  return <section className="task-detail-section" id="plugin-runtime-settings">
    <h2>插件与自适应升级</h2>
    <p>按本机环境检查已信任的插件版本，在任务空闲时切换。已开始的工程作业会继续使用原版本。</p>
    <div className="model-file-actions">
      <Switch label="自动获取并选择兼容版本" checked={status?.automaticUpdates ?? false} disabled={policyBusy || !status}
        onChange={(_, data) => void action('policy', { automaticUpdates: data.checked })} />
      <Button disabled={busy} onClick={() => void action('reconcile')}>{busy ? '正在处理…' : '立即检查环境与插件'}</Button>
    </div>
    {status?.updates && <div>
      <p>更新源：{({ idle: '尚未配置', checking: '正在检查', disabled: '自动获取已关闭', ready: '检查完成', error: '获取失败，保留本地可用版本', cancelled: '检查已停止' } as Record<string, string>)[status.updates.phase] ?? status.updates.phase}
        {status.updates.checkedAt ? ` · ${new Date(status.updates.checkedAt).toLocaleString()}` : ''}</p>
      {status.updates.error && <p role="alert">{status.updates.error}</p>}
      {status.updates.sources.map(source => <div key={source.id}><p>{source.id} · 新包 {source.downloaded} · 本地已有 {source.cached}</p>
        {source.errors.map((detail, index) => <p key={index} role="alert">{detail}</p>)}</div>)}
    </div>}
    <label>导入签名插件包 <input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      if (file.size > 48 * 1024 * 1024) { setError('插件包超过 48 MiB'); return }
      void file.text().then(text => action('install', JSON.parse(text))).catch(() => setError('无法读取插件包 JSON'))
    }} /></label>
    <p>发布者须由本机管理员预先配置。导入后检查可触发已授权的工程样例求解验证；通过对应验证后才会启用候选。</p>
    {status?.releases.releases.map(release => <p key={release.digest}>受信发布者：{release.publisherId} · {release.id} · {status.active[release.id]?.current === release.digest ? '当前使用' : '已登记候选'}</p>)}
    {status?.releases.errors.map((detail, index) => <p key={index} role="alert">{detail}</p>)}
    {status?.runtimes.map(runtime => {
      const active = status.active[runtime.id]
      const revision = status.revisions.find(item => item.digest === active?.current)
      const digests = new Set(status.revisions.filter(item => item.manifest.id === runtime.id).map(item => item.digest))
      const validations = (status.validations ?? []).filter(item => digests.has(item.packageDigest))
        .sort((a, b) => b.validatedAt.localeCompare(a.validatedAt)).slice(0, 10)
      return <div key={runtime.id} className="task-detail-section">
        <h3>{names[runtime.id] ?? runtime.id} {revision ? `v${revision.manifest.version}` : ''}</h3>
        <p>{runtime.busy ? '正在执行，等待空闲后更新' : phases[runtime.phase] ?? runtime.phase}{status.held[runtime.id] ? ' · 已保持回退版本' : ''}</p>
        {runtime.environment && <p>{runtime.environment.platform} / {runtime.environment.architecture} · Python {runtime.environment.versions.python}
          {runtime.environment.versions.pyaedt && ` · PyAEDT ${runtime.environment.versions.pyaedt === 'missing' ? '未安装' : runtime.environment.versions.pyaedt}`}</p>}
        {runtime.inspectedAt && <p>最近检查：{new Date(runtime.inspectedAt).toLocaleString()}</p>}
        {runtime.dependencyMode && <p>依赖环境：{runtime.dependencyMode === 'isolated' ? '此插件版本独立安装' : 'App 基础运行时'}</p>}
        {runtime.aedtInstallations?.map(item => <p key={item.source} style={{ overflowWrap: 'anywhere' }}>
          AEDT：{item.root} · {item.status === 'present' ? `已采集 ${item.fileCount} 个原生运行文件` : '未找到主程序'}
        </p>)}
        {runtime.error && <p role="alert">{runtime.error}</p>}
        {runtime.engineeringValidation && <p>{runtime.engineeringValidation.configured
          ? '工程升级验证已配置：检查参数发现、保存后读回及样例求解；不覆盖 CAD 导入和风扇变更。'
          : '工程升级验证未配置或不可用：新的仿真候选暂不自动启用。'}</p>}
        {runtime.engineeringValidation?.diagnostic && <p role="alert">{runtime.engineeringValidation.diagnostic}</p>}
        {runtime.result?.diagnostics.map((detail, index) => <p key={index}>{detail}</p>)}
        {validations.length > 0 && <details>
          <summary>最近验证记录（{validations.length}）</summary>
          <p>记录仅适用于当时的插件与环境；历史通过不表示当前仍可用，也不代表任务工程通过。</p>
          {validations.map(validation => {
            const version = status.revisions.find(item => item.digest === validation.packageDigest)?.manifest.version
            return <details key={`${validation.packageDigest}:${validation.environmentDigest}`}>
              <summary>v{version} · {validation.passed ? '验证通过' : '验证失败'} · {new Date(validation.validatedAt).toLocaleString()}</summary>
              <div style={{ overflowWrap: 'anywhere' }}>
                <p>插件摘要：{validation.packageDigest}<br />环境摘要：{validation.environmentDigest}</p>
                <ul>{validation.checks.map((check, index) => <li key={index}>{check.passed ? '通过' : '失败'} · {check.name}：{check.detail}</li>)}</ul>
              </div>
            </details>
          })}
        </details>}
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
