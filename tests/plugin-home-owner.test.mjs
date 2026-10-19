import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginHomeOwner } from '../apps/core/dist/plugin-home-owner.js'

const moduleUrl = new URL('../apps/core/dist/plugin-home-owner.js', import.meta.url).href

test('plugin home ownership excludes other processes and recovers after forced owner termination', { timeout: 15000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'thermal-home-owner-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { PluginHomeOwner } from ${JSON.stringify(moduleUrl)}; new PluginHomeOwner(process.argv[1]); console.log('owned'); setInterval(() => {}, 1000)`, home],
  { stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  const [ready] = await once(child.stdout, 'data')
  assert.match(ready.toString(), /owned/)
  assert.throws(() => new PluginHomeOwner(home), /already owned/)
  const contender = `import { PluginHomeOwner } from ${JSON.stringify(moduleUrl)}; try { new PluginHomeOwner(process.argv[1]); process.exit(2) } catch (error) { console.log(error.message) }`
  assert.match(execFileSync(process.execPath, ['--input-type=module', '-e', contender, home], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }), /already owned/)
  if (process.platform !== 'win32') {
    const alias = `${home}-alias`
    await symlink(home, alias)
    t.after(() => rm(alias, { force: true }))
    assert.throws(() => new PluginHomeOwner(alias), /already owned/, 'directory aliases cannot bypass ownership')
  }
  child.kill('SIGKILL')
  await exited
  const owner = new PluginHomeOwner(home)
  assert.throws(() => new PluginHomeOwner(home), /already owned/)
  owner.release(); owner.release()
  new PluginHomeOwner(home).release()
})
