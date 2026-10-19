import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectPythonRuntime } from '../apps/core/dist/python-environment.js'

test('environment facts include actual dependency bytes and distinguish same-version edits and missing packages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-environment-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const python = process.platform === 'win32' ? 'python' : 'python3'
  execFileSync(python, ['-m', 'venv', '--without-pip', root])
  const executable = join(root, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const site = execFileSync(executable, ['-I', '-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], { encoding: 'utf8' }).trim()
  const info = join(site, 'thermal_fixture-1.0.dist-info')
  await mkdir(info, { recursive: true })
  await writeFile(join(info, 'METADATA'), 'Metadata-Version: 2.1\nName: thermal-fixture\nVersion: 1.0\n')
  await writeFile(join(info, 'RECORD'), 'thermal_fixture.py,,\nthermal_fixture-1.0.dist-info/METADATA,,\nthermal_fixture-1.0.dist-info/RECORD,,\n')
  await writeFile(join(site, 'thermal_fixture.py'), 'VALUE=1\n')
  const first = await inspectPythonRuntime(executable, ['thermal-fixture', 'thermal-nonexistent-fixture'])
  assert.equal(first.environment.versions['thermal-fixture'], '1.0')
  assert.equal(first.environment.versions['thermal-nonexistent-fixture'], 'missing')
  assert.equal(first.environment.platform, process.platform)
  assert.equal(first.executable, join(await realpath(dirname(executable)), basename(executable)))
  assert.equal(execFileSync(first.executable, ['-I', '-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], { encoding: 'utf8' }).trim(), site)
  assert.match(first.environment.versions['python-executable'], /^[a-f0-9]{64}$/)
  await writeFile(join(site, 'thermal_fixture.py'), 'VALUE=2\n')
  const second = await inspectPythonRuntime(executable, ['thermal-fixture', 'thermal-nonexistent-fixture'])
  assert.equal(second.environment.versions['thermal-fixture'], '1.0')
  assert.notEqual(second.environment.versions['python-dependencies'], first.environment.versions['python-dependencies'])
  await rm(join(site, 'thermal_fixture.py'))
  await assert.rejects(inspectPythonRuntime(executable, ['thermal-fixture']), /file is missing/)
})
