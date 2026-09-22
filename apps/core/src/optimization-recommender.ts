import type { OptimizationRecommendation } from '@thermal-agent/contracts'
import type { LocalDatabase } from '@thermal-agent/sqlite-store'

/** Keyword pre-screening only. A temperature difference or fan curve must still be verified. */
export function recommendOptimizationSkills(database: LocalDatabase, requirement: string): OptimizationRecommendation[] {
  const text = requirement.toLocaleLowerCase()
  const candidates = database.listSkills().filter(skill => skill.kind === 'OPTIMIZATION').map(skill => {
    const guidance = database.getSkill(skill.id)?.version.definition.optimization
    if (!guidance) throw new Error(`optimization skill ${skill.key} has no guidance`)
    const matchedSignals = guidance.keywords.filter(keyword => text.includes(keyword.toLocaleLowerCase()))
    return { skillId: skill.id, activeVersion: skill.activeVersion, key: skill.key, name: skill.name, guidance, matchedSignals,
      suggested: matchedSignals.length > 0, evidenceStatus: 'UNVERIFIED' as const }
  })
  candidates.sort((a, b) => a.guidance.priority - b.guidance.priority || a.key.localeCompare(b.key))
  if (!candidates.some(item => item.suggested) && candidates[0]) candidates[0].suggested = true
  return candidates
}
