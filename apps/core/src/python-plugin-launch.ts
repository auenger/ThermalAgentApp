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
  spawn?: import('./plugin-runtime-storage.js').PythonSpawner
  identity?: import('@thermal-agent/contracts').PluginExecutionIdentity
  capabilities?: readonly string[]
  python: string
  pluginRoot: string
  module: string
  release(): void
}

export function requirePluginCapability(runtime: PythonPluginLease | undefined, method: string, accepted: readonly string[]): void {
  if (runtime?.capabilities && method !== 'health' && !accepted.some(capability => runtime.capabilities!.includes(capability))) {
    throw new Error(`Active plugin does not declare capability for ${method}`)
  }
}
