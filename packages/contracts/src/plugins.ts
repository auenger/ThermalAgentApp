/** The App host API is independent of the DSH and solver protocol versions. */
export const PLUGIN_HOST_API = 3
export const MAX_PLUGIN_WHEEL_ASSET_BYTES = 256 * 1024 * 1024
export const MAX_PLUGIN_WHEEL_ASSETS_BYTES = 1024 * 1024 * 1024

export interface PluginExecutionIdentity {
  pluginId: string
  pluginVersion: string
  packageDigest?: string
  environmentDigest?: string
}

export function parsePluginExecutionIdentity(value: unknown): PluginExecutionIdentity | undefined {
  if (value === undefined) return undefined // Historical attempts predate managed plugins.
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved plugin identity')
  const v = value as Record<string, unknown>
  if (typeof v.pluginId !== 'string' || !v.pluginId || typeof v.pluginVersion !== 'string' || !v.pluginVersion ||
    (v.packageDigest !== undefined && (typeof v.packageDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(v.packageDigest))) ||
    (v.environmentDigest !== undefined && (typeof v.environmentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(v.environmentDigest))) ||
    (v.packageDigest === undefined) !== (v.environmentDigest === undefined)) throw new Error('Invalid saved plugin identity')
  return { pluginId: v.pluginId, pluginVersion: v.pluginVersion,
    ...(v.packageDigest ? { packageDigest: v.packageDigest as string, environmentDigest: v.environmentDigest as string } : {}) }
}

export interface ManagedPluginManifest {
  pythonRuntime?: { schemaVersion: 1; wheels: Array<{ name: string; version: string; path: string; sha256: string; asset?: { sizeBytes: number } }> }
  schemaVersion: 1
  id: string
  version: string
  hostApi: 1 | 2 | 3
  kind: 'icepak' | 'report'
  entry: { root: string; module: string }
  capabilities: string[]
  permissions: string[]
  compatibility: {
    platforms: string[]
    architectures: string[]
    /** Exact tested versions. Omitted keys do not constrain that environment fact. */
    versions: Record<string, string[]>
  }
}

export interface PluginEnvironment {
  platform: string
  architecture: string
  versions: Record<string, string>
}

const safeId = /^[a-z][a-z0-9-]{0,79}$/u
const version = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u
export function parseManagedPluginManifest(value: unknown): ManagedPluginManifest {
  const object = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Plugin manifest must contain objects')
    return input as Record<string, unknown>
  }
  const list = (input: unknown, allowEmpty = false): string[] => {
    if (!Array.isArray(input) || (!allowEmpty && !input.length) || input.length > 100 ||
      input.some(item => typeof item !== 'string' || !item || item.length > 150) || new Set(input).size !== input.length) {
      throw new Error('Invalid plugin manifest list')
    }
    return [...input]
  }
  const m = object(value), entry = object(m.entry), compatibility = object(m.compatibility)
  if (m.schemaVersion !== 1 || m.hostApi !== 1 && m.hostApi !== 2 && m.hostApi !== PLUGIN_HOST_API) throw new Error('Unsupported plugin host API or manifest schema')
  if (typeof m.id !== 'string' || !safeId.test(m.id) || ['constructor', 'prototype'].includes(m.id) ||
    typeof m.version !== 'string' || !version.test(m.version)) throw new Error('Invalid plugin identity')
  if (m.kind !== 'icepak' && m.kind !== 'report') throw new Error('Unsupported plugin kind')
  if (typeof entry.root !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u.test(entry.root) ||
    typeof entry.module !== 'string' || !/^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/u.test(entry.module)) throw new Error('Invalid plugin entry')
  const versions: Record<string, string[]> = {}
  for (const [key, values] of Object.entries(object(compatibility.versions))) {
    if (!/^[a-z][a-z0-9-]{0,49}$/u.test(key)) throw new Error('Invalid environment version key')
    versions[key] = list(values)
  }
  let pythonRuntime: ManagedPluginManifest['pythonRuntime']
  if (m.pythonRuntime !== undefined) {
    if (m.hostApi !== 2 && m.hostApi !== 3) throw new Error('Locked Python runtimes require host API 2 or 3')
    const runtime = object(m.pythonRuntime)
    if (runtime.schemaVersion !== 1 || !Array.isArray(runtime.wheels) || !runtime.wheels.length || runtime.wheels.length > 100) throw new Error('Invalid Python runtime wheel lock')
    const names = new Set<string>(), paths = new Set<string>()
    let assetBytes = 0
    const wheels = runtime.wheels.map(value => {
      const wheel = object(value)
      if (typeof wheel.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(wheel.name) || names.has(wheel.name) ||
        typeof wheel.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.!+_-]{0,79}$/u.test(wheel.version) ||
        typeof wheel.path !== 'string' || wheel.path.length > 180 || !/^wheels\/[a-zA-Z0-9_.-]+\.whl$/u.test(wheel.path) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(wheel.path.slice(7)) || paths.has(wheel.path.toLowerCase()) ||
        typeof wheel.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(wheel.sha256)) throw new Error('Invalid locked Python wheel')
      names.add(wheel.name); paths.add(wheel.path.toLowerCase())
      let asset: { sizeBytes: number } | undefined
      if (wheel.asset !== undefined) {
        if (m.hostApi !== 3) throw new Error('External wheel assets require host API 3')
        const value = object(wheel.asset)
        if (!Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) <= 0 || (value.sizeBytes as number) > MAX_PLUGIN_WHEEL_ASSET_BYTES) throw new Error('Invalid wheel asset size')
        asset = { sizeBytes: value.sizeBytes as number }
        assetBytes += asset.sizeBytes
        if (assetBytes > MAX_PLUGIN_WHEEL_ASSETS_BYTES) throw new Error('Wheel asset closure exceeds 1 GiB')
      }
      return { name: wheel.name, version: wheel.version, path: wheel.path, sha256: wheel.sha256, ...(asset ? { asset } : {}) }
    })
    pythonRuntime = { schemaVersion: 1, wheels }
  }
  return { schemaVersion: 1, hostApi: m.hostApi, id: m.id, version: m.version, kind: m.kind,
    ...(pythonRuntime ? { pythonRuntime } : {}),
    entry: { root: entry.root, module: entry.module }, capabilities: list(m.capabilities), permissions: list(m.permissions, true),
    compatibility: { platforms: list(compatibility.platforms), architectures: list(compatibility.architectures), versions } }
}

export function pluginCompatibility(manifest: ManagedPluginManifest, environment: PluginEnvironment): string[] {
  const problems: string[] = []
  if (!manifest.compatibility.platforms.includes(environment.platform)) problems.push(`Unsupported platform: ${environment.platform}`)
  if (!manifest.compatibility.architectures.includes(environment.architecture)) problems.push(`Unsupported architecture: ${environment.architecture}`)
  for (const [key, supported] of Object.entries(manifest.compatibility.versions)) {
    const actual = environment.versions[key]
    if (!actual || !supported.includes(actual)) problems.push(`Unsupported ${key}: ${actual ?? 'unknown'}`)
  }
  return problems
}
