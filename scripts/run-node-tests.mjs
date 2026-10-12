import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const tests = resolve(import.meta.dirname, '../tests')
const files = readdirSync(tests).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(tests, name))
if (files.length === 0) throw new Error('No Node test files found')
// These files launch App/DSH/Python processes; bound parallelism to avoid starving startup deadlines.
const concurrency = Number(process.env.THERMAL_TEST_CONCURRENCY ?? 4)
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('THERMAL_TEST_CONCURRENCY must be an integer in [1, 32]')
const result = spawnSync(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...files], { stdio: 'inherit', windowsHide: true })
if (result.error) {
  console.error(`Node tests could not start: ${result.error.message}`)
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
