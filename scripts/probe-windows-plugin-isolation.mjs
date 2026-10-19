import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir, release } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_OUTPUT_BYTES = 64 * 1024
const commandTimeoutMs = 30_000
const sourcePath = fileURLToPath(import.meta.url)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const xml = value => value.replace(/[&<>"']/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch])
const ps = value => `'${value.replaceAll("'", "''")}'`

export function sandboxProbeConfiguration(inputDirectory) {
  if (!isAbsolute(inputDirectory) || /[\x00-\x1f]/u.test(inputDirectory)) throw new Error('Probe mapping must be an absolute local directory')
  return `<Configuration><Networking>Disable</Networking><vGPU>Disable</vGPU><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ClipboardRedirection>Disable</ClipboardRedirection><ProtectedClient>Enable</ProtectedClient><MemoryInMB>2048</MemoryInMB><MappedFolders><MappedFolder><HostFolder>${xml(inputDirectory)}</HostFolder><SandboxFolder>C:\\ThermalProbeInput</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder></MappedFolders></Configuration>`
}

function nativeRun(executable, args, { timeoutMs, signal }) {
  return new Promise((resolveRun, reject) => {
    execFile(executable, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true, signal }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') { reject(error); return }
      resolveRun({ code: error?.code ?? 0, stdout, stderr })
    })
  })
}

