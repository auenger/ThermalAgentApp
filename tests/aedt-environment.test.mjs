import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectAedtEnvironment, aedtLaunchBindings } from '../apps/core/dist/aedt-environment.js'
import { icepakPluginEnvironment } from '../apps/core/dist/icepak-plugin-client.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'thermal-aedt-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const install = join(root, 'custom'), programFiles = join(root, 'Program Files')
  await mkdir(install); await mkdir(programFiles)
  await writeFile(join(install, 'ansysedt.exe'), 'fixture executable bytes')
  await writeFile(join(install, 'solver.dll'), 'fixture DLL bytes')
  return { root, install, environment: { ProgramFiles: programFiles, ANSYSEM_ROOT242: install } }
}

test('AEDT identity changes with same-version binaries, native libraries, installation paths and missing roots', async t => {
  const f = await fixture(t)
  const original = await inspectAedtEnvironment('win32', f.environment)
  assert.equal(original.installations[0].status, 'present')
  assert.equal(original.installations[0].files.length, 2)
  assert.equal((await inspectAedtEnvironment('win32', f.environment)).digest, original.digest)
  await writeFile(join(f.install, 'project.aedt'), 'user project'); await writeFile(join(f.install, 'session.log'), 'log')
  assert.equal((await inspectAedtEnvironment('win32', f.environment)).digest, original.digest)
  await writeFile(join(f.install, 'solver.dll'), 'changed DLL bytes')
  const dll = await inspectAedtEnvironment('win32', f.environment)
  assert.notEqual(dll.digest, original.digest)
  await writeFile(join(f.install, 'ansysedt.exe'), 'changed executable bytes')
  assert.notEqual((await inspectAedtEnvironment('win32', f.environment)).digest, dll.digest)
  const missing = await inspectAedtEnvironment('win32', { ...f.environment, ANSYSEM_ROOT242: join(f.root, 'missing') })
  assert.equal(missing.installations[0].status, 'missing')
  assert.notEqual(missing.digest, original.digest)
  assert.notEqual((await inspectAedtEnvironment('win32', { ProgramFiles: f.environment.ProgramFiles })).digest, missing.digest)
  assert.equal((await inspectAedtEnvironment('darwin', f.environment)).installations.length, 0)
})

test('host inventories legacy, modern and client/student environment roots deterministically', async t => {
  const f = await fixture(t)
  for (const path of [join(f.environment.ProgramFiles, 'AnsysEM', 'v251', 'Win64'), join(f.environment.ProgramFiles, 'ANSYS Inc', 'v252', 'AnsysEM')]) {
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'ansysedt.exe'), 'fixture')
  }
  const environment = { ...f.environment, ansysemsv_root261: f.install, ANSYSEM_PY_CLIENT_ROOT261: f.install }
  const result = await inspectAedtEnvironment('win32', environment)
  assert.equal(result.installations.length, 5)
  assert.equal(result.installations.every(item => item.status === 'present'), true)
  assert.equal((await inspectAedtEnvironment('win32', Object.fromEntries(Object.entries(environment).reverse()))).digest, result.digest)
})

test('incomplete inventory fails closed on budgets, relative roots and linked runtime files', async t => {
  const f = await fixture(t)
  await assert.rejects(inspectAedtEnvironment('win32', f.environment, { maxFiles: 1, maxBytes: 1024, timeoutMs: 1000 }), /budget/)
  await assert.rejects(inspectAedtEnvironment('win32', f.environment, { maxFiles: 10, maxBytes: 1, timeoutMs: 1000 }), /budget/)
  await assert.rejects(inspectAedtEnvironment('win32', f.environment, { maxFiles: 10, maxBytes: 1024, timeoutMs: -1 }), /timed out/)
  await assert.rejects(inspectAedtEnvironment('win32', { ...f.environment, ANSYSEM_ROOT242: 'relative' }), /absolute/)
  if (process.platform !== 'win32') {
    await symlink(join(f.install, 'solver.dll'), join(f.install, 'linked.dll'))
    await assert.rejects(inspectAedtEnvironment('win32', f.environment), /non-regular/)
  }
})

