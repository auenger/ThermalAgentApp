import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { resolveDesktopRuntimePaths } from '../apps/desktop/dist/runtime-paths.js'

test('desktop development paths resolve from the workspace instead of process cwd', () => {
  const appPath = resolve('/workspace/ThermalAgentApp/apps/desktop')
  const paths = resolveDesktopRuntimePaths({
    appPath, resourcesPath: '/unused', packaged: false, platform: 'win32', nodeOverride: 'C:\\node\\node.exe',
  })
  assert.equal(paths.appRoot, resolve('/workspace/ThermalAgentApp'))
  assert.equal(paths.coreEntry, join(paths.appRoot, 'apps', 'core', 'dist', 'cli.js'))
  assert.equal(paths.nodeBin, 'C:\\node\\node.exe')
})

test('packaged desktop points plain Node and Python at unpacked resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-agent-packaged-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resources = join(root, 'resources')
  const unpacked = join(resources, 'app.asar.unpacked')
  const dshCli = join(unpacked, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const nodeBin = join(resources, 'node', 'node.exe')
  await mkdir(join(dshCli, '..'), { recursive: true })
  await mkdir(join(nodeBin, '..'), { recursive: true })
  await writeFile(dshCli, '')
  await writeFile(nodeBin, '')

  const paths = resolveDesktopRuntimePaths({
    appPath: join(resources, 'app.asar'), resourcesPath: resources, packaged: true, platform: 'win32',
  })
  assert.equal(paths.dshCli, dshCli)
  assert.equal(paths.nodeBin, nodeBin)
  assert.equal(paths.icepakPluginRoot, join(unpacked, 'plugins', 'icepak-pyaedt', 'python'))
  assert.equal(paths.reportPluginRoot, join(unpacked, 'plugins', 'report-reportlab', 'python'))
  assert.equal(paths.dshPlugin, join(unpacked, 'plugins', 'dsh-thermal', 'dist', 'index.js'))
  assert.match(paths.coreEntry, /app\.asar[/\\]apps[/\\]core[/\\]dist[/\\]cli\.js$/u)
})
