import { useEffect, useRef, useState } from 'react'
import { Button, Select, Spinner } from '@fluentui/react-components'
import type { CadInspection } from '@thermal-agent/contracts'
import { CadViewport } from './CadViewport'
import { DISPLAY_RUNTIME, MAX_STEP_BYTES, type DisplayBinding, type DisplayScene } from './types'

export interface DisplayObjectReference { sourceSha256: string; inspectionId: string; catalogSha256: string; meshId: string; runtime: string; confirmation: 'USER_CONFIRMED' }

export function CadStepViewer({ taskId, sourceSha256, inspection, selectedObjectKey, onObjectSelect, onUnboundSelect }: {
  taskId: string; sourceSha256: string; inspection?: CadInspection; selectedObjectKey?: string
  onObjectSelect(key: string, reference: DisplayObjectReference): void; onUnboundSelect(): void
}) {
  const [open, setOpen] = useState(false)
  const [scene, setScene] = useState<DisplayScene | null>(null)
  const [error, setError] = useState('')
  const [selectedMesh, setSelectedMesh] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [candidate, setCandidate] = useState('')
  const [bindings, setBindings] = useState<DisplayBinding[]>([])
  const scope = `${taskId}:${sourceSha256}:${inspection?.id ?? ''}:${inspection?.catalogSha256 ?? ''}:${DISPLAY_RUNTIME}`
  const [bindingScope, setBindingScope] = useState(scope)
  const currentScene = scene?.sourceSha256 === sourceSha256 ? scene : null
  const currentBindings = bindingScope === scope ? bindings : []
  const callbacks = useRef({ onObjectSelect, onUnboundSelect }); callbacks.current = { onObjectSelect, onUnboundSelect }
  const mesh = currentScene?.meshes.find(m => m.id === selectedMesh)
  const selectedBinding = currentBindings.find(b => b.meshId === selectedMesh)
  const activeMesh = selectedObjectKey ? currentBindings.find(b => b.objectKey === selectedObjectKey)?.meshId ?? selectedMesh : selectedMesh
  const object = inspection?.catalog?.objects.find(o => o.key === candidate)
  // Bounds are a rejection check, never proof that two parts have the same identity.
  const compatible = !!mesh && !!object && inspection?.sourceSha256 === sourceSha256 && inspection?.catalog?.units === 'mm' && object.type === 'Solid' &&
    object.boundingBox.length === 6 && object.boundingBox.every((v, n) => Number.isFinite(v) && Math.abs(v - mesh.bounds[n]) <= 0.05)
  useEffect(() => {
    setSelectedMesh(null); setCandidate(''); setHidden(new Set()); setBindings([]); setBindingScope(scope)
  }, [scope])
  useEffect(() => {
    if (selectedObjectKey) setSelectedMesh(currentBindings.find(b => b.objectKey === selectedObjectKey)?.meshId ?? null)
  }, [selectedObjectKey, scope, bindings])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const worker = new Worker(new URL('./step.worker.ts', import.meta.url))
    let live = true
    setScene(null); setError(''); setSelectedMesh(null); setHidden(new Set())
    const timer = setTimeout(() => { if (live) { setError('3D 预览处理超时，请关闭后重试或使用原建模流程。'); worker.terminate(); controller.abort() } }, 60_000)
    worker.onmessage = event => {
      if (!live) return
      clearTimeout(timer)
      if (event.data.error) setError(event.data.error)
      else setScene(event.data.scene)
      worker.terminate()
    }
    worker.onerror = () => { if (live) { clearTimeout(timer); setError('几何运行时加载失败，请检查 App 资源或使用实体表。'); worker.terminate(); controller.abort() } }
    void (async () => {
      try {
        const response = await fetch(`/api/tasks/${taskId}/cad-source/${sourceSha256}`, { signal: controller.signal })
        if (!response.ok) { const body = await response.json(); throw new Error(body.error?.message ?? '无法读取源 STEP') }
        if (Number(response.headers.get('Content-Length')) > MAX_STEP_BYTES) throw new Error('预览文件超过 32 MiB 上限')
        const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let length = 0
        for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > MAX_STEP_BYTES) { await reader.cancel(); throw new Error('预览文件超过 32 MiB 上限') } chunks.push(value) }
        if (!live) return
        const bytes = new Uint8Array(length); let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        worker.postMessage({ bytes, sourceSha256 }, [bytes.buffer])
      } catch (e) { if (live && !controller.signal.aborted) { clearTimeout(timer); worker.terminate(); setError((e as Error).message) } }
    })()
    return () => { live = false; clearTimeout(timer); controller.abort(); worker.terminate() }
  }, [open, taskId, sourceSha256])
  function choose(id: string) {
    setSelectedMesh(id); setCandidate('')
    const binding = currentBindings.find(b => b.meshId === id)
    if (binding && inspection?.catalogSha256) callbacks.current.onObjectSelect(binding.objectKey, {
      sourceSha256, inspectionId: inspection.id, catalogSha256: inspection.catalogSha256, meshId: id, runtime: DISPLAY_RUNTIME, confirmation: 'USER_CONFIRMED',
    })
    else callbacks.current.onUnboundSelect()
  }
  function confirmBinding() {
    if (!compatible || !currentScene || !inspection?.catalogSha256 || !mesh || !object) return
    const next = [...currentBindings.filter(b => b.meshId !== mesh.id && b.objectKey !== object.key), { meshId: mesh.id, objectKey: object.key, confirmation: 'USER_CONFIRMED' as const }]
    setBindings(next); setBindingScope(scope)
    callbacks.current.onObjectSelect(object.key, { sourceSha256, inspectionId: inspection.id, catalogSha256: inspection.catalogSha256, meshId: mesh.id, runtime: DISPLAY_RUNTIME, confirmation: 'USER_CONFIRMED' })
  }
  function exportBindings() {
    if (!currentScene) return
    const record = { schemaVersion: 1, contextKind: 'DISPLAY_BINDINGS', taskId, sourceSha256, inspectionId: inspection?.id ?? null,
      catalogSha256: inspection?.catalogSha256 ?? null, runtime: DISPLAY_RUNTIME, units: 'mm', bindings: currentBindings,
      meshCatalog: currentScene.meshes.map(({ id, name, bounds }) => ({ id, name, bounds })),
      evidenceKind: inspection?.environment?.evidenceKind ?? 'GEOMETRY_PREVIEW_ONLY', note: '显示映射由用户确认，不证明真实 Icepak 导入或求解正确。' }
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'cad-display-bindings.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section className="cad-step-viewer" aria-label="STEP 三维预览">
    <Button onClick={() => setOpen(v => !v)}>{open ? '关闭 3D 预览' : '打开 3D 预览（实验）'}</Button>
    {open && <>
      <p className="cad-muted">旋转：拖动 · 缩放：滚轮 · 选择：点击部件。显示网格使用 mm；确认单位和实体对应关系后才能联动配置。</p>
      {error ? <p role="alert">{error}</p> : !currentScene ? <Spinner label="读取 STEP 并生成显示网格" /> : <>
        <CadViewport scene={currentScene} selectedId={activeMesh} hidden={hidden} onSelect={choose} />
        <div className="cad-mesh-list" aria-label="显示部件清单">{currentScene.meshes.map(m => <Button key={m.id} size="small" aria-pressed={selectedMesh === m.id} onClick={() => choose(m.id)}>显示部件 {m.name}</Button>)}</div>
        <p role="status">显示网格：{currentScene.meshes.length} 个部件 · {currentScene.meshes.reduce((s, m) => s + m.indices.length / 3, 0)} 个三角形</p>
        <p className="cad-muted">可见部件：{currentScene.meshes.length - hidden.size}</p>
        {mesh && <div className="cad-object-context">
          <h4>显示选择：{mesh.name}</h4><p className="cad-muted">包围盒：{mesh.bounds.map(v => v.toFixed(3)).join(', ')} mm</p>
          <p>{selectedBinding ? `对应实体：${inspection?.catalog?.objects.find(o => o.key === selectedBinding.objectKey)?.name}（用户确认）` : '尚未对应 Icepak 实体，不会修改热模型配置。'}</p>
          {inspection?.catalog && <><Select aria-label="显示部件对应实体" value={candidate} onChange={(_, d) => setCandidate(d.value)}><option value="">选择要核对的实体</option>{inspection.catalog.objects.map(o => <option key={o.key} value={o.key}>{o.name}</option>)}</Select>
            {candidate && !compatible && <p role="alert">尺寸、单位或实体类型不一致，无法确认对应关系。</p>}
            <p className="cad-muted">请核对实体形状、位置和原工程；尺寸一致只是一项检查。</p><Button disabled={!compatible} onClick={confirmBinding}>确认显示部件对应关系</Button></>}
          <div className="cad-controls"><Button onClick={() => setHidden(new Set([...(hidden.has(mesh.id) ? [...hidden].filter(id => id !== mesh.id) : [...hidden, mesh.id])]))}>{hidden.has(mesh.id) ? '显示选中部件' : '隐藏选中部件'}</Button><Button onClick={() => setHidden(new Set(currentScene.meshes.filter(m => m.id !== mesh.id).map(m => m.id)))}>隔离选中部件</Button></div>
        </div>}
        <div className="cad-controls"><Button onClick={() => setHidden(new Set())}>显示全部部件</Button><Button onClick={exportBindings}>导出显示映射</Button></div>
      </>}
      <p className="cad-muted">预览不会修复或改写 STEP，也不会启动 Icepak。显示对应关系仅保留在当前页面，可导出记录；重新打开页面或切换导入版本后需重新确认。</p>
    </>}
  </section>
}
