import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import type { DynamicScriptLibrary } from './dynamic-script-library.js'

/** Read-only collection. No model request, solver invocation or promotion of evidence level. */
export async function collectDynamicScriptEvidence(taskId: string, library: DynamicScriptLibrary, artifacts: ArtifactStore) {
  const runs = library.runs(taskId), iterations = library.iterations(taskId)
  const ids = new Set([...runs.map(run => run.scriptId), ...iterations.map(job => job.plan.scriptId)])
  const scripts = [...ids].map(id => ({ ...library.get(id), submissions: library.submissions(id) }))
  const refs = new Map<string, boolean>()
  const add = (digest: unknown, json = false) => {
    if (typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest)) refs.set(digest, (refs.get(digest) ?? false) || json)
  }
  for (const run of runs) {
    add(run.projectSha256); add(run.evidence?.projectSha256); add(run.evidence?.artifactSha256, true)
  }
  for (const job of iterations) {
    add(job.projectSha256)
    for (const round of job.rounds) { add(round.scriptProjectSha256); add(round.solvedProjectSha256); add(round.resultSha256, true) }
  }
  const checks: Array<{ sha256: string; bytes?: number; verified: boolean; error?: string }> = []
  const receipts: Record<string, unknown> = {}
  let receiptBytes = 0
  const processed = new Set<string>()
  for (const [sha256, json] of refs) {
    if (processed.has(sha256)) continue
    if (processed.size >= 1024) throw new Error('Evidence collection exceeds 1024 artifacts; export fewer task runs')
    processed.add(sha256)
    try {
      const path = artifacts.resolveArtifact(sha256), stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Artifact must be a regular file')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) hash.update(chunk)
      if (hash.digest('hex') !== sha256) throw new Error('Artifact SHA256 mismatch')
      checks.push({ sha256, bytes: stat.size, verified: true })
      if (json) {
        receiptBytes += stat.size
        if (receiptBytes > 64 * 1024 * 1024) throw new Error('Combined JSON receipts exceed 64 MiB')
        if (stat.size > 8 * 1024 * 1024) throw new Error('JSON receipt exceeds 8 MiB')
        const bytes = await readFile(path)
        if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Receipt changed during collection')
        const receipt = JSON.parse(bytes.toString('utf8'))
        receipts[sha256] = receipt
        // Only follow digest references in Core receipt fields, never arbitrary paths from script output.
        add(receipt.project?.sha256); add(receipt.convergence?.sha256, true); add(receipt.solverResultSha256, true)
        if (Array.isArray(receipt.rawArtifacts)) for (const item of receipt.rawArtifacts) add(item?.sha256)
      }
    } catch (error) {
      const existing = checks.find(item => item.sha256 === sha256)
      if (existing) { existing.verified = false; existing.error = String(error) }
      else checks.push({ sha256, verified: false, error: String(error) })
    }
  }
  const native = runs.filter(run => run.status === 'SUCCEEDED' && run.evidence?.kind === 'native-aedt')
  return { schemaVersion: 1, purpose: 'dynamic-icepak-evidence', collectedAt: new Date().toISOString(), taskId,
    collector: { platform: process.platform, architecture: process.arch, nodeVersion: process.version },
    status: checks.some(item => !item.verified) ? 'artifact-errors' : 'collected',
    acceptance: 'manual-review-required',
    observations: { nativeReadbacks: native.length, testDoubleReadbacks: runs.filter(run => run.evidence?.kind === 'test-double').length,
      coreInstancesWithNativeReadback: [...new Set(native.map(run => run.coreInstanceId).filter(Boolean))],
      agentSubmittedScriptIds: scripts.filter(script => script.submissions.some(item => item.channel === 'agent')).map(script => script.id),
      nativeSolvedRounds: iterations.flatMap(job => job.rounds).filter(round => round.status === 'SUCCEEDED' && round.executionKind === 'native-aedt').length },
    scope: 'Submission channel does not prove model authorship. Multiple Core instance IDs indicate separate managers, not independent proof of an App restart. Artifacts and traces require engineering review; test-double records are never native evidence.',
    scripts, runs, iterations, artifactChecks: checks, receipts }
}
