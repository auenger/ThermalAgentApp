const { existsSync, readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { join } = require('node:path')
const { listPackage, extractFile, uncache } = require('@electron/asar')

function verifyViewerAssets(archivePath) {
  uncache(archivePath)
  const files = listPackage(archivePath).map(p => p.replaceAll('\\', '/'))
  const required = [/\/apps\/web\/dist\/assets\/step\.worker-[\w-]+\.js$/,
    /\/apps\/web\/dist\/assets\/occt-import-js-[\w-]+\.js$/,
    /\/apps\/web\/dist\/assets\/occt-import-js-[\w-]+\.wasm$/,
    /\/apps\/web\/dist\/assets\/license\.occt-[\w-]+\.txt$/,
    /\/apps\/web\/dist\/assets\/license\.occt-import-js-[\w-]+\.txt$/]
  for (const pattern of required) {
    const name = files.find(p => pattern.test(p))
    if (!name || !extractFile(archivePath, name.slice(1)).length) throw new Error(`Packaged CAD viewer asset missing: ${pattern}`)
  }
}

function verifyExcludedWindowsResources(resources) {
  const forbidden = /(?:^|\/)(?:[^/]*(?:darwin|macos)[^/]*|sherpa-onnx[^/]*|dsh-experimental-[^/]*(?:voice|speech-to-text)[^/]*)\/|\.dylib$/iu
  const archive = join(resources, 'app.asar')
  const entries = listPackage(archive).map(path => path.replaceAll('\\', '/'))
  const walk = (directory, prefix = '') => {
    if (!existsSync(directory)) return
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = `${prefix}/${item.name}`
      if (forbidden.test(item.isDirectory() ? path + '/' : path)) throw new Error(`Excluded Windows resource was packaged: ${path}`)
      if (item.isDirectory()) walk(join(directory, item.name), path)
    }
  }
  for (const path of entries) if (forbidden.test(path)) throw new Error(`Excluded Windows resource was packaged: ${path}`)
  walk(join(resources, 'app.asar.unpacked', 'node_modules'))
}

