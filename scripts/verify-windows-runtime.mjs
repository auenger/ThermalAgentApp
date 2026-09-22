import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const OFFLINE_PYTHON_PROBE = `
import importlib
import json
import pathlib
import struct
import sys

if sys.version_info < (3, 10):
    raise RuntimeError('Bundled Python 3.10 or newer is required')
runtime = pathlib.Path(sys.argv[1]).resolve()
for plugin_root in sys.argv[2:4]:
    sys.path.insert(0, str(pathlib.Path(plugin_root).resolve()))
for name in ('ansys.aedt.core', 'reportlab', 'pypdf'):
    module = importlib.import_module(name)
    origin = pathlib.Path(module.__file__).resolve()
    if not origin.is_relative_to(runtime):
        raise RuntimeError(f'{name} loaded outside bundled Python runtime: {origin}')
for name in ('thermal_icepak_plugin', 'thermal_report_plugin'):
    importlib.import_module(name)
print(json.dumps({'python': sys.version.split()[0], 'runtime': str(runtime), 'platform': sys.platform, 'bits': struct.calcsize('P') * 8}))
`

export function verifyOfflinePython(python, runtimeRoot, icepakRoot, reportRoot) {
  const output = execFileSync(python, ['-I', '-c', OFFLINE_PYTHON_PROBE, runtimeRoot, icepakRoot, reportRoot], {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONPATH: '' },
  })
  return JSON.parse(output.trim().split(/\r?\n/u).at(-1))
}

export function verifyWindowsRuntime(root = resolve(import.meta.dirname, '..')) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows installer must be assembled on a Windows x64 build machine')
  const paths = {
    node: join(root, 'packaging', 'windows-runtime', 'node', 'node.exe'),
    python: join(root, 'packaging', 'windows-runtime', 'python', 'python.exe'),
    dsh: join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    dshPackage: join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    dshPlugin: join(root, 'plugins', 'dsh-thermal', 'dist', 'index.js'),
    core: join(root, 'apps', 'core', 'dist', 'cli.js'),
    web: join(root, 'apps', 'web', 'dist', 'index.html'),
    icepak: join(root, 'plugins', 'icepak-pyaedt', 'python', 'thermal_icepak_plugin', '__main__.py'),
    sampleProject: join(root, 'assets', 'icepak', 'Project1.aedt'),
    windowIcon: join(root, 'assets', 'brand', 'app.png'),
    trayIcon: join(root, 'assets', 'brand', 'tray.png'),
    installerIcon: join(root, 'assets', 'brand', 'app.ico'),
    report: join(root, 'plugins', 'report-reportlab', 'python', 'thermal_report_plugin', '__main__.py'),
  }
  const missing = Object.entries(paths).filter(([, path]) => !existsSync(path)).map(([name]) => name)
  if (missing.length) throw new Error(`Windows package resources are missing: ${missing.join(', ')}`)

  const version = execFileSync(paths.node, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(version)
  const major = Number(match?.[1])
  const minor = Number(match?.[2])
  if (!match || !(major === 22 && minor >= 22 || major >= 24)) {
    throw new Error(`Bundled Node.js ${version} is unsupported; use Node 22.22.x or newer compatible runtime`)
  }
  execFileSync(paths.node, ['--check', paths.dsh], { timeout: 10_000, stdio: 'pipe' })
  const dshVersion = execFileSync(paths.node, [paths.dsh, '--version'], {
    encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (dshVersion !== '0.1.5-rc.2') throw new Error(`Bundled DSH version is unsupported: ${dshVersion}`)
  execFileSync(paths.node, [join(root, 'scripts', 'smoke-dsh-agent-tools.mjs')], {
    cwd: root, timeout: 60_000, stdio: 'pipe',
  })
  const pythonInfo = verifyOfflinePython(paths.python,
    join(root, 'packaging', 'windows-runtime', 'python'),
    join(root, 'plugins', 'icepak-pyaedt', 'python'),
    join(root, 'plugins', 'report-reportlab', 'python'))
  if (pythonInfo.platform !== 'win32' || pythonInfo.bits !== 64) {
    throw new Error(`Bundled Python must be Windows x64; found ${pythonInfo.platform} ${pythonInfo.bits}-bit`)
  }
  return { nodeVersion: version, dshVersion, python: paths.python, pythonInfo }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const result = verifyWindowsRuntime()
  process.stdout.write(`Windows runtime verified: Node ${result.nodeVersion}, Python plugins importable.\n`)
}
