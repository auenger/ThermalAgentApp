export const DISPLAY_RUNTIME = 'occt-import-js/0.0.23'
export const MAX_STEP_BYTES = 32 * 1024 * 1024
export interface DisplayMesh {
  id: string
  name: string
  positions: number[]
  normals?: number[]
  indices: number[]
  bounds: number[]
}
export interface DisplayScene { sourceSha256: string; runtime: string; units: 'mm'; meshes: DisplayMesh[] }
export interface DisplayBinding {
  meshId: string
  objectKey: string
  confirmation: 'USER_CONFIRMED'
}
