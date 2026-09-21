import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const tests = resolve(import.meta.dirname, '../tests')
const files = readdirSync(tests).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(tests, name))
if (files.length === 0) throw new Error('No Node test files found')
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', windowsHide: true })
if (result.error) {
  console.error(`Node tests could not start: ${result.error.message}`)
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
