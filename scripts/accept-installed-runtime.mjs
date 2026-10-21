import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyOfflinePython } from './verify-windows-runtime.mjs'

const source = fileURLToPath(import.meta.url)
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Fixed installed-runtime checks. No model requests, network installs, candidate execution or AEDT launch. */
export function inspectInstalledRuntime(options = {}) {
  const resources = resolve(options.resources ?? join(dirname(source), '..'))
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch
  const run = options.run ?? execFileSync, pythonProbe = options.pythonProbe ?? verifyOfflinePython
  const report = { schemaVersion: 1, purpose: 'installed-runtime-acceptance',
    execution: ['platform', 'arch', 'run', 'pythonProbe'].some(key => Object.hasOwn(options, key)) ? 'simulated' : 'native',
    platform, architecture: arch, resources, startedAt: new Date().toISOString(), status: 'running', checks: [],
    scope: 'Bundled Node, DSH and isolated Python imports/venv only; does not validate AEDT, a repair candidate, or authorize plugin activation.' }
  const publish = () => options.publish?.(structuredClone(report))
  const finish = () => { report.finishedAt = new Date().toISOString(); publish(); return report }
  publish()
  if (platform !== 'win32' || arch !== 'x64') {
    report.status = 'unsupported'; report.error = 'Requires the installed Windows x64 application runtime'
    return finish()
  }
  const node = join(resources, 'node', 'node.exe'), python = join(resources, 'python', 'python.exe')
  const unpacked = join(resources, 'app.asar.unpacked')
  const command = (executable, args, timeout = 15_000) => run(executable, args, {
    encoding: 'utf8', timeout, maxBuffer: 256 * 1024, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONPATH: '' },
  }).trim()
  const check = (name, action) => {
    try { report.checks.push({ name, passed: true, result: action() }) }
    catch (error) { report.checks.push({ name, passed: false, error: String(error?.message ?? error).slice(0, 2000) }) }
    publish()
  }
  check('bundled-node', () => {
    const version = command(node, ['--version'])
    const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(version)
    if (!match || !(Number(match[1]) === 22 && Number(match[2]) >= 22 || Number(match[1]) >= 24)) throw new Error(`Unsupported bundled Node version: ${version}`)
    if (report.execution === 'native' && realpathSync(process.execPath).toLowerCase() !== realpathSync(node).toLowerCase()) throw new Error('Run this script with the installed resources/node/node.exe')
    return { version, sha256: hash(node) }
  })
  check('bundled-dsh', () => {
    const bin = join(unpacked, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    const version = command(node, [bin, '--version'])
    const manifest = JSON.parse(readFileSync(join(unpacked, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    if (manifest.name !== '@deepseek-ai/dsh' || typeof manifest.version !== 'string' || version !== manifest.version) throw new Error(`Unsupported DSH version: ${version}`)
    return { version, cliSha256: hash(bin) }
  })
  check('python-imports-and-independent-environment', () => {
    const result = pythonProbe(python, join(resources, 'python'),
      join(unpacked, 'plugins', 'icepak-pyaedt', 'python'), join(unpacked, 'plugins', 'report-reportlab', 'python'))
    if (result.platform !== 'win32' || result.bits !== 64 || result.isolatedEnvironments !== true) throw new Error('Expected Windows x64 Python with working independent environments')
    return { ...result, executableSha256: hash(python) }
  })
  check('packaged-acceptance-tools', () => {
    const paths = ['probe-windows-plugin-isolation.mjs', 'verify-windows-runtime.mjs', 'accept-installed-runtime.mjs']
    for (const path of paths) if (!existsSync(join(resources, 'runtime-checks', path))) throw new Error(`Missing installed acceptance tool: ${path}`)
    return Object.fromEntries(paths.map(path => [path, hash(join(resources, 'runtime-checks', path))]))
  })
  report.status = report.checks.every(item => item.passed) ? 'passed' : 'failed'
  return finish()
}

function main() {
  const args = process.argv.slice(2), values = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--resources', '--output'].includes(args[i]) || !args[i + 1] || values[args[i]]) throw new Error('Usage: bundled-node accept-installed-runtime.mjs --output <report.json> [--resources <installed resources directory>]')
    values[args[i]] = args[i + 1]
  }
  if (!values['--output']) throw new Error('--output is required to retain the acceptance report')
  const output = resolve(values['--output']); mkdirSync(dirname(output), { recursive: true })
  const report = inspectInstalledRuntime({ resources: values['--resources'], publish: record => {
    const temporary = `${output}.${randomUUID()}.tmp`
    try { writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, output) }
    finally { rmSync(temporary, { force: true }) }
  } })
  console.log(JSON.stringify({ status: report.status, execution: report.execution, output }))
  process.exitCode = report.status === 'passed' ? 0 : report.status === 'unsupported' ? 2 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === source) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
