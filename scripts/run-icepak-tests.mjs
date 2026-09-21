import { spawnSync } from 'node:child_process'

const python = process.env.THERMAL_ICEPAK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'plugins/icepak-pyaedt/tests', '-v'], {
  stdio: 'inherit',
  windowsHide: true,
})
if (result.error) {
  console.error(`Icepak tests could not start ${python}: ${result.error.message}`)
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
