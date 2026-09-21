const { existsSync } = require('node:fs')
const { join } = require('node:path')

function verifyBundle(appOutDir) {
  const resources = join(appOutDir, 'resources')
  const unpacked = join(resources, 'app.asar.unpacked')
  const required = {
    'Electron application': join(resources, 'app.asar'),
    'bundled Node.js': join(resources, 'node', 'node.exe'),
    'bundled Python': join(resources, 'python', 'python.exe'),
    'DSH CLI': join(unpacked, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    'DSH thermal plugin': join(unpacked, 'plugins', 'dsh-thermal', 'dist', 'index.js'),
    'Icepak plugin': join(unpacked, 'plugins', 'icepak-pyaedt', 'python', 'thermal_icepak_plugin', '__main__.py'),
    'PDF report plugin': join(unpacked, 'plugins', 'report-reportlab', 'python', 'thermal_report_plugin', '__main__.py'),
  }
  const missing = Object.entries(required).filter(([, path]) => !existsSync(path)).map(([name]) => name)
  if (missing.length) throw new Error(`Packaged app is missing required resources: ${missing.join(', ')}`)
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') verifyBundle(context.appOutDir)
}
exports.verifyBundle = verifyBundle