test('missing and broken AEDT variables bind to a unique inventoried executable and respect update policy', async t => {
  const f = await fixture(t)
  const modern = join(f.environment.ProgramFiles, 'ANSYS Inc', 'v261', 'AnsysEM')
  const legacy = join(f.environment.ProgramFiles, 'AnsysEM', 'v252', 'Win64')
  for (const path of [modern, legacy]) { await mkdir(path, { recursive: true }); await writeFile(join(path, 'ansysedt.exe'), 'fixture') }
  const env = { ProgramFiles: f.environment.ProgramFiles, ANSYSEM_ROOT261: join(f.root, 'removed') }
  const evidence = await inspectAedtEnvironment('win32', env)
  const original = aedtLaunchBindings(evidence, false), repaired = aedtLaunchBindings(evidence, true)
  assert.equal(original.environment.ANSYSEM_ROOT261, env.ANSYSEM_ROOT261)
  assert.equal(original.environment.ANSYSEM_ROOT252, undefined)
  assert.equal(repaired.environment.ANSYSEM_ROOT261, await realpath(modern))
  assert.equal(repaired.environment.ANSYSEM_ROOT252, await realpath(legacy))
  assert.equal(repaired.repairs.length, 2)
  assert.equal(repaired.repairs.find(item => item.variable === 'ANSYSEM_ROOT261').previous, env.ANSYSEM_ROOT261)
  assert.notEqual(repaired.digest, original.digest)
  assert.deepEqual(aedtLaunchBindings(await inspectAedtEnvironment('win32', env), true), repaired)
  assert.equal(env.ANSYSEM_ROOT261, join(f.root, 'removed'))
})

test('ambiguous, empty and student-only installations do not invent commercial bindings; valid explicit paths win', async t => {
  const f = await fixture(t)
  for (const path of [join(f.environment.ProgramFiles, 'AnsysEM', 'v242'), join(f.environment.ProgramFiles, 'ANSYS Inc', 'v242', 'AnsysEM')]) {
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'ansysedt.exe'), 'fixture')
  }
  await mkdir(join(f.environment.ProgramFiles, 'AnsysEM', 'v261'), { recursive: true })
  const evidence = await inspectAedtEnvironment('win32', { ProgramFiles: f.environment.ProgramFiles, ANSYSEMSV_ROOT252: f.install })
  const ambiguous = aedtLaunchBindings(evidence, true)
  assert.equal(ambiguous.environment.ANSYSEM_ROOT242, undefined)
  assert.equal(ambiguous.environment.ANSYSEM_ROOT261, undefined)
  assert.equal(ambiguous.environment.ANSYSEM_ROOT252, undefined)
  assert.equal(ambiguous.environment.ANSYSEMSV_ROOT252, f.install)
  assert.match(ambiguous.diagnostics[0], /multiple installation paths/)
  const explicit = aedtLaunchBindings(await inspectAedtEnvironment('win32', f.environment), true)
  assert.equal(explicit.environment.ANSYSEM_ROOT242, f.install)
  assert.equal(explicit.repairs.length, 0)
  assert.equal(explicit.diagnostics.length, 0)
})

test('plugin launch captures AEDT roots without mutating machine settings or admitting arbitrary overrides', t => {
  const key = 'ANSYSEM_ROOT999', previous = process.env[key]
  process.env[key] = join(tmpdir(), 'late-change')
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  const environment = icepakPluginEnvironment({ ANSYSEM_ROOT261: join(tmpdir(), 'captured') })
  assert.equal(environment[key], undefined)
  assert.equal(environment.ANSYSEM_ROOT261, join(tmpdir(), 'captured'))
  assert.equal(process.env[key], join(tmpdir(), 'late-change'))
  assert.equal(environment.PYTHONPATH, '')
  assert.equal(icepakPluginEnvironment()[key], process.env[key], 'unmanaged callers keep their normal environment')
  assert.throws(() => icepakPluginEnvironment({ PYTHONPATH: '/untrusted' }), /Invalid host/)
  assert.throws(() => icepakPluginEnvironment({ ANSYSEM_ROOT261: 'relative' }), /Invalid host/)
})
