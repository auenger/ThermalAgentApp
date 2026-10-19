import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import { parameterValuesEqual, parseEditableParameters, parseParameterPlanRequest, resolveParameterChanges,
  type IcepakProjectOperationResult, type PluginExecutionIdentity } from '@thermal-agent/contracts'
import type { IcepakPluginPort, PluginCallOptions } from './icepak-plugin-client.js'
import type { PluginValidation } from './plugin-store.js'

export const ENGINEERING_CAPABILITIES = ['health', 'environment_probe', 'project_inspect', 'parameter_check', 'baseline_solve'] as const
export interface EngineeringValidationPolicy {
  schemaVersion: 1
  profile: 'project-parameters-solve-v1'
  allowValidationSolves: true
  fixturePath: string
  fixtureSha256: string
  aedtExecutablePath: string
  aedtExecutableSha256: string
  aedtVersion: string
  design: string
  setup: string
  changes: Array<{ parameterId: string; value: string; role: 'design' | 'operating-condition' }>
  cores: number
  timeoutMs: number
  tmaxRangeC: { minimum: number; maximum: number }
  maxDeltaC: number
}
export function parseEngineeringValidationPolicy(value: unknown): EngineeringValidationPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid engineering validation policy')
  const p = value as EngineeringValidationPolicy
  if (p.schemaVersion !== 1 || p.profile !== 'project-parameters-solve-v1' || p.allowValidationSolves !== true) throw new Error('Engineering validation requires the supported profile and explicit solve authorization')
  for (const key of ['fixturePath', 'aedtExecutablePath', 'aedtVersion', 'design', 'setup'] as const) {
    if (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > 1000) throw new Error('Invalid engineering fixture identity')
  }
  if (!isAbsolute(p.fixturePath) || !isAbsolute(p.aedtExecutablePath) || !/\.aedt$/iu.test(p.fixturePath) || !/\.exe$/iu.test(p.aedtExecutablePath) ||
    !/^[a-f0-9]{64}$/u.test(p.fixtureSha256) || !/^[a-f0-9]{64}$/u.test(p.aedtExecutableSha256)) throw new Error('Engineering fixture and executable require absolute paths and SHA-256')
  const request = parseParameterPlanRequest({ changes: p.changes, author: 'host', reason: 'upgrade validation', sourceAttemptId: 'fixture' })
  if (!Number.isInteger(p.cores) || p.cores < 1 || p.cores > 64 || !Number.isInteger(p.timeoutMs) || p.timeoutMs < 1000 || p.timeoutMs > 30 * 60_000 ||
    !p.tmaxRangeC || !Number.isFinite(p.tmaxRangeC.minimum) || !Number.isFinite(p.tmaxRangeC.maximum) || p.tmaxRangeC.minimum >= p.tmaxRangeC.maximum ||
    !Number.isFinite(p.maxDeltaC) || p.maxDeltaC <= 0 || p.maxDeltaC > 5) throw new Error('Invalid engineering solve budget or temperature tolerance')
  return { schemaVersion: 1, profile: p.profile, allowValidationSolves: true, fixturePath: p.fixturePath, fixtureSha256: p.fixtureSha256,
    aedtExecutablePath: p.aedtExecutablePath, aedtExecutableSha256: p.aedtExecutableSha256, aedtVersion: p.aedtVersion,
    design: p.design, setup: p.setup, changes: request.changes, cores: p.cores, timeoutMs: p.timeoutMs,
    tmaxRangeC: { ...p.tmaxRangeC }, maxDeltaC: p.maxDeltaC }
}

export async function engineeringFileHash(path: string): Promise<string> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 * 1024) throw new Error('Engineering fixture must be a regular file of at most 512 MiB')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    if (bytes > 512 * 1024 * 1024) throw new Error('Engineering file changed beyond size limit')
    hash.update(chunk)
  }
  if (bytes !== stat.size) throw new Error('Engineering file changed while reading')
  return hash.digest('hex')
}
export async function engineeringPolicyBinding(policy: EngineeringValidationPolicy, referenceDigest: string): Promise<string> {
  if (await engineeringFileHash(policy.fixturePath) !== policy.fixtureSha256 ||
    await engineeringFileHash(policy.aedtExecutablePath) !== policy.aedtExecutableSha256) throw new Error('Engineering fixture or AEDT executable digest changed')
  return createHash('sha256').update(JSON.stringify({ validator: 1, policy, referenceDigest })).digest('hex')
}

