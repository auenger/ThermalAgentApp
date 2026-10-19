import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ReportClient } from './report-client.js'
import { pythonPluginEnv } from './python-plugin-launch.js'

/** Host-owned fixture and independent PDF reader, never a candidate-supplied pass/fail response. */
export async function validateReportRelease(client: ReportClient, python: string, home: string) {
  const directory = await realpath(await mkdtemp(join(home, 'report-validation-')))
  try {
    const outputPath = join(directory, 'fixture.pdf')
    const input = { outputPath, generatedAt: '2026-01-01T00:00:00.000Z',
      task: { id: 'HOST-FIXTURE-4719', title: '报告兼容性 HOST-REPORT-4719', executionStatus: 'COMPLETED',
        approvalStatus: 'APPROVED', thermalVerdict: 'FAIL', requirementSnapshot: { targetTmaxC: 80 } },
      runs: [], events: [] }
    const result = await client.renderTaskReport(input)
    const stat = await lstat(outputPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid report fixture output')
    const bytes = await readFile(outputPath)
    if (result.outputPath !== outputPath || result.sizeBytes !== bytes.length || result.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Report fixture artifact metadata mismatch')
    const { stdout } = await promisify(execFile)(python, ['-I', '-B', '-c',
      'import json,sys\nfrom pypdf import PdfReader\nr=PdfReader(sys.argv[1])\nprint(json.dumps({"pages":len(r.pages),"text":"\\n".join(p.extract_text() or "" for p in r.pages)}))', outputPath],
    { env: pythonPluginEnv(), timeout: 15_000, maxBuffer: 2_000_000, windowsHide: true })
    const readback = JSON.parse(stdout) as { pages: number; text: string }
    if (readback.pages < 1 || readback.pages !== result.pageCount || !['HOST-FIXTURE-4719', 'HOST-REPORT-4719', '报告兼容性', 'Fail'].every(text => readback.text.includes(text))) throw new Error('Report fixture content readback failed')
    let rejected = false
    try { await client.renderTaskReport({ ...input, outputPath: join(directory, 'unapproved.pdf'), task: { ...input.task, approvalStatus: 'PENDING' } }) }
    catch { rejected = true }
    if (!rejected) throw new Error('Report plugin accepted an unapproved task')
    return [{ name: 'report-fixture-readback', passed: true, detail: 'Host PDF readback verified task identity, Chinese title, FAIL verdict, page count and artifact hash; unapproved task rejected' }]
  } finally { await rm(directory, { recursive: true, force: true }) }
}
