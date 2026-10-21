import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
// Resolve from the selected DSH installation, never from an unrelated global CLI.
const require = createRequire(process.env.THERMAL_AGENT_DSH_CLI)
const { runProfile } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')).href)
const { loadLayeredEnv } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
const pnpmManifest = require('pnpm')
const pnpmEntry = join(dirname(require.resolve('pnpm')), typeof pnpmManifest.bin === 'string' ? pnpmManifest.bin : pnpmManifest.bin.pnpm)
const [patch, port] = process.argv.slice(2)
try {
  const { ctx } = await runProfile({
    environment: loadLayeredEnv('thermal-dsh'), profile: 'web', patchFiles: [patch],
    args: ['--no-open', '--host', '127.0.0.1', '--port', port],
    packageManager: { command: process.execPath, args: [pnpmEntry], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} },
  })
  const url = ctx.connection.authenticatedUrl(ctx.webApp.getAdvertisedUrl())
  process.send?.({ type: 'thermal-dsh-ready', protocol: 1, url })
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
