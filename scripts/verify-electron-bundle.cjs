const { existsSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

function verifyBundle(appOutDir) {
  const resources = join(appOutDir, 'resources')
  const unpacked = join(resources, 'app.asar.unpacked')
  const required = {
    'Electron application': join(resources, 'app.asar'),
    'bundled Node.js': join(resources, 'node', 'node.exe'),
    'bundled Python': join(resources, 'python', 'python.exe'),
    'DSH CLI': join(unpacked, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    'DSH package': join(unpacked, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    'DSH thermal plugin': join(unpacked, 'plugins', 'dsh-thermal', 'dist', 'index.js'),
    'Icepak plugin': join(unpacked, 'plugins', 'icepak-pyaedt', 'python', 'thermal_icepak_plugin', '__main__.py'),
    'Icepak sample project': join(resources, 'icepak-sample', 'Project1.aedt'),
    'window icon': join(resources, 'brand', 'app.png'),
    'tray icon': join(resources, 'brand', 'tray.png'),
    'PDF report plugin': join(unpacked, 'plugins', 'report-reportlab', 'python', 'thermal_report_plugin', '__main__.py'),
  }
  const missing = Object.entries(required).filter(([, path]) => !existsSync(path)).map(([name]) => name)
  if (missing.length) throw new Error(`Packaged app is missing required resources: ${missing.join(', ')}`)
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  verifyBundle(context.appOutDir)
  const resources = join(context.appOutDir, 'resources')
  const unpacked = join(resources, 'app.asar.unpacked')
  const node = join(resources, 'node', 'node.exe')
  const dsh = join(unpacked, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  execFileSync(node, ['--check', dsh], { timeout: 10_000, stdio: 'pipe' })
  const dshVersion = execFileSync(node, [dsh, '--version'], {
    encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (dshVersion !== '0.1.5-rc.2') throw new Error(`Packaged DSH version is unsupported: ${dshVersion}`)
  const { verifyOfflinePython } = await import('./verify-windows-runtime.mjs')
  const pythonInfo = verifyOfflinePython(join(resources, 'python', 'python.exe'), join(resources, 'python'),
    join(unpacked, 'plugins', 'icepak-pyaedt', 'python'),
    join(unpacked, 'plugins', 'report-reportlab', 'python'))
  if (pythonInfo.platform !== 'win32' || pythonInfo.bits !== 64) {
    throw new Error(`Packaged Python must be Windows x64; found ${pythonInfo.platform} ${pythonInfo.bits}-bit`)
  }
}
exports.verifyBundle = verifyBundle
