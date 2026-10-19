import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { inspectInstalledRuntime } from '../scripts/accept-installed-runtime.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'thermal-installed-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of ['node/node.exe', 'python/python.exe', 'app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ...['accept-installed-runtime.mjs', 'verify-windows-runtime.mjs', 'probe-windows-plugin-isolation.mjs'].map(name => 'runtime-checks/' + name)]) {
    await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), 'fixture, not executable')
  }
  const calls = [], published = []
  return { root, calls, published, options: { resources: root, platform: 'win32', arch: 'x64',
    run(executable, args, options) { calls.push({ executable, args, options }); return args.length === 1 ? 'v22.22.0\n' : '0.1.5-rc.2\n' },
    pythonProbe(...args) { calls.push({ python: args }); return { platform: 'win32', bits: 64, isolatedEnvironments: true, python: '3.12.10' } },
    publish: report => published.push(report) } }
}

test('installed acceptance checks only bundled paths and labels injected checks as simulated', async t => {
  const f = await fixture(t), report = inspectInstalledRuntime(f.options)
  assert.equal(report.status, 'passed'); assert.equal(report.execution, 'simulated')
  assert.equal(report.checks.length, 4)
  assert.equal(f.calls[0].executable, join(f.root, 'node/node.exe'))
  assert.equal(f.calls[1].args[0], join(f.root, 'app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js'))
  assert.deepEqual(f.calls[2].python, [join(f.root, 'python/python.exe'), join(f.root, 'python'),
    join(f.root, 'app.asar.unpacked/plugins/icepak-pyaedt/python'), join(f.root, 'app.asar.unpacked/plugins/report-reportlab/python')])
  assert.equal(f.published[0].status, 'running'); assert.equal(f.published[0].checks.length, 0)
  assert.equal(f.published.at(-1).status, 'passed')
})

test('DSH failure does not hide Python failures or produce a passing report', async t => {
  const f = await fixture(t)
  f.options.run = (_file, args) => { if (args.length > 1) throw new Error('missing DSH dependency'); return 'v22.22.0' }
  f.options.pythonProbe = () => { throw new Error('venv creation failed') }
  const report = inspectInstalledRuntime(f.options)
  assert.equal(report.status, 'failed')
  assert.deepEqual(report.checks.filter(item => !item.passed).map(item => item.name), ['bundled-dsh', 'python-imports-and-independent-environment'])
})

test('wrong runtime identities and missing installed tools fail acceptance', async t => {
  const f = await fixture(t)
  f.options.run = (_file, args) => args.length === 1 ? 'v20.1.0' : '0.0.1'
  f.options.pythonProbe = () => ({ platform: 'win32', bits: 32, isolatedEnvironments: false })
  await rm(join(f.root, 'runtime-checks/probe-windows-plugin-isolation.mjs'))
  const report = inspectInstalledRuntime(f.options)
  assert.equal(report.status, 'failed'); assert.ok(report.checks.every(item => !item.passed))
})

test('unsupported platform never executes Windows tools and CLI retains native unsupported evidence', async t => {
  const f = await fixture(t)
  const report = inspectInstalledRuntime({ ...f.options, platform: 'darwin' })
  assert.equal(report.status, 'unsupported'); assert.equal(f.calls.length, 0)
  if (process.platform === 'win32') return
  const output = join(f.root, 'report.json')
  const cli = spawnSync(process.execPath, [resolve('scripts/accept-installed-runtime.mjs'), '--output', output], { encoding: 'utf8' })
  assert.equal(cli.status, 2, cli.stderr)
  const saved = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(saved.execution, 'native'); assert.equal(saved.status, 'unsupported')
  assert.ok(saved.finishedAt)
})