function assertProject(result: IcepakProjectOperationResult, policy: EngineeringValidationPolicy, hash: string): void {
  if (result.status !== 'ok' || result.validation?.verified !== true || result.inputSha256 !== hash ||
    result.project?.aedtVersion !== policy.aedtVersion || result.project.activeDesign !== policy.design || !result.project.setups.includes(policy.setup)) throw new Error('Engineering result does not match the host fixture identity')
}
function solveTemperature(result: IcepakProjectOperationResult, policy: EngineeringValidationPolicy, hash: string): number {
  assertProject(result, policy, hash)
  const m = result.metrics, tmax = m?.tmaxC
  if (result.mode !== 'solve' || result.solve?.attempted !== true || result.solve.succeeded !== true || result.solve.setup !== policy.setup ||
    !m || !['converged', 'solverNormalCompletion', 'flowConverged', 'temperatureConverged', 'monitorTemperatureStable'].every(key => m[key] === true) ||
    m.reversedFlowDetected !== false || typeof tmax !== 'number' || !Number.isFinite(tmax) || tmax < policy.tmaxRangeC.minimum || tmax > policy.tmaxRangeC.maximum) throw new Error('Engineering fixture lacks acceptable solve and convergence evidence')
  return tmax
}

/** Candidate output is independently reopened and solved by the immutable App-shipped reference. */
export async function validateEngineeringPlugin(input: {
  home: string; policy: EngineeringValidationPolicy; candidate: IcepakPluginPort; reference: IcepakPluginPort;
  candidateIdentity: PluginExecutionIdentity; referenceIdentity: PluginExecutionIdentity; options: PluginCallOptions;
}): Promise<PluginValidation['checks']> {
  const { policy, candidate, reference } = input
  if (!candidate.checkChanges) throw new Error('Candidate has no parameter-check operation')
  const root = join(input.home, 'engineering-validations', randomUUID())
  await mkdir(root, { recursive: true })
  const checks: PluginValidation['checks'] = []
  const evidence: Record<string, unknown> = { profile: policy.profile, policy, candidate: input.candidateIdentity, reference: input.referenceIdentity, checks }
  const options = { ...input.options, timeoutMs: policy.timeoutMs }
  const check = (name: string, detail: string) => checks.push({ name, passed: true, detail })
  try {
    const binding = await engineeringPolicyBinding(policy, input.referenceIdentity.packageDigest!)
    evidence.binding = binding
    const probe = await reference.probeEnvironment()
    if (probe.platform !== 'win32' || !probe.pyaedtAvailable || !probe.aedtVersions.includes(policy.aedtVersion)) throw new Error('Reference cannot attest the configured Windows AEDT environment')
    const source = join(root, basename(policy.fixturePath))
    await copyFile(policy.fixturePath, source)
    if (await engineeringFileHash(source) !== policy.fixtureSha256) throw new Error('Fixture copy digest mismatch')
    const base = { projectPath: source, version: policy.aedtVersion, design: policy.design, setup: policy.setup, cores: policy.cores, nonGraphical: true }
    const before = await reference.inspectProject({ ...base, outputDir: join(root, 'reference-before') }, options)
    evidence.referenceBefore = before
    assertProject(before, policy, policy.fixtureSha256)
    const referenceCatalog = parseEditableParameters(before.parameterCatalog?.editableParameters)
    const request = { changes: policy.changes, sourceAttemptId: 'fixture', author: 'host', reason: 'upgrade validation' }
    const expected = resolveParameterChanges(referenceCatalog, request)
    if (expected.some(change => change.parameter.adapter === 'fan')) throw new Error('Fan curves require a dedicated engineering validation profile')
    const inspected = await candidate.inspectProject({ ...base, outputDir: join(root, 'candidate-before') }, options)
    evidence.candidateBefore = inspected
    assertProject(inspected, policy, policy.fixtureSha256)
    const changes = resolveParameterChanges(parseEditableParameters(inspected.parameterCatalog?.editableParameters), request)
    if (changes.some((change, index) => change.parameter.target !== expected[index].parameter.target || change.parameter.unit !== expected[index].parameter.unit ||
      change.parameter.role !== expected[index].parameter.role || !parameterValuesEqual(expected[index].parameter, change.parameter.currentValue, expected[index].parameter.currentValue))) throw new Error('Candidate parameter discovery differs from reference')
    check('engineering-discovery', 'Candidate and shipped reference agree on fixture parameters, units, roles and original values')
    const edited = await candidate.checkChanges({ ...base, changes, outputDir: join(root, 'candidate-edit') }, options)
    evidence.candidateEdit = edited
    assertProject(edited, policy, policy.fixtureSha256)
    if (!edited.verifiedProjectPath || !edited.validation.checks.includes('persistedParameters')) throw new Error('Candidate did not provide a persisted parameter project')
    const actual = await realpath(edited.verifiedProjectPath), allowed = await realpath(join(root, 'candidate-edit'))
    const rel = relative(allowed, actual)
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Candidate output escaped its validation directory')
    const editedHash = await engineeringFileHash(actual)
    const frozen = join(root, 'frozen.aedt')
    await copyFile(actual, frozen)
    if (await engineeringFileHash(frozen) !== editedHash) throw new Error('Candidate project changed while freezing')
    const changedBase = { ...base, projectPath: frozen }
    const reopened = await reference.inspectProject({ ...changedBase, outputDir: join(root, 'reference-readback') }, options)
    evidence.referenceReadback = reopened
    assertProject(reopened, policy, editedHash)
    const readback = parseEditableParameters(reopened.parameterCatalog?.editableParameters)
    for (const change of expected) {
      const persisted = readback.find(item => item.id === change.parameter.id)
      if (!persisted || persisted.target !== change.parameter.target || persisted.unit !== change.parameter.unit || persisted.role !== change.parameter.role ||
        !parameterValuesEqual(change.parameter, persisted.currentValue, change.value)) throw new Error(`Independent engineering readback failed: ${change.parameter.id}`)
    }
    for (const original of referenceCatalog.filter(item => !expected.some(change => change.parameter.id === item.id))) {
      const persisted = readback.find(item => item.id === original.id)
      if (!persisted || persisted.target !== original.target || persisted.unit !== original.unit || persisted.role !== original.role ||
        !parameterValuesEqual(original, persisted.currentValue, original.currentValue)) throw new Error(`Unrequested fixture parameter changed: ${original.id}`)
    }
    if (JSON.stringify(before.parameterCatalog?.fans ?? []) !== JSON.stringify(reopened.parameterCatalog?.fans ?? []) ||
      JSON.stringify([...before.project.objects].sort()) !== JSON.stringify([...reopened.project.objects].sort())) throw new Error('Unrequested fan curves or object inventory changed')
    check('engineering-readback', `Shipped reference reopened the candidate's saved project and checked requested and unchanged parameters; SHA-256 ${editedHash}`)
    const referenceSolve = await reference.solveProject({ ...changedBase, outputDir: join(root, 'reference-solve') }, options)
    evidence.referenceSolve = referenceSolve
    const candidateSolve = await candidate.solveProject({ ...changedBase, outputDir: join(root, 'candidate-solve') }, options)
    evidence.candidateSolve = candidateSolve
    const referenceTmax = solveTemperature(referenceSolve, policy, editedHash), candidateTmax = solveTemperature(candidateSolve, policy, editedHash)
    if (Math.abs(candidateTmax - referenceTmax) > policy.maxDeltaC) throw new Error('Candidate solve disagrees with the independent reference')
    if (await engineeringFileHash(source) !== policy.fixtureSha256 || await engineeringFileHash(frozen) !== editedHash || await engineeringPolicyBinding(policy, input.referenceIdentity.packageDigest!) !== binding) throw new Error('Engineering validation inputs changed during execution')
    evidence.editedHash = editedHash
    check('engineering-solve-comparison', `Both solves converged within configured range; candidate ${candidateTmax} C, reference ${referenceTmax} C, permitted difference ${policy.maxDeltaC} C`)
  } catch (error) {
    checks.push({ name: 'engineering-validation', passed: false, detail: error instanceof Error ? error.message : String(error) })
  }
  const path = join(root, 'evidence.json')
  await writeFile(path, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 })
  const hash = createHash('sha256').update(await readFile(path)).digest('hex')
  return [...checks, { name: 'engineering-evidence', passed: true, detail: `Host evidence ${path}; SHA-256 ${hash}; fixture compatibility only, not a user-task design verdict` }]
}
