import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { IcepakPluginClient } from '../apps/core/dist/icepak-plugin-client.js'
import { pythonPluginArgs, pythonPluginEnv } from '../apps/core/dist/python-plugin-launch.js'

test('Python plugin launcher ignores a conflicting host PYTHONPATH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-python-plugin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bundled = join(root, 'bundled')
  const external = join(root, 'external')
  for (const [path, marker] of [[bundled, 'bundled'], [external, 'external']]) {
    await mkdir(join(path, 'testplugin'), { recursive: true })
    await writeFile(join(path, 'testplugin', '__init__.py'), '')
    await writeFile(join(path, 'testplugin', '__main__.py'), `print('${marker}')\n`)
  }
  const args = pythonPluginArgs(bundled, 'testplugin')
  assert.equal(args[0], '-I')
  const output = execFileSync('python3', args, {
    encoding: 'utf8', env: { ...pythonPluginEnv(), PYTHONPATH: external },
  }).trim()
  assert.equal(output, 'bundled')

  const client = new IcepakPluginClient({ python: 'python3', pluginRoot: resolve('plugins/icepak-pyaedt/python') })
  const health = await client.health()
  assert.equal(health.pluginId, 'icepak-pyaedt')
})