function verifyBundle(appOutDir) {
  const resources = join(appOutDir, 'resources')
  const unpacked = join(resources, 'app.asar.unpacked')
  const required = {
    'Electron application': join(resources, 'app.asar'),
    'bundled Node.js': join(resources, 'node', 'node.exe'),
    'bundled Python': join(resources, 'python', 'python.exe'),
    'Python venv': join(resources, 'python', 'Lib', 'venv', '__main__.py'),
    'Python ensurepip': join(resources, 'python', 'Lib', 'ensurepip', '__main__.py'),
    'installed runtime acceptance': join(resources, 'runtime-checks', 'accept-installed-runtime.mjs'),
    'installed Python verifier': join(resources, 'runtime-checks', 'verify-windows-runtime.mjs'),
    'Windows isolation preflight': join(resources, 'runtime-checks', 'probe-windows-plugin-isolation.mjs'),
    'DSH CLI': join(unpacked, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    'DSH package': join(unpacked, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    'Windows node-pty': join(unpacked, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'),
    'Windows sharp': join(unpacked, 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64-0.35.5.node'),
    'Windows koffi': join(unpacked, 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'),
    'Windows ripgrep': join(unpacked, 'node_modules', '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe'),
    'Windows Node addon': join(unpacked, 'node_modules', 'node-addon-require-builtin-win32-x64-msvc', 'prebuilt', 'win32-x64-msvc-napi-v9.node'),
    'DSH client plugin': join(unpacked, 'plugins', 'dsh-thermal', 'dist', 'client.js'),
    'DSH launcher': join(unpacked, 'plugins', 'dsh-thermal', 'dist', 'launcher.mjs'),
    'DSH plugin manifest': join(unpacked, 'plugins', 'dsh-thermal', 'package.json'),
    'DSH package manager': join(unpacked, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    'DSH thermal plugin': join(unpacked, 'plugins', 'dsh-thermal', 'dist', 'index.js'),
    'Icepak plugin': join(unpacked, 'plugins', 'icepak-pyaedt', 'python', 'thermal_icepak_plugin', '__main__.py'),
    'CAD import module': join(unpacked, 'plugins', 'icepak-pyaedt', 'python', 'thermal_icepak_plugin', 'cad.py'),
    'thermal model builder': join(unpacked, 'plugins', 'icepak-pyaedt', 'python', 'thermal_icepak_plugin', 'model_preparation.py'),
    'thermal model validator': join(unpacked, 'plugins', 'icepak-pyaedt', 'python', 'thermal_icepak_plugin', 'model_validation.py'),
    'managed process lifetime module': join(unpacked, 'plugins', 'icepak-pyaedt', 'python', 'thermal_icepak_plugin', 'managed.py'),
    'Windows job boundary module': join(unpacked, 'plugins', 'icepak-pyaedt', 'python', 'thermal_icepak_plugin', 'windows_job.py'),
    'CAD reference STEP': join(resources, 'cad-samples', 'reference-natural-convection.step'),
    'CAD reference metadata': join(resources, 'cad-samples', 'reference-natural-convection.json'),
    'CAD acceptance script': join(resources, 'cad-acceptance', 'scripts', 'accept-cad-model.mjs'),
    'CAD acceptance contracts': join(resources, 'cad-acceptance', 'packages', 'contracts', 'dist', 'model-preparation.js'),
    'CAD acceptance contract entry': join(resources, 'cad-acceptance', 'packages', 'contracts', 'dist', 'index.js'),
    'CAD acceptance contract package': join(resources, 'cad-acceptance', 'packages', 'contracts', 'package.json'),
    'Icepak sample project': join(resources, 'icepak-sample', 'Project1.aedt'),
    'window icon': join(resources, 'brand', 'app.png'),
    'tray icon': join(resources, 'brand', 'tray.png'),
    'PDF report plugin': join(unpacked, 'plugins', 'report-reportlab', 'python', 'thermal_report_plugin', '__main__.py'),
  }
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
  for (const name of Object.keys(manifest.dependencies).filter(name => name.startsWith('@deepseek-ai/'))) {
    required[`DSH runtime package ${name}`] = join(unpacked, 'node_modules', name, 'package.json')
  }
  const missing = Object.entries(required).filter(([, path]) => !existsSync(path)).map(([name]) => name)
  if (missing.length) throw new Error(`Packaged app is missing required resources: ${missing.join(', ')}`)
  const pipWheels = join(resources, 'python', 'Lib', 'ensurepip', '_bundled')
  if (!existsSync(pipWheels) || !readdirSync(pipWheels).some(name => /^pip-[\w.]+-py3-none-any\.whl$/u.test(name))) throw new Error('Packaged Python is missing the offline ensurepip wheel')
  const metadata = JSON.parse(readFileSync(required['CAD reference metadata'], 'utf8'))
  const actual = createHash('sha256').update(readFileSync(required['CAD reference STEP'])).digest('hex')
  if (metadata.sha256 !== actual || metadata.cadKernelRoundtrip?.passed !== true) throw new Error('Packaged CAD sample hash or geometry roundtrip metadata is invalid')
  verifyViewerAssets(required['Electron application'])
  verifyExcludedWindowsResources(resources)
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  // DSH's plugin catalogue reads this unpacked manifest through plain Node.
  // Do not advertise a shipped voice bundle after removing its files.
  const dshManifest = join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const metadata = JSON.parse(readFileSync(dshManifest, 'utf8'))
  delete metadata.dependencies['@deepseek-ai/dsh-experimental-voice-input-bundle']
  writeFileSync(dshManifest, JSON.stringify(metadata, null, 2) + '\n')
  verifyBundle(context.appOutDir)
  if (process.platform !== 'win32') {
    console.warn('Cross-build: Windows Node/Python execution checks are deferred to a Windows host.')
    return
  }
  const resources = join(context.appOutDir, 'resources')
  const unpacked = join(resources, 'app.asar.unpacked')
  const node = join(resources, 'node', 'node.exe')
  const dsh = join(unpacked, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  execFileSync(node, ['--check', dsh], { timeout: 10_000, stdio: 'pipe' })
  const dshVersion = execFileSync(node, [dsh, '--version'], {
    encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (dshVersion !== JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']) throw new Error(`Packaged DSH version is unsupported: ${dshVersion}`)
  const { verifyOfflinePython } = await import('./verify-windows-runtime.mjs')
  const pythonInfo = verifyOfflinePython(join(resources, 'python', 'python.exe'), join(resources, 'python'),
    join(unpacked, 'plugins', 'icepak-pyaedt', 'python'),
    join(unpacked, 'plugins', 'report-reportlab', 'python'))
  if (pythonInfo.platform !== 'win32' || pythonInfo.bits !== 64) {
    throw new Error(`Packaged Python must be Windows x64; found ${pythonInfo.platform} ${pythonInfo.bits}-bit`)
  }
}
exports.verifyBundle = verifyBundle
exports.verifyViewerAssets = verifyViewerAssets
