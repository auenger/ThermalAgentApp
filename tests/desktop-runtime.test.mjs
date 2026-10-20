import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import sharp from 'sharp'
import { resolveDesktopRuntimePaths, validatePackagedRuntime } from '../apps/desktop/dist/runtime-paths.js'
import { createTrayIconPng } from '../apps/desktop/dist/tray-icon.js'
const { verifyBundle } = createRequire(import.meta.url)('../scripts/verify-electron-bundle.cjs')
const { createPackage } = createRequire(import.meta.url)('@electron/asar')

test('desktop tray icon uses the supplied brand image', async () => {
  const path = resolve('assets/brand/tray.png')
  const png = createTrayIconPng(path)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), 32)
  assert.equal(png.readUInt32BE(20), 32)
  assert.deepEqual(png, await readFile(path))
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let transparent = 0
  let white = 0
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] === 0) transparent++
    if (data[i + 3] > 0 && data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) white++
  }
  assert.ok(transparent > 0 && white > 0, 'tray mark must be white on a transparent background')
  for (const [file, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]]) {
    const metadata = await sharp(resolve('assets/brand', file)).metadata()
    assert.equal(metadata.width, size)
    assert.equal(metadata.height, size)
    assert.equal(metadata.hasAlpha, true)
  }
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
  const macPaths = resolveDesktopRuntimePaths({ appPath, resourcesPath: '/unused', packaged: false, platform: 'darwin' })
  assert.equal(macPaths.trayIconPath, join(macPaths.appRoot, 'assets', 'brand', 'trayTemplate.png'))
})

test('packaged desktop points plain Node and Python at unpacked resources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'Thermal Agent packaged '))
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
  const acceptanceFiles = [
    ...['accept-installed-runtime.mjs', 'verify-windows-runtime.mjs', 'probe-windows-plugin-isolation.mjs'].map(name => join(resources, 'runtime-checks', name)),
    join(resources, 'python', 'Lib', 'venv', '__main__.py'), join(resources, 'python', 'Lib', 'ensurepip', '__main__.py'),
  ]
  const nativeModules = [
    join(unpacked, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'),
    join(unpacked, 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64-0.35.4.node'),
    join(unpacked, 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'),
    join(unpacked, 'node_modules', '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe'),
    join(unpacked, 'node_modules', 'node-addon-require-builtin-win32-x64-msvc', 'prebuilt', 'win32-x64-msvc-napi-v9.node'),
  ]
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  const runtimePackages = Object.keys(manifest.dependencies)
    .filter(name => name.startsWith('@deepseek-ai/'))
    .map(name => join(unpacked, 'node_modules', name, 'package.json'))
  for (const path of [python, dshPlugin, icepakMain, reportMain, paths.sampleProjectPath, paths.windowIconPath, paths.trayIconPath, ...nativeModules, ...runtimePackages, ...acceptanceFiles]) {
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
  const cadRoot = join(unpacked, 'plugins', 'icepak-pyaedt', 'python', 'thermal_icepak_plugin')
  for (const file of ['cad.py', 'model_preparation.py', 'model_validation.py', 'managed.py', 'windows_job.py']) await writeFile(join(cadRoot, file), '')
  const sampleRoot = join(resources, 'cad-samples')
  await mkdir(sampleRoot, { recursive: true })
  const sampleBytes = await readFile(resolve('assets/cad/reference-natural-convection.step'))
  await writeFile(join(sampleRoot, 'reference-natural-convection.step'), sampleBytes)
  await writeFile(join(sampleRoot, 'reference-natural-convection.json'), await readFile(resolve('assets/cad/reference-natural-convection.json')))
  const acceptanceRoot = join(resources, 'cad-acceptance')
  await mkdir(join(acceptanceRoot, 'scripts'), { recursive: true })
  await cp(resolve('scripts/accept-cad-model.mjs'), join(acceptanceRoot, 'scripts', 'accept-cad-model.mjs'))
  await cp(resolve('packages/contracts/dist'), join(acceptanceRoot, 'packages', 'contracts', 'dist'), { recursive: true })
  await cp(resolve('packages/contracts/package.json'), join(acceptanceRoot, 'packages', 'contracts', 'package.json'))
  const archiveInput = join(root, 'archive-input')
  await mkdir(join(archiveInput, 'apps', 'web'), { recursive: true })
  const archivedWeb = join(archiveInput, 'apps', 'web', 'dist')
  await cp(resolve('apps/web/dist'), archivedWeb, { recursive: true })
  await createPackage(archiveInput, join(resources, 'app.asar'))
  assert.throws(() => verifyBundle(root), /offline ensurepip wheel/u)
  const wheel = join(resources, 'python', 'Lib', 'ensurepip', '_bundled', 'pip-25.0.1-py3-none-any.whl')
  await mkdir(join(wheel, '..'), { recursive: true }); await writeFile(wheel, 'fixture wheel; static presence check only')
  assert.doesNotThrow(() => verifyBundle(root))
  const wasm = (await readdir(join(archivedWeb, 'assets'))).find(name => name.endsWith('.wasm'))
  await rm(join(archivedWeb, 'assets', wasm))
  await createPackage(archiveInput, join(resources, 'app.asar'))
  assert.throws(() => verifyBundle(root), /CAD viewer asset missing/u)
  await cp(resolve('apps/web/dist/assets', wasm), join(archivedWeb, 'assets', wasm))
  await createPackage(archiveInput, join(resources, 'app.asar'))
  assert.match(execFileSync(process.execPath, [join(acceptanceRoot, 'scripts', 'accept-cad-model.mjs'), '--help'], { encoding: 'utf8' }), /CAD App acceptance/)
  await writeFile(join(sampleRoot, 'reference-natural-convection.step'), 'corrupt sample')
  assert.throws(() => verifyBundle(root), /CAD sample hash/u)
})
