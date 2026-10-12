// Exercise the actual App API. This does not replace engineering comparison or installer acceptance.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, realpathSync } from 'node:fs'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createThermalModelSpec } from '../packages/contracts/dist/index.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))
const uuid = /^[0-9a-f-]{36}$/iu
async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

async function downloadArtifact(url, destination, expectedSha) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha)) throw new Error('Invalid artifact hash')
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok || !response.body) throw new Error(`Artifact download failed (${response.status})`)
  const temp = `${destination}.${randomUUID()}.partial`
  const hash = createHash('sha256')
  let sizeBytes = 0
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, done) {
      sizeBytes += chunk.length
      if (sizeBytes > 2 * 1024 ** 3) { done(new Error('Artifact exceeds 2 GiB limit')); return }
      hash.update(chunk); done(null, chunk)
    } }), createWriteStream(temp, { flags: 'wx' }))
    if (hash.digest('hex') !== expectedSha) throw new Error('Artifact download SHA mismatch')
    // A hard link makes publication non-overwriting even when two collectors share an output folder.
    try { await link(temp, destination) }
    catch (error) { if (error.code !== 'EEXIST' || await hashFile(destination) !== expectedSha) throw error }
    return sizeBytes
  } finally { await unlink(temp).catch(() => {}) }
}
export function parseAcceptanceArgs(args) {
  const options = { solve: false, version: '2024.2', timeoutMinutes: 240, output: '.thermal-agent/cad-acceptance' }
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (key === '--solve') { options.solve = true; continue }
    if (key === '--help') { options.help = true; continue }
    const names = { '--base': 'base', '--cad': 'cad', '--task': 'taskId', '--spec': 'spec', '--version': 'version', '--out': 'output', '--timeout-minutes': 'timeoutMinutes', '--observe-job': 'observeJob' }
    if (!names[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${key}`)
    options[names[key]] = args[++i]
  }
  if (options.help) return options
  const base = new URL(options.base ?? 'http://127.0.0.1:43110')
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('--base must be the App loopback HTTP address without credentials or a path')
  options.base = base.origin
  if (!options.cad && !options.taskId) throw new Error('Provide --cad for a new task or --task to continue an imported task')
  if (options.taskId && !uuid.test(options.taskId)) throw new Error('--task must be a Task UUID')
  if (options.taskId && options.cad) throw new Error('--cad and --task are mutually exclusive')
  if (options.observeJob && (!options.taskId || !uuid.test(options.observeJob) || options.cad || options.spec || options.solve)) throw new Error('--observe-job requires --task and cannot import, prepare or solve')
  if (options.solve && !options.spec) throw new Error('--solve requires a reviewed --spec file')
  if (!/^20\d{2}\.[12]$/u.test(options.version)) throw new Error('--version must be an AEDT version such as 2024.2')
  options.timeoutMinutes = Number(options.timeoutMinutes)
  if (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes < 1 || options.timeoutMinutes > 1440) throw new Error('--timeout-minutes must be in [1, 1440]')
  return options
}

export async function runCadAcceptance(options, { log = console.log, pollMs = 1500 } = {}) {
  const output = resolve(options.output)
  await mkdir(output, { recursive: true })
  const record = { schemaVersion: 1, runId: randomUUID(), startedAt: new Date().toISOString(),
    taskId: options.taskId ?? null, stage: 'STARTING', evidenceKind: 'UNVERIFIED', engineeringAcceptance: 'PENDING', installerAcceptance: 'PENDING',
    requests: [], artifacts: [], error: null }
  const recordPath = resolve(output, `acceptance-${record.runId}.json`)
  const persist = async () => writeFile(recordPath, JSON.stringify(record, null, 2))
  const deadline = Date.now() + options.timeoutMinutes * 60000
  const lastReads = new Map()
  const json = async (path, value, method = 'POST') => {
    const response = await fetch(options.base + path, { signal: AbortSignal.timeout(30000), ...(value === undefined ? {} : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    }) })
    const body = await response.json()
    const fingerprint = digest(JSON.stringify(body))
    if (value !== undefined || lastReads.get(path) !== fingerprint) {
      record.requests.push({ at: new Date().toISOString(), method: value === undefined ? 'GET' : method, path, status: response.status, body })
      if (value === undefined) lastReads.set(path, fingerprint)
      await persist()
    }
    if (!response.ok) throw new Error(`${path}: ${body.error?.code ?? response.status}: ${body.error?.message ?? 'request failed'}`)
    return body
  }
  const checkedId = id => { if (!uuid.test(id)) throw new Error('App returned an invalid record UUID'); return id }
  const taskPath = () => `/api/tasks/${checkedId(record.taskId)}`
  const context = () => json(`${taskPath()}/model-preparations`)
  const waitJob = async id => {
    checkedId(id)
    let stage = ''
    while (Date.now() < deadline) {
      const current = await context()
      const job = current.jobs.find(j => j.id === id)
      if (!job) throw new Error(`App lost model job ${id}`)
      if (`${job.status}/${job.stage}` !== stage) { stage = `${job.status}/${job.stage}`; log(`${job.kind}: ${stage}`) }
      if (job.status === 'SUCCEEDED') return current
      if (['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(job.status)) {
        await collect(current)
        throw new Error(`${job.kind} ${job.status}: ${job.error?.code ?? ''} ${job.error?.message ?? ''}`)
      }
      await sleep(pollMs)
    }
    // An observation deadline does not imply that a solver has stopped; preserve the handle.
    record.stage = 'OBSERVATION_TIMEOUT'
    record.liveJobId = id
    throw new Error(`Observation deadline exceeded; job ${id} may still be running in the App. Resume observation rather than automatically re-running it.`)
  }
  const collect = async current => {
    for (const job of current.jobs) {
      for (const artifact of job.artifacts) {
        if (record.artifacts.some(a => a.jobId === job.id && a.role === artifact.role)) continue
        if (!/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new Error('App returned an invalid artifact hash')
        const fileName = `${checkedId(job.id)}-${artifact.role.replace(/[^a-zA-Z0-9_-]/gu, '_')}-${basename(artifact.originalName).replace(/[^a-zA-Z0-9._-]/gu, '_')}`
        const destination = resolve(output, fileName)
        const sizeBytes = await downloadArtifact(`${options.base}${taskPath()}/model-artifacts/${artifact.sha256}`, destination, artifact.sha256)
        record.artifacts.push({ jobId: job.id, role: artifact.role, sha256: artifact.sha256, file: fileName, sizeBytes })
      }
    }
    await persist()
  }
  try {
    await persist()
    await json('/api/health')
    if (options.observeJob) {
      record.observedJobId = checkedId(options.observeJob)
      const observed = await waitJob(options.observeJob)
      await collect(observed)
      const job = observed.jobs.find(j => j.id === options.observeJob)
      const source = observed.inspections.find(i => i.id === job.inspectionId)
      record.environment = source?.environment
      record.evidenceKind = source?.environment?.evidenceKind === 'REAL_ICEPAK' && source?.environment?.platform === 'Windows' && source?.environment?.pyaedtVersion === '1.6.0' ? 'REAL_ICEPAK' : 'TEST_DOUBLE_OR_UNVERIFIED'
      record.stage = 'JOB_SUCCEEDED_ENGINEERING_REVIEW_REQUIRED'
      record.finishedAt = new Date().toISOString()
      await persist()
      log(`Observed existing job ${options.observeJob}. Evidence: ${recordPath}. No new job or solver was started.`)
      return record
    }
    if (!record.taskId) {
      const cad = resolve(options.cad)
      if (!/\.(step|stp)$/iu.test(cad)) throw new Error('--cad must be a STEP/STP file')
      const sourceSha = await hashFile(cad)
      const response = await fetch(`${options.base}/api/models/upload`, { method: 'POST', headers: { 'x-model-name': encodeURIComponent(basename(cad)) }, body: createReadStream(cad), duplex: 'half', signal: AbortSignal.timeout(120000) })
      const uploaded = await response.json()
      if (!response.ok || uploaded.model?.sha256 !== sourceSha) throw new Error(`CAD upload failed: ${uploaded.error?.message ?? 'source hash mismatch'}`)
      record.sourceSha256 = uploaded.model.sha256
      const created = await json('/api/tasks', { title: `CAD 验收 ${new Date().toISOString()}`, description: '通过 App API 验证 CAD 到基础热模型；工程验收另行记录。',
        requirementSnapshot: { intakeVersion: 2, modelSha256: uploaded.model.sha256, selectedOptimizationSkillIds: [], aedtVersion: options.version } })
      record.taskId = checkedId(created.task.id)
      const submitted = await json(`${taskPath()}/cad-inspections`, { requestId: randomUUID(), version: options.version, healing: false })
      record.importJobId = checkedId(submitted.job.id)
      await waitJob(submitted.job.id)
    }
    let current = await context()
    const inspection = current.inspections.filter(i => i.status === 'SUCCEEDED').at(-1)
    // Resolve an explicitly reviewed spec to its original inspection; never silently remap objects.
    const spec = options.spec ? JSON.parse(await readFile(resolve(options.spec), 'utf8')) : null
    const selected = spec ? current.inspections.find(i => i.id === spec.inspectionId) : inspection
    if (!selected || selected.status !== 'SUCCEEDED') throw new Error('No successful inspection matching the requested spec; finish/import the task in the App first')
    record.sourceSha256 = selected.sourceSha256
    record.environment = selected.environment
    record.evidenceKind = selected.environment?.evidenceKind === 'REAL_ICEPAK' && selected.environment?.platform === 'Windows' && selected.environment?.pyaedtVersion === '1.6.0' ? 'REAL_ICEPAK' : 'TEST_DOUBLE_OR_UNVERIFIED'
    await collect(current)
    if (!spec) {
      const fileName = `model-spec-${selected.id}-${record.runId}.json`
      await writeFile(resolve(output, fileName), JSON.stringify(createThermalModelSpec(selected), null, 2), { flag: 'wx' })
      record.stage = 'CAD_IMPORTED_REVIEW_REQUIRED'
      record.specFile = fileName
      log(`CAD imported. Review and complete ${resolve(output, fileName)}, then continue with --task ${record.taskId} --spec <reviewed-file>.`)
    } else {
      const saved = await json(`${taskPath()}/model-spec`, { spec, expectedVersion: current.draft?.version ?? 0 }, 'PUT')
      const prepared = await json(`${taskPath()}/model-preparations`, { requestId: randomUUID(), draftVersion: saved.draft.version })
      record.prepareJobId = checkedId(prepared.job.id)
      current = await waitJob(prepared.job.id)
      const preparationId = current.jobs.find(j => j.id === prepared.job.id).preparationId
      record.preparationId = checkedId(preparationId)
      const validation = await json(`${taskPath()}/model-preparations/${preparationId}/validate`, { requestId: randomUUID() })
      record.validationJobId = checkedId(validation.job.id)
      current = await waitJob(validation.job.id)
      await collect(current)
      record.stage = 'MODEL_VERIFIED'
      if (options.solve) {
        const detail = await json(taskPath())
        const activated = await json(`${taskPath()}/model-preparations/${preparationId}/activate`, { expectedVersion: detail.task.version })
        await json(`${taskPath()}/transitions`, { status: 'READY', expectedVersion: activated.task.version, reason: '验收脚本使用已人工核对的建模配置' })
        const started = await json(`${taskPath()}/runs/baseline`, { projectPath: activated.task.requirementSnapshot.projectPath })
        record.runIdBaseline = checkedId(started.run.id)
        record.attemptId = checkedId(started.attempt.id)
        while (Date.now() < deadline) {
          const results = await json(taskPath())
          const run = results.runs.find(r => r.id === started.run.id)
          if (run && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
            record.baseline = run
            if (run.status !== 'COMPLETED') throw new Error(`Baseline ${run.status}; inspect the recorded Attempt error`)
            const selectedAttempt = run.attempts.find(a => a.id === run.selectedAttemptId)
            if (!selectedAttempt) throw new Error('Completed Baseline has no selected Attempt')
            for (const artifact of selectedAttempt.artifacts) {
              const extension = ['INPUT_PROJECT', 'SOLVED_PROJECT'].includes(artifact.role) ? '.aedt' : '.json'
              const file = `${selectedAttempt.id}-${artifact.role.replace(/[^a-zA-Z0-9_-]/gu, '_')}-${artifact.sha256}${extension}`
              const sizeBytes = await downloadArtifact(`${options.base}${taskPath()}/runs/${checkedId(run.id)}/attempts/${checkedId(selectedAttempt.id)}/artifacts/${artifact.sha256}`, resolve(output, file), artifact.sha256)
              record.artifacts.push({ attemptId: selectedAttempt.id, role: artifact.role, sha256: artifact.sha256, file, sizeBytes })
            }
            record.baselineConverged = selectedAttempt.resultSummary?.converged === true
            record.stage = 'BASELINE_SOLVED_ENGINEERING_REVIEW_REQUIRED'
            break
          }
          await sleep(pollMs)
        }
        if (!record.baseline) { record.stage = 'OBSERVATION_TIMEOUT'; record.liveAttemptId = started.attempt.id; throw new Error(`Observation deadline exceeded; baseline Attempt ${started.attempt.id} may still be running.`) }
      }
    }
    record.finishedAt = new Date().toISOString()
    await persist()
    log(`Evidence: ${recordPath}; ${record.stage}; ${record.evidenceKind}. Engineering and installer acceptance remain pending.`)
    return record
  } catch (error) {
    record.error = { message: error.message, at: new Date().toISOString() }
    if (record.stage !== 'OBSERVATION_TIMEOUT') record.stage = 'FAILED'
    try { await persist() } catch { /* preserve the original error */ }
    throw Object.assign(error, { evidencePath: recordPath })
  }
}

const help = `CAD App acceptance (run after pnpm build):
  node scripts/accept-cad-model.mjs --base http://127.0.0.1:<App-port> --cad <case.step> --version 2024.2 --out <evidence-folder>
  node scripts/accept-cad-model.mjs --base http://127.0.0.1:<App-port> --task <Task-ID> --spec <reviewed-spec.json> --out <evidence-folder> [--solve]
  node scripts/accept-cad-model.mjs --base http://127.0.0.1:<App-port> --task <Task-ID> --observe-job <existing-job-ID> --out <evidence-folder>
The first command only imports and exports a draft for review. --solve explicitly starts one licensed Baseline.
The script records real/test evidence separately; it never declares engineering or installer acceptance complete.`
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseAcceptanceArgs(process.argv.slice(2))
    if (options.help) console.log(help)
    else await runCadAcceptance(options)
  } catch (error) { console.error(`${error.message}${error.evidencePath ? `\nEvidence: ${error.evidencePath}` : ''}`); process.exitCode = 1 }
}
