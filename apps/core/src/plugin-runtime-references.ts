import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import type { LocalDatabase, ModelPreparationStore } from '@thermal-agent/sqlite-store'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import { parsePluginExecutionIdentity, type PluginExecutionIdentity } from '@thermal-agent/contracts'

/** Missing or altered saved evidence defers collection rather than guessing that no reference exists. */
export async function pluginRuntimeReferences(database: LocalDatabase, modelStore: ModelPreparationStore, artifacts: ArtifactStore): Promise<PluginExecutionIdentity[]> {
  const { identities, resultArtifacts } = database.pluginRuntimeRetention()
  const direct = new Set(modelStore.pluginRuntimeArtifacts()), nested = new Set(resultArtifacts)
  const hashes = new Set([...direct, ...nested])
  if (hashes.size > 10_000) throw new Error('Runtime artifact reference inventory exceeds 10000 files')
  let bytes = 0
  for (const sha of hashes) {
    const path = artifacts.resolveArtifact(sha), stat = await lstat(path)
    bytes += stat.size
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error('Runtime reference artifact exceeds inventory limits')
    const content = await readFile(path)
    if (createHash('sha256').update(content).digest('hex') !== sha) throw new Error('Saved runtime reference artifact SHA-256 mismatch')
    const value = JSON.parse(content.toString('utf8'))
    if (direct.has(sha)) { const identity = parsePluginExecutionIdentity(value); if (identity) identities.push(identity) }
    if (nested.has(sha)) { const identity = parsePluginExecutionIdentity(value.pluginRuntime); if (identity) identities.push(identity) }
  }
  return identities
}
