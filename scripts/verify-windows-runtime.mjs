import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function verifyWindowsRuntime(root = resolve(import.meta.dirname, '..')) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows installer must be assembled on a Windows x64 build machine')
  const paths = {
    node: join(root, 'packaging', 'windows-runtime', 'node', 'node.exe'),
    python: join(root, 'packaging', 'windows-runtime', 'python', 'python.exe'),
    dsh: join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    dshPlugin: join(root, 'plugins', 'dsh-thermal', 'dist', 'index.js'),
    core: join(root, 'apps', 'core', 'dist', 'cli.js'),
    web: join(root, 'apps', 'web', 'dist', 'index.html'),
    icepak: join(root, 'plugins', 'icepak-pyaedt', 'python', 'thermal_icepak_plugin', '__main__.py'),
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
  const pythonCode = 'import ansys.aedt.core, reportlab, pypdf, thermal_icepak_plugin, thermal_report_plugin; print("ok")'
  const pythonPath = [join(root, 'plugins', 'icepak-pyaedt', 'python'), join(root, 'plugins', 'report-reportlab', 'python')].join(';')
  execFileSync(paths.python, ['-c', pythonCode], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, PYTHONPATH: pythonPath },
  })
  return { nodeVersion: version, python: paths.python }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const result = verifyWindowsRuntime()
  process.stdout.write(`Windows runtime verified: Node ${result.nodeVersion}, Python plugins importable.\n`)
}
