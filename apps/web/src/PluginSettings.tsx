import { useEffect, useState } from 'react'
import { Button, Switch } from '@fluentui/react-components'

interface PluginStatus {
  repairCandidates?: { candidates: Array<{ id: string; pluginId: string; version: string; reason: string; createdAt: string;
    basePackageDigest: string; environmentDigest: string; changes: Array<{ path: string; sha256: string | null }> }>; errors: string[] }
  runtimeStorage?: { checkedAt?: string; removed: string[]; retained: Array<{ directory: string; reason: string }>; error?: string }
  runtimeRepairs?: Array<{ key: string; packageDigest: string; detectedAt: string; status: string; reason: string; error?: string }>
  automaticUpdates: boolean
  automaticRepair?: boolean
  executionEvidenceError?: string
  executionFailures?: Array<{ packageDigest: string; environmentDigest: string; method: string; code: string; detail: string; observedAt: string }>
  repairJobs?: { jobs: Array<{ id: string; state: string; startedAt: number; error?: string }>; error?: string }
  held: Record<string, string>
  active: Record<string, { current: string; previous?: string }>
  revisions: Array<{ digest: string; manifest: { id: string; version: string } }>
  validations: Array<{ packageDigest: string; environmentDigest: string; passed: boolean; validatedAt: string;
    checks: Array<{ name: string; passed: boolean; detail: string }> }>
  releases: { releases: Array<{ digest: string; publisherId: string; id: string }>; errors: string[] }
  updates: { phase: string; checkedAt: string | null; downloaded: number; cached: number; error?: string;
    assetDownloaded?: number; assetCached?: number; assetBytes?: number;
    sources: Array<{ id: string; downloaded: number; cached: number; errors: string[] }> }
  runtimes: Array<{ id: string; phase: string; busy: boolean; error?: string; inspectedAt: number | null;
    retry?: { consecutiveFailures: number; nextRetryAt: string; reason: string };
    dependencyMode?: 'isolated' | 'base'; pythonExecutable?: string;
    aedtInstallations?: Array<{ source: string; root: string; status: string; fileCount: number }>;
    aedtBindings?: { repairs: Array<{ variable: string; previous?: string; path: string }>; diagnostics: string[] };
    engineeringValidation?: { configured: boolean; diagnostic?: string; supportedCapabilities: string[] };
    environment?: { platform: string; architecture: string; versions: Record<string, string> };
    result?: { status: string; diagnostics: string[] } }>
}
const names: Record<string, string> = { 'icepak-pyaedt': 'Icepak 仿真插件', 'report-reportlab': 'PDF 报告插件' }
const phases: Record<string, string> = { pending: '等待环境检查', checking: '正在检查', unavailable: '暂不可用', ready: '运行时已就绪' }
const retentionReasons: Record<string, string> = {
  'active, rollback or held version': '当前版本或回退版本仍需使用',
  'saved workflow or readiness reference': '历史作业或就绪证据仍有引用',
  'live or unresolved Python process': '进程仍在运行或启动状态待核实',
  'seven-day retention period': '尚在七天保留期内',
  'legacy or untracked environment': '旧环境缺少完整进程跟踪记录',
  'unmanaged directory': '不属于可自动清理的目录',
  'not a managed directory': '目录类型不符合清理条件',
  'collection batch limit': '等待下一次空闲检查清理',
}

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
      <Switch label="故障后自动请求模型生成修复候选" checked={status?.automaticRepair ?? false} disabled={policyBusy || !status}
        onChange={(_, data) => void action('policy', { automaticRepair: data.checked })} />
      <Button disabled={busy} onClick={() => void action('reconcile')}>{busy ? '正在处理…' : '立即检查环境与插件'}</Button>
    </div>
    <p>模型修复需同时开启自动升级，会消耗已配置模型的额度。每个版本与环境组合自动投递一次，五分钟后发起取消；候选仍需隔离验证后才能启用。</p>
    {status?.executionEvidenceError && <p role="alert">业务故障记录失败，自动模型修复已暂停：{status.executionEvidenceError}</p>}
    {!!status?.executionFailures?.length && <details>
      <summary>业务兼容性故障（{status.executionFailures.length}）</summary>
      <p>以下为插件返回的错误线索，尚未确认根因；不代表工程验证失败，也不会自动重试原业务操作。历史环境的记录仅供诊断。</p>
      {status.executionFailures.map(item => <div key={`${item.packageDigest}:${item.environmentDigest}:${item.method}`}>
        <p>{item.method} · {item.code} · {new Date(item.observedAt).toLocaleString()}</p>
        <p>{item.detail}</p><p style={{ overflowWrap: 'anywhere' }}>插件摘要：{item.packageDigest}；环境摘要：{item.environmentDigest}</p>
      </div>)}
    </details>}
    {!!status?.repairJobs?.jobs.length && <details>
      <summary>自动修复任务（{status.repairJobs.jobs.length}）</summary>
      {status.repairJobs.jobs.map(job => <p key={job.id}>{new Date(job.startedAt).toLocaleString()} · {({ dispatching: '正在投递', running: '正在生成', stopping: '正在停止', 'candidate-ready': '已有候选，等待隔离验证', failed: '投递失败', 'timed-out': '已超时', cancelled: '已取消', interrupted: '重启后已终止' } as Record<string, string>)[job.state] ?? job.state}{job.error ? ` · ${job.error}` : ''}</p>)}
    </details>}
    {status?.repairJobs?.error && <p role="alert">自动修复任务：{status.repairJobs.error}</p>}
    {status?.updates && <div>
      <p>更新源：{({ idle: '尚未配置', checking: '正在检查', disabled: '自动获取已关闭', ready: '检查完成', error: '获取失败，保留本地可用版本', cancelled: '检查已停止' } as Record<string, string>)[status.updates.phase] ?? status.updates.phase}
        {status.updates.checkedAt ? ` · ${new Date(status.updates.checkedAt).toLocaleString()}` : ''}</p>
      {status.updates.error && <p role="alert">{status.updates.error}</p>}
      {!!(status.updates.assetDownloaded || status.updates.assetCached || status.updates.assetBytes) && <p>
        依赖资产：已下载 {status.updates.assetDownloaded ?? 0} 个 · 复用 {status.updates.assetCached ?? 0} 个 · 本轮传输 {((status.updates.assetBytes ?? 0) / 1024 / 1024).toFixed(1)} MiB
      </p>}
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
    {!!status?.repairCandidates?.candidates.length && <details>
      <summary>修复候选（{status.repairCandidates.candidates.length}）</summary>
      <p>以下候选仅已存档，尚未执行隔离验证，也未启用。当前插件继续按已有策略运行。</p>
      {status.repairCandidates.candidates.map(candidate => <details key={candidate.id}>
        <summary>{names[candidate.pluginId] ?? candidate.pluginId} v{candidate.version} · 等待隔离验证</summary>
        <div style={{ overflowWrap: 'anywhere' }}>
          <p>{candidate.reason}</p>
          <p>提交时间：{new Date(candidate.createdAt).toLocaleString()}<br />基础插件：{candidate.basePackageDigest}<br />证据环境：{candidate.environmentDigest}</p>
          <ul>{candidate.changes.map(change => <li key={change.path}>{change.sha256 ? '修改或新增' : '删除'}：{change.path}</li>)}</ul>
        </div>
      </details>)}
    </details>}
    {status?.repairCandidates?.errors.map((detail, index) => <p key={index} role="alert">修复候选读取失败：{detail}</p>)}
    {status?.runtimeStorage?.checkedAt && <details>
      <summary>依赖环境存储</summary>
      <p>最近检查：{new Date(status.runtimeStorage.checkedAt).toLocaleString()} · 已清理 {status.runtimeStorage.removed.length} 个 · 保留 {status.runtimeStorage.retained.length} 个</p>
      <p>自动更新开启时，空闲检查会清理超过七天且无作业引用、无进程占用的受管环境。当前版本与回退版本继续保留。</p>
      {status.runtimeStorage.error && <p role="alert">环境清理未完成：{status.runtimeStorage.error}</p>}
      <ul>{status.runtimeStorage.retained.map(item => <li key={item.directory} style={{ overflowWrap: 'anywhere' }}>
        {retentionReasons[item.reason] ?? item.reason} · {item.directory}
      </li>)}</ul>
    </details>}
    {!!status?.runtimeRepairs?.length && <details>
      <summary>依赖环境重建记录</summary>
      <p>重建完成后仍须通过插件验证；已开始的作业保留原运行环境。</p>
      {status.runtimeRepairs.map(repair => <div key={repair.key} style={{ overflowWrap: 'anywhere' }}>
        <p>{({ rebuilding: '正在重建', prepared: '环境已重新准备', failed: '重建未完成' } as Record<string, string>)[repair.status] ?? repair.status} · {new Date(repair.detectedAt).toLocaleString()}</p>
        <p>插件包：{repair.packageDigest}<br />原因：{repair.reason}</p>
        {repair.error && <p role="alert">{repair.error}</p>}
      </div>)}
    </details>}
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
        {!!runtime.aedtBindings?.repairs.length && <details>
          <summary>本机启动路径适配（{runtime.aedtBindings.repairs.length}）</summary>
          <p>已为插件进程补齐安装路径，未修改系统设置。启动及求解能力仍需验证。</p>
          {runtime.aedtBindings.repairs.map(item => <p key={item.variable} style={{ overflowWrap: 'anywhere' }}>{item.variable}：{item.previous ? `${item.previous} → ` : ''}{item.path}</p>)}
        </details>}
        {runtime.aedtBindings?.diagnostics.map(detail => <p key={detail} role="alert">安装路径适配：{detail}</p>)}
        {runtime.error && <p role="alert">{runtime.error}</p>}
        {runtime.retry && <p>本轮检查未完成，后续检查最早于 {new Date(runtime.retry.nextRetryAt).toLocaleString()} 重试（连续失败 {runtime.retry.consecutiveFailures} 次）。发现新版本或更新策略变化后会提前重新检查。</p>}
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
