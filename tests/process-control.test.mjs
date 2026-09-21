import assert from 'node:assert/strict'
import test from 'node:test'
import { terminateProcessTree, windowsTerminationPlan } from '@thermal-agent/process-control'

test('Windows process tree termination targets descendants and supports forced cleanup', () => {
  assert.deepEqual(windowsTerminationPlan(4242, false), {
    command: 'taskkill.exe', args: ['/PID', '4242', '/T'],
  })
  assert.deepEqual(windowsTerminationPlan(4242, true), {
    command: 'taskkill.exe', args: ['/PID', '4242', '/T', '/F'],
  })
  assert.throws(() => windowsTerminationPlan(0, true), /positive integer/u)
})

test('non-Windows termination uses graceful and forced signals deterministically', () => {
  const signals = []
  const child = { pid: 1, kill(signal) { signals.push(signal); return true } }
  terminateProcessTree(child, { platform: 'linux' })
  terminateProcessTree(child, { platform: 'linux', force: true })
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
})
