import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CoreProcessSupervisor } from '../apps/desktop/dist/core-process-supervisor.js'

function fakeChild() {
  const child = new EventEmitter()
  child.killed = false
  child.kill = () => { child.killed = true; child.emit('exit', 0, 'SIGTERM'); return true }
  return child
}

test('desktop Core supervisor restarts a crashed child, caps retries and never restarts after explicit quit', async () => {
  const children = []
  const states = []
  const supervisor = new CoreProcessSupervisor(() => {
    const child = fakeChild()
    children.push(child)
    return child
  }, (state, detail) => states.push({ state, detail }), { maxRestarts: 2, restartDelayMs: 5, stableMs: 1_000 })

  supervisor.start()
  supervisor.start()
  assert.equal(children.length, 1)
  children[0].emit('error', new Error('spawn failed'))
  children[0].emit('exit', 1, null)
  await delay(20)
  assert.equal(children.length, 2, 'error and exit must schedule only one restart')
  children[1].emit('exit', 1, null)
  await delay(25)
  assert.equal(children.length, 3)
  children[2].emit('exit', 1, null)
  await delay(20)
  assert.equal(children.length, 3)
  assert.deepEqual(states.map(item => item.state), ['restarting', 'restarted', 'restarting', 'restarted', 'failed'])

  supervisor.start()
  assert.equal(children.length, 4, 'explicit reopen can retry a failed Core')
  supervisor.stop()
  assert.equal(children[3].killed, true)
  await delay(20)
  assert.equal(children.length, 4, 'quit must not restart the stopped child')
})
