/// <reference lib="webworker" />
import runtimeUrl from 'occt-import-js/dist/occt-import-js.js?url'
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url'
import { DISPLAY_RUNTIME, MAX_STEP_BYTES, type DisplayMesh } from './types'

const worker = self as unknown as DedicatedWorkerGlobalScope & { occtimportjs(options: object): Promise<{ ReadStepFile(bytes: Uint8Array, options: object): any }> }
worker.onmessage = async event => {
  try {
    const { bytes, sourceSha256 } = event.data as { bytes: Uint8Array; sourceSha256: string }
    if (!globalThis.crypto?.subtle) throw new Error('3D 预览请使用本机 App 或 localhost；当前浏览器不支持几何身份核对')
    if (bytes.byteLength > MAX_STEP_BYTES) throw new Error('预览文件超过 32 MiB 上限')
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), b => b.toString(16).padStart(2, '0')).join('')
    if (sha !== sourceSha256) throw new Error('源 CAD 身份不一致')
    worker.importScripts(runtimeUrl)
    const occt = await worker.occtimportjs({ locateFile: () => wasmUrl })
    const result = occt.ReadStepFile(bytes, { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 })
    if (!result.success || !result.meshes?.length) throw new Error('STEP 无法生成显示网格')
    let triangles = 0
    const meshes: DisplayMesh[] = []
    for (const [index, mesh] of result.meshes.entries()) {
      const positions: number[] = mesh.attributes?.position?.array
      const indices: number[] = mesh.index?.array
      if (!Array.isArray(positions) || !positions.length || positions.length % 3 || !positions.every(Number.isFinite) ||
        !Array.isArray(indices) || !indices.length || indices.length % 3 || !indices.every(n => Number.isInteger(n) && n >= 0 && n < positions.length / 3)) throw new Error('显示网格数据无效')
      triangles += indices.length / 3
      if (triangles > 500_000 || meshes.length >= 2000) throw new Error('显示网格超过首版复杂度上限')
      const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
      for (let n = 0; n < positions.length; n++) { const axis = n % 3; bounds[axis] = Math.min(bounds[axis], positions[n]); bounds[axis + 3] = Math.max(bounds[axis + 3], positions[n]) }
      const content = new TextEncoder().encode(JSON.stringify({ positions, indices }))
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', content)), b => b.toString(16).padStart(2, '0')).join('')
      meshes.push({ id: `${index}:${digest}`, name: String(mesh.name || `部件 ${index + 1}`), positions, indices, bounds })
    }
    worker.postMessage({ scene: { sourceSha256, runtime: DISPLAY_RUNTIME, units: 'mm', meshes } })
  } catch (e) { worker.postMessage({ error: (e as Error).message }) }
}
