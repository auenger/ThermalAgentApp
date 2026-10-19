// Keep the selected interpreter's own site-packages, but never inherit the
// user's PYTHONPATH or current working directory when loading a plugin.
export const PYTHON_PLUGIN_BOOTSTRAP = 'import runpy,sys;sys.path.insert(0,sys.argv[1]);module=sys.argv[2];sys.argv=[module];runpy.run_module(module,run_name="__main__")'

export function pythonPluginArgs(pluginRoot: string, module: string): string[] {
  // Managed package directories are content-addressed: imports must not write __pycache__ into them.
  return ['-I', '-B', '-c', PYTHON_PLUGIN_BOOTSTRAP, pluginRoot, module]
}

export function pythonPluginEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONPATH: '' }
}

export interface PythonPluginLease {
  protocolFailure?(method: string, error: PluginProtocolError): void
  spawn?: import('./plugin-runtime-storage.js').PythonSpawner
  identity?: import('@thermal-agent/contracts').PluginExecutionIdentity
  capabilities?: readonly string[]
  python: string
  pluginRoot: string
  module: string
  release(): void
}

/** Created only by host-side RPC decoding, never from a plugin-supplied error code. */
export class PluginProtocolError extends Error {}

export function decodePluginResponse(line: string, id: string): import('@thermal-agent/contracts').RpcResponse {
  let value: unknown
  try { value = JSON.parse(line) } catch { throw new PluginProtocolError('Plugin returned invalid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginProtocolError('Plugin returned an invalid RPC envelope')
  const response = value as Record<string, unknown>
  if (response.id !== id || typeof response.ok !== 'boolean') throw new PluginProtocolError('Plugin response ID or status is invalid')
  if (response.ok) {
    if (!Object.hasOwn(response, 'result')) throw new PluginProtocolError('Plugin response result is missing')
  } else {
    const error = response.error as Record<string, unknown> | undefined
    if (!error || typeof error !== 'object' || Array.isArray(error) || typeof error.code !== 'string' || !error.code || typeof error.message !== 'string') {
      throw new PluginProtocolError('Plugin response error is invalid')
    }
  }
  return value as import('@thermal-agent/contracts').RpcResponse
}

export function requirePluginCapability(runtime: PythonPluginLease | undefined, method: string, accepted: readonly string[]): void {
  if (runtime?.capabilities && method !== 'health' && !accepted.some(capability => runtime.capabilities!.includes(capability))) {
    throw new Error(`Active plugin does not declare capability for ${method}`)
  }
}
