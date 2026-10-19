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
  identity?: import('@thermal-agent/contracts').PluginExecutionIdentity
  python: string
  pluginRoot: string
  module: string
  release(): void
}
