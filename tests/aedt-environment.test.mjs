import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectAedtEnvironment } from '../apps/core/dist/aedt-environment.js'

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
