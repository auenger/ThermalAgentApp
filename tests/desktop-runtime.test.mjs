import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { resolveDesktopRuntimePaths, validatePackagedRuntime } from '../apps/desktop/dist/runtime-paths.js'
import { createTrayIconPng } from '../apps/desktop/dist/tray-icon.js'
const { verifyBundle } = createRequire(import.meta.url)('../scripts/verify-electron-bundle.cjs')

test('desktop tray icon uses the supplied brand image', async () => {
  const path = resolve('assets/brand/tray.png')
  const png = createTrayIconPng(path)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), 32)
  assert.equal(png.readUInt32BE(20), 32)
  assert.deepEqual(png, await readFile(path))
})

test('desktop development paths resolve from the workspace instead of process cwd', () => {
  const appPath = resolve('/workspace/ThermalAgentApp/apps/desktop')
  const paths = resolveDesktopRuntimePaths({
    appPath, resourcesPath: '/unused', packaged: false, platform: 'win32', nodeOverride: 'C:\\node\\node.exe',
  })
  assert.equal(paths.appRoot, resolve('/workspace/ThermalAgentApp'))
  assert.equal(paths.coreEntry, join(paths.appRoot, 'apps', 'core', 'dist', 'cli.js'))
  assert.equal(paths.nodeBin, 'C:\\node\\node.exe')
  assert.equal(paths.sampleProjectPath, join(paths.appRoot, 'assets', 'icepak', 'Project1.aedt'))
  assert.equal(paths.trayIconPath, join(paths.appRoot, 'assets', 'brand', 'tray.png'))
})

test('packaged desktop points plain Node and Python at unpacked resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'thermal-agent-packaged-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const resources = join(root, 'resources')
  const unpacked = join(resources, 'app.asar.unpacked')
  const dshCli = join(unpacked, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const dshPackage = join(unpacked, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const nodeBin = join(resources, 'node', 'node.exe')
  await mkdir(join(dshCli, '..'), { recursive: true })
  await mkdir(join(nodeBin, '..'), { recursive: true })
  await writeFile(dshCli, '')
  await writeFile(dshPackage, '')
  await writeFile(nodeBin, '')

  const paths = resolveDesktopRuntimePaths({
    appPath: join(resources, 'app.asar'), resourcesPath: resources, packaged: true, platform: 'win32',
  })
  assert.equal(paths.dshCli, dshCli)
  assert.equal(paths.nodeBin, nodeBin)
  assert.equal(paths.icepakPython, undefined)
  assert.equal(paths.icepakPluginRoot, join(unpacked, 'plugins', 'icepak-pyaedt', 'python'))
  assert.equal(paths.reportPluginRoot, join(unpacked, 'plugins', 'report-reportlab', 'python'))
  assert.equal(paths.dshPlugin, join(unpacked, 'plugins', 'dsh-thermal', 'dist', 'index.js'))
  assert.equal(paths.workingDirectory, resources)
  assert.equal(paths.sampleProjectPath, join(resources, 'icepak-sample', 'Project1.aedt'))
  assert.equal(paths.windowIconPath, join(resources, 'brand', 'app.png'))
  assert.match(paths.coreEntry, /app\.asar[/\\]apps[/\\]core[/\\]dist[/\\]cli\.js$/u)
  assert.throws(() => validatePackagedRuntime(paths), /Python.*DSH thermal plugin.*Icepak plugin.*Icepak sample project.*window icon.*tray icon.*PDF report plugin/u)

  const python = join(resources, 'python', 'python.exe')
  const dshPlugin = paths.dshPlugin
  const icepakMain = join(paths.icepakPluginRoot, 'thermal_icepak_plugin', '__main__.py')
  const reportMain = join(paths.reportPluginRoot, 'thermal_report_plugin', '__main__.py')
  for (const path of [python, dshPlugin, icepakMain, reportMain, paths.sampleProjectPath, paths.windowIconPath, paths.trayIconPath]) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '')
  }
  const complete = resolveDesktopRuntimePaths({
    appPath: join(resources, 'app.asar'), resourcesPath: resources, packaged: true, platform: 'win32',
  })
  assert.equal(complete.icepakPython, python)
  assert.doesNotThrow(() => validatePackagedRuntime(complete))
  assert.throws(() => verifyBundle(root), /Electron application/u)
  await writeFile(join(resources, 'app.asar'), '')
  assert.doesNotThrow(() => verifyBundle(root))
})
