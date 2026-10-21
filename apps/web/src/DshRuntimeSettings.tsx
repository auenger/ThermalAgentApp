import { useEffect, useState } from 'react'
import { Button, Input } from '@fluentui/react-components'
interface RuntimeStatus { active: string; previous?: string; pending?: { release: string } | { rollback: true }; busy: boolean; error?: string }
export function DshRuntimeSettings() {
  const [status, setStatus] = useState<RuntimeStatus>()
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function request(action = '') {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/agent/runtime${action}`, action ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
      } : undefined)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error?.message ?? '运行时操作失败')
      setStatus(data.runtime)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  useEffect(() => { void request() }, [])
  return <section style={{ marginTop: 20 }} aria-label="DSH 引擎更新">
    <h3>DSH 引擎更新</h3>
    <p>导入可信来源提供的完整运行时目录，下次完全退出并启动 App 时切换。更新失败会恢复原引擎及原 Profile。</p>
    <p>当前来源：{status?.active === 'bundled' ? 'App 内置' : status?.active?.slice(0, 12) ?? '读取中'}
      {status?.pending && ' · 已准备，下次启动应用'}{status?.busy && ' · 正在校验'}</p>
    <Input aria-label="DSH 运行时包目录" value={path} onChange={(_, data) => setPath(data.value)} placeholder="运行时目录（包含 runtime.json）" style={{ width: '100%' }} />
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
      <Button disabled={busy || !path.trim()} onClick={() => void request('/stage')}>校验并准备更新</Button>
      <Button disabled={busy || !status?.previous} onClick={() => void request('/rollback')}>下次启动恢复上一版</Button>
      <Button disabled={busy} onClick={() => void request()}>刷新</Button>
    </div>
    <p>回退会使用上一版的数据快照；新版产生的对话仍保留在磁盘。此操作不替换桌面安装程序。</p>
    {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
  </section>
}
