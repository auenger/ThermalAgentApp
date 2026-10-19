import { useEffect, useState } from 'react'
import { Button } from '@fluentui/react-components'

interface ModelFile { sha256: string; name: string; sizeBytes: number; labels: string[]; downloadUrl: string; path?: string }
interface ModelFiles { workspacePath?: string; files: ModelFile[] }

export function TaskModelFiles({ taskId }: { taskId: string }) {
  const [listing, setListing] = useState<ModelFiles | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    let pending = false
    setListing(null); setError(''); setNotice('')
    async function load() {
      if (pending) return
      pending = true
      try {
        const response = await fetch(`/api/tasks/${taskId}/model-files`)
        const body = await response.json()
        if (!response.ok) throw new Error(body.error?.message ?? '模型文件读取失败')
        if (active) setListing(body)
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : '模型文件读取失败') }
      finally { pending = false }
    }
    void load()
    const timer = setInterval(() => void load(), 4000)
    return () => { active = false; clearInterval(timer) }
  }, [taskId])
  async function locate(sha256?: string, copy = false) {
    setBusy(true); setError(''); setNotice('')
    try {
      if (copy) {
        const response = await fetch(`/api/tasks/${taskId}/model-files${sha256 ? `/${sha256}` : ''}/location`, { method: 'POST' })
        const body = await response.json()
        if (!response.ok || !body.path) throw new Error(body.error?.message ?? '文件路径读取失败')
        await navigator.clipboard.writeText(body.path)
        setNotice(sha256 ? '文件路径已复制' : '任务目录已复制')
      } else {
        await window.thermalDesktop!.locateTaskModel(taskId, sha256)
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '文件定位失败') }
    finally { setBusy(false) }
  }
  return <section className="task-detail-section" id="task-model-files">
    <h2>模型文件</h2>
    {listing?.workspacePath && <><p className="model-file-path">任务目录：{listing.workspacePath}</p><div className="model-file-actions">
      {window.thermalDesktop?.locateTaskModel && <Button disabled={busy} onClick={() => void locate()}>打开任务目录</Button>}
      <Button disabled={busy} onClick={() => void locate(undefined, true)}>复制目录路径</Button>
    </div></>}
    <div className="task-detail-list">{listing?.files.map(file => <div key={file.sha256}>
      <strong>{file.name}</strong><span>{file.labels.join(' · ')} · {(file.sizeBytes / 1024 / 1024).toFixed(2)} MB</span>
      <div className="model-file-actions"><Button as="a" href={file.downloadUrl} download>下载文件</Button>
        {window.thermalDesktop?.locateTaskModel && <Button disabled={busy} onClick={() => void locate(file.sha256)}>在文件夹中显示</Button>}
        {file.path && <Button disabled={busy} onClick={() => void locate(file.sha256, true)}>复制文件路径</Button>}
      </div>
    </div>)}</div>
    {!listing && !error && <p>正在读取模型文件…</p>}
    {listing?.files.length === 0 && <p>尚未上传模型文件</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
