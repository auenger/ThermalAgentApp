import { resolve } from 'node:path'
import { createCoreApp } from './server.js'

const host = process.env.THERMAL_AGENT_HOST ?? '127.0.0.1'
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  throw new Error('LAN binding is disabled until device pairing and authentication are implemented')
}
const port = Number(process.env.THERMAL_AGENT_PORT ?? '43110')
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('THERMAL_AGENT_PORT is invalid')
const home = resolve(process.env.THERMAL_AGENT_HOME ?? '.thermal-agent')

const app = createCoreApp({ home })
app.server.listen(port, host, () => {
  console.log(`thermal-agent-core listening on http://${host}:${port}`)
})

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  await app.close()
}

process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)) })
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })
