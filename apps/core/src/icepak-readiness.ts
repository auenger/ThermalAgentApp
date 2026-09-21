import { stat } from 'node:fs/promises'
import type { ArtifactStore } from '@thermal-agent/artifact-store'
import type { IcepakEnvironmentProbe } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'

export const ICEPAK_READINESS_TTL_MS = 30 * 60_000

export async function effectiveIcepakProbe(
  base: IcepakEnvironmentProbe, database: LocalDatabase, artifacts: ArtifactStore,
  now = new Date(),
): Promise<IcepakEnvironmentProbe> {
  if (base.status === 'READY' || base.platform !== 'win32' ||
    !['DETECTED', 'LAUNCHABLE', 'PROJECT_COMPATIBLE'].includes(base.status) || !base.pyaedtAvailable) return base
  const recent = []
  for (const record of database.listIcepakReadiness()) {
    const age = now.getTime() - Date.parse(record.verifiedAt)
    if (!Number.isFinite(age) || age < 0 || age >= ICEPAK_READINESS_TTL_MS ||
      record.pluginVersion !== base.pluginVersion || !base.aedtVersions.includes(record.version)) continue
    const artifact = database.getArtifact(record.resultSha256)
    if (!artifact) continue
    try {
      if ((await stat(artifacts.resolveArtifact(record.resultSha256))).size === artifact.sizeBytes) recent.push(record)
    } catch { /* lost evidence cannot attest readiness */ }
  }
  if (!recent.length) return base
  const latest = recent[0]
  return {
    ...base, status: 'READY', licenseStatus: 'AVAILABLE',
    aedtVersions: recent.map(item => item.version), selectedVersion: latest.version,
    readinessVerifiedAt: latest.verifiedAt,
    readinessExpiresAt: new Date(Date.parse(latest.verifiedAt) + ICEPAK_READINESS_TTL_MS).toISOString(),
    diagnostics: [
      `A real Icepak solve completed at ${latest.verifiedAt}; readiness evidence expires after 30 minutes`,
      'License availability can change; each accepted task still requires a fresh successful checkout and solve',
    ],
  }
}

export function provesIcepakSolve(result: {
  status?: unknown; mode?: unknown; validation?: { verified?: unknown };
  solve?: { succeeded?: unknown }; metrics?: Record<string, unknown>;
  project?: { aedtVersion?: unknown };
}, version: string): boolean {
  return result.status === 'ok' && result.mode === 'solve' &&
    result.validation?.verified === true && result.solve?.succeeded === true &&
    result.metrics?.solverNormalCompletion === true && result.project?.aedtVersion === version
}
