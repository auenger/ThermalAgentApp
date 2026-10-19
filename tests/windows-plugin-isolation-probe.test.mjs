import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeWindowsPluginIsolation, sandboxProbeConfiguration } from '../scripts/probe-windows-plugin-isolation.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'thermal-probe-test-')), executable = join(root, 'wsb.exe')
  await writeFile(executable, 'test driver fixture; not executable')
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, options: { platform: 'win32', osRelease: '10.0.26100', executable, temporaryRoot: root } }
}

test('configuration exposes one read-only mapping and disables optional host sharing', () => {
  const config = sandboxProbeConfiguration(join(tmpdir(), "probe & 'quoted'"))
  assert.match(config, /probe &amp; &apos;quoted&apos;/)
  for (const tag of ['Networking', 'vGPU', 'AudioInput', 'VideoInput', 'PrinterRedirection', 'ClipboardRedirection']) assert.ok(config.includes(`<${tag}>Disable</${tag}>`))
  assert.equal((config.match(/<MappedFolder>/g) ?? []).length, 1)
  assert.match(config, /<ReadOnly>true<\/ReadOnly>/)
  assert.match(config, /<ProtectedClient>Enable<\/ProtectedClient>/)
  assert.match(config, /<MemoryInMB>2048<\/MemoryInMB>/)
  assert.doesNotMatch(config, /<LogonCommand>|<ReadOnly>false/)
  assert.throws(() => sandboxProbeConfiguration('relative/path'))
})

test('native unsupported hosts do not launch processes or report isolation success', async () => {
  let ran = false
  for (const [platform, osRelease] of [['darwin', '25.0.0'], ['win32', '10.0.22631']]) {
    const result = await probeWindowsPluginIsolation({ platform, osRelease, run: async () => { ran = true } })
    assert.equal(result.status, 'unsupported'); assert.deepEqual(result.checks, []); assert.equal(result.cleanup.attempted, false)
  }
  assert.equal(ran, false)
})

test('fixed probes use exit codes only, record provenance, and stop the exact owned sandbox before success', async t => {
  const { root, options } = await fixture(t), calls = [], snapshots = []
  const result = await probeWindowsPluginIsolation({ ...options, publish: async record => snapshots.push(record), run: async (exe, args, limits) => {
    assert.equal(exe, options.executable); assert.ok(limits.timeoutMs > 0 && limits.timeoutMs <= 120000)
    assert.equal(limits.maxOutputBytes, 65536)
    assert.equal(args.at(-1), '--raw')
    if (args[0] === 'exec') {
      const command = args[args.indexOf('--command') + 1]
      assert.match(command, /powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand /)
      const decoded = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le')
      assert.match(decoded, /exit (10|11|12|13|37)/)
      assert.doesNotMatch(decoded, /Invoke-Expression|Start-Process|python|plugin\.json/)
    }
    calls.push(args)
    const encoded = args[0] === 'exec' ? args[args.indexOf('--command') + 1].split(' ').at(-1) : ''
    return { code: Buffer.from(encoded, 'base64').toString('utf16le').includes('exit 37') ? 37 : 0, stdout: 'ignored CLI output, not validation evidence', stderr: '' }
  } })
  assert.equal(result.status, 'passed'); assert.equal(result.execution, 'simulated')
  assert.equal(result.checks.length, 7); assert.ok(result.checks.every(check => check.passed))
  assert.deepEqual(calls.map(args => args[0]), ['start', 'exec', 'exec', 'exec', 'exec', 'exec', 'stop'])
  assert.ok(calls.every(args => args[args.indexOf('--id') + 1] === result.runId))
  assert.match(result.backend.sha256, /^[a-f0-9]{64}$/)
  assert.match(result.probeSha256, /^[a-f0-9]{64}$/)
  assert.equal(snapshots[0].checks.length, 0, 'owned ID is recorded before launch')
  assert.ok(snapshots.slice(0, -1).every(record => record.status === 'running'))
  assert.equal(snapshots.at(-1).cleanup.confirmed, true)
  assert.deepEqual(await readdir(root), ['wsb.exe'])
})

for (const failure of ['start-timeout', 'exit-code-not-forwarded', 'boundary-failed', 'cancelled', 'host-canary-changed', 'stop-failed']) test(`probe fails closed and handles cleanup: ${failure}`, async t => {
  const { options } = await fixture(t), controller = new AbortController(), calls = []
  let directory
  const result = await probeWindowsPluginIsolation({ ...options, signal: controller.signal,
    publish: async value => { directory = value.temporaryDirectory ?? directory },
    run: async (_exe, args, limits) => {
      calls.push(args)
      if (args[0] === 'stop') {
        assert.equal(limits.signal, undefined, 'shutdown must outlive cancellation')
        return { code: failure === 'stop-failed' ? 1 : 0 }
      }
      if (args[0] === 'start' && failure === 'start-timeout') throw new Error('simulated start timeout after VM creation')
      if (args[0] === 'exec') {
        const decoded = Buffer.from(args[args.indexOf('--command') + 1].split(' ').at(-1), 'base64').toString('utf16le')
        if (decoded.includes('exit 37')) return { code: failure === 'exit-code-not-forwarded' ? 0 : 37 }
        if (failure === 'boundary-failed') return { code: 11 }
        if (failure === 'cancelled') controller.abort()
        if (failure === 'host-canary-changed') await writeFile(join(directory, 'input', 'canary.txt'), 'unexpected host mutation')
      }
      return { code: 0 }
    } })
  assert.equal(result.status, failure === 'stop-failed' ? 'cleanup-unconfirmed' : 'failed')
  assert.equal(calls.at(-1)[0], 'stop')
  assert.equal(calls.at(-1)[2], result.runId)
  if (failure === 'stop-failed') {
    assert.equal(result.cleanup.confirmed, false)
    await access(directory)
  } else {
    assert.equal(result.cleanup.confirmed, true)
    await assert.rejects(access(directory), { code: 'ENOENT' })
  }
  if (failure === 'host-canary-changed') assert.equal(result.checks.at(-1).passed, false)
})

test('cancellation before start never dispatches a VM or an unrelated stop', async t => {
  const { root, options } = await fixture(t), controller = new AbortController()
  controller.abort()
  let dispatched = false
  const result = await probeWindowsPluginIsolation({ ...options, signal: controller.signal, run: async () => { dispatched = true; return { code: 0 } } })
  assert.equal(dispatched, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.cleanup.attempted, false)
  assert.deepEqual(await readdir(root), ['wsb.exe'])
})
