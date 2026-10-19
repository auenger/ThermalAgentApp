import type { PluginEnvironment, PluginExecutionIdentity } from '@thermal-agent/contracts'
import { pluginEnvironmentDigest, type PluginStore } from './plugin-store.js'
import type { PythonPluginLease } from './python-plugin-launch.js'

/** Interpreter selection remains host-owned; manifests cannot supply an executable or shell command. */
export function managedPythonRuntime(store: PluginStore, id: string, kind: 'icepak' | 'report',
  python: string, environment: () => PluginEnvironment): (expected?: PluginExecutionIdentity) => PythonPluginLease {
  return expected => {
    const facts = environment()
    const environmentDigest = pluginEnvironmentDigest(facts)
    if (expected && (!expected.packageDigest || expected.pluginId !== id || expected.environmentDigest !== environmentDigest)) throw new Error('Pinned plugin environment or identity changed')
    const lease = store.acquire(id, facts, expected?.packageDigest)
    if (lease.revision.manifest.kind !== kind) { lease.release(); throw new Error('Plugin kind does not match the client') }
    if (expected && expected.pluginVersion !== lease.revision.manifest.version) { lease.release(); throw new Error('Pinned plugin version mismatch') }
    return { python, pluginRoot: lease.root, module: lease.revision.manifest.entry.module,
      identity: { pluginId: id, pluginVersion: lease.revision.manifest.version, packageDigest: lease.revision.digest, environmentDigest }, release: lease.release }
  }
}