/** Runs only fixed, host-owned boundary tests. No candidate, App data, Python runtime or output folder is mapped. */
export async function probeWindowsPluginIsolation(options = {}) {
  const platform = options.platform ?? process.platform, osRelease = options.osRelease ?? release()
  const run = options.run ?? nativeRun, publish = options.publish ?? (async () => {})
  const record = { schemaVersion: 1, purpose: 'windows-plugin-isolation-preflight',
    execution: options.run || options.platform || options.osRelease ? 'simulated' : 'native',
    probeSha256: sha(await readFile(sourcePath)), runId: randomUUID(), startedAt: new Date().toISOString(),
    host: { platform, osRelease, architecture: process.arch, nodeVersion: process.version },
    backend: { kind: 'windows-sandbox-cli' }, status: 'running', checks: [],
    limits: { commandTimeoutMs, startTimeoutMs: 120_000, overallTimeoutMs: 180_000, configuredMemoryMiB: 2048, maxCliStreamBytes: MAX_OUTPUT_BYTES },
    cleanup: { attempted: false, confirmed: false },
    scope: 'Fixed host-owned probes only. Does not validate a repair candidate, AEDT, CPU/disk quotas, or authorize activation.' }
  const snapshot = () => publish(structuredClone(record))
  const finish = async () => { record.finishedAt = new Date().toISOString(); await snapshot(); return record }
  if (platform !== 'win32' || Number(osRelease.split('.')[2] ?? 0) < 26100) {
    record.status = 'unsupported'; record.error = 'Requires Windows 11 24H2 or later and an installed Windows Sandbox CLI'
    return finish()
  }
  let directory, launched = false
  try {
    if (typeof options.executable !== 'string' || !isAbsolute(options.executable)) throw new Error('An absolute path to the installed Windows Sandbox CLI is required (--wsb)')
    const info = await lstat(options.executable)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('Sandbox CLI must be a regular executable, not a link or alias')
    record.backend.executable = options.executable
    record.backend.sha256 = sha(await readFile(options.executable))
    directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), 'thermal-isolation-probe-'))
    const input = join(directory, 'input'), privateCanary = join(directory, 'host-only.txt'), nonce = randomUUID()
    await mkdir(input)
    await writeFile(join(input, 'canary.txt'), nonce, { flag: 'wx' })
    await writeFile(privateCanary, nonce, { flag: 'wx' })
    record.temporaryDirectory = directory
    const config = sandboxProbeConfiguration(input)
    record.configurationSha256 = sha(config)
    await snapshot() // A crash leaves the exact owned sandbox ID and temporary mapping recorded.
    const deadline = Date.now() + record.limits.overallTimeoutMs
    const invoke = async (args, limit = commandTimeoutMs) => {
      options.signal?.throwIfAborted()
      const timeoutMs = Math.min(limit, deadline - Date.now())
      if (timeoutMs <= 0) throw new Error('Isolation probe deadline exceeded')
      const result = await run(options.executable, [...args, '--raw'], { timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES, signal: options.signal })
      if (!Number.isInteger(result.code)) throw new Error('Sandbox CLI did not return a process exit code')
      return result.code
    }
    options.signal?.throwIfAborted()
    launched = true // Start may create a VM even if its CLI later times out.
    const started = await invoke(['start', '--id', record.runId, '--config', config], record.limits.startTimeoutMs)
    record.checks.push({ name: 'sandbox-start', passed: started === 0, exitCode: started })
    await snapshot()
    if (started !== 0) throw new Error(`Windows Sandbox start failed (${started})`)
    const shared = 'C:\\ThermalProbeInput\\canary.txt'
    const tests = [
      ['mapped-input-readable', `if ([IO.File]::ReadAllText(${ps(shared)}) -ceq ${ps(nonce)}) { exit 0 }; exit 10`],
      ['mapped-input-write-denied', `try { [IO.File]::WriteAllText(${ps(shared)}, 'changed'); exit 11 } catch { exit 0 }`],
      ['unmapped-host-file-unreadable', `try { $null = [IO.File]::ReadAllText(${ps(privateCanary)}); exit 12 } catch { exit 0 }`],
      ['network-adapter-disabled', `$adapters = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' }); if ($adapters.Count -eq 0) { exit 0 }; exit 13`],
    ]
    const execute = async script => {
      const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'; try { ${script} } catch { exit 99 }`, 'utf16le').toString('base64')
      const command = `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`
      return invoke(['exec', '--id', record.runId, '--run-as', 'System', '--command', command])
    }
    // Some CLI wrappers return success for dispatch instead of the guest exit code. Never accept that as boundary evidence.
    const controlCode = await execute('exit 37')
    record.checks.push({ name: 'guest-exit-code-channel', passed: controlCode === 37, exitCode: controlCode })
    await snapshot()
    if (controlCode !== 37) throw new Error('Sandbox CLI does not propagate the controlled guest exit code')
    for (const [name, script] of tests) {
      const exitCode = await execute(script)
      record.checks.push({ name, passed: exitCode === 0, exitCode })
      await snapshot()
      if (exitCode !== 0) throw new Error(`Isolation boundary probe failed: ${name} (${exitCode})`)
    }
    const unchanged = await readFile(join(input, 'canary.txt'), 'utf8') === nonce && await readFile(privateCanary, 'utf8') === nonce
    record.checks.push({ name: 'host-canaries-unchanged', passed: unchanged })
    if (!unchanged) throw new Error('Host probe canary changed')
    record.status = 'passed'
  } catch (error) {
    record.status = 'failed'
    record.error = options.signal?.aborted ? 'Isolation probe cancelled' : (error instanceof Error ? error.message : String(error)).slice(0, 1000)
  } finally {
    if (launched) {
      record.cleanup.attempted = true
      try {
        // Cleanup is independent of the cancelled/expired operation budget and stops only our exact ID.
        const result = await run(options.executable, ['stop', '--id', record.runId, '--raw'], { timeoutMs: commandTimeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES })
        record.cleanup.confirmed = result.code === 0
        if (!record.cleanup.confirmed) throw new Error(`Sandbox stop failed (${result.code})`)
      } catch (error) {
        record.status = 'cleanup-unconfirmed'
        record.cleanup.error = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
      }
    }
    if (directory && (!launched || record.cleanup.confirmed)) {
      try { await rm(directory, { recursive: true, force: true }); record.cleanup.temporaryFilesRemoved = true }
      catch { record.cleanup.temporaryFilesRemoved = false }
    }
  }
  return finish()
}

async function main() {
  const args = process.argv.slice(2), values = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--wsb', '--output'].includes(args[i]) || !args[i + 1] || values[args[i]]) throw new Error('Usage: node scripts/probe-windows-plugin-isolation.mjs --output <report.json> [--wsb <absolute actual wsb.exe path>]')
    values[args[i]] = args[i + 1]
  }
  if (!values['--output']) throw new Error('--output is required to retain evidence and the sandbox ID after interruption')
  const output = resolve(values['--output'])
  await mkdir(dirname(output), { recursive: true })
  const controller = new AbortController(), cancel = () => controller.abort(new Error('Probe interrupted'))
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try {
    const result = await probeWindowsPluginIsolation({ executable: values['--wsb'], signal: controller.signal,
      publish: async record => {
        const temporary = `${output}.${randomUUID()}.tmp`
        try { await writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 }); await rename(temporary, output) }
        finally { await rm(temporary, { force: true }) }
      } })
    console.log(JSON.stringify({ status: result.status, output, runId: result.runId, cleanup: result.cleanup }))
    process.exitCode = result.status === 'passed' ? 0 : result.status === 'unsupported' ? 2 : 1
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
}
if (process.argv[1] && resolve(process.argv[1]) === sourcePath) void main().catch(error => { console.error(error.message); process.exitCode = 1 })
