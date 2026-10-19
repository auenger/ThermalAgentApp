import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pythonEnvironmentFiles } from '../apps/core/dist/python-environment-files.js'

test('host-only inventory covers extra site hooks and bytecode without executing runtime code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-runtime-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '__pycache__'))
  await writeFile(join(root, 'module.py'), 'VALUE=1\n')
  await writeFile(join(root, '__pycache__', 'module.pyc'), 'compiled fixture')
  const original = await pythonEnvironmentFiles(root)
  await writeFile(join(root, '__pycache__', 'module.pyc'), 'changed! fixture')
  const changed = await pythonEnvironmentFiles(root)
  assert.notEqual(changed, original)
  await writeFile(join(root, 'unexpected.pth'), 'raise RuntimeError("never execute this hook")\n')
  assert.notEqual(await pythonEnvironmentFiles(root), changed)
  const signal = AbortSignal.abort()
  await assert.rejects(pythonEnvironmentFiles(root, signal), error => error.code === 'VALIDATION_DEFERRED')
  if (process.platform !== 'win32') {
    await symlink(tmpdir(), join(root, 'external-directory'))
    await assert.rejects(pythonEnvironmentFiles(root), /External runtime directory/)
  }
})
