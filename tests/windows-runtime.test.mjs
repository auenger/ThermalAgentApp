import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OFFLINE_PYTHON_PROBE } from '../scripts/verify-windows-runtime.mjs'

test('offline Python probe accepts bundled dependencies and rejects system-package fallback', async t => {
  const python = process.env.THERMAL_TEST_PYTHON ?? join(process.cwd(), 'plugins', 'report-reportlab', '.venv', 'bin', 'python')
  let version
  try { version = execFileSync(python, ['-c', 'import sys; print(sys.version_info.major, sys.version_info.minor)'], { encoding: 'utf8' }).trim() }
  catch { t.skip('Python test runtime is unavailable'); return }
  if (Number(version.split(' ')[0]) < 3 || Number(version.split(' ')[1]) < 10) { t.skip('Python 3.10+ is unavailable'); return }
  const root = await mkdtemp(join(tmpdir(), 'thermal-offline-python-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = join(root, 'runtime')
  const bundled = join(runtime, 'Lib', 'site-packages')
  const external = join(root, 'system-packages')
  const icepak = join(root, 'icepak')
  const report = join(root, 'report')
  for (const path of [join(bundled, 'ansys', 'aedt', 'core'), join(bundled, 'reportlab'),
    join(bundled, 'pypdf'), join(external, 'reportlab'), join(icepak, 'thermal_icepak_plugin'),
    join(report, 'thermal_report_plugin')]) {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, '__init__.py'), '')
  }
  const run = (sitePaths, env = {}) => execFileSync(python, ['-I', '-c',
    `import sys; sys.path[0:0] = ${JSON.stringify(sitePaths)}; sys.argv.pop(1); exec(${JSON.stringify(OFFLINE_PYTHON_PROBE)})`,
    'wrapper', runtime, icepak, report], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONPATH: external, ...env } })
  const accepted = JSON.parse(run([bundled]).trim())
  assert.equal(accepted.runtime, await realpath(runtime))
  assert.throws(() => run([external, bundled]), /loaded outside bundled Python runtime/u)
})
