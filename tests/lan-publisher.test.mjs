import assert from 'node:assert/strict'
import test from 'node:test'
import { LanPublisher } from '@thermal-agent/core'

test('LAN publishing is explicit and API access requires a paired HttpOnly session', async t => {
  const publisher = new LanPublisher((request, response) => {
    const body = JSON.stringify({ path: request.url, method: request.method })
    response.writeHead(200, { 'Content-Type': request.url?.startsWith('/api/') ? 'application/json' : 'text/html' })
    response.end(body)
  })
  t.after(() => publisher.stop())
  const started = await publisher.start(0, '127.0.0.1')
  assert.equal(started.enabled, true)
  assert.match(started.pairingCode, /^\d{8}$/u)
  const base = `http://127.0.0.1:${started.port}`

  assert.equal((await fetch(base)).status, 200)
  assert.equal((await fetch(`${base}/api/private`)).status, 401)
  assert.equal((await fetch(`${base}/api/lan/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '00000000' }),
  })).status, 401)

  const paired = await fetch(`${base}/api/lan/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: started.pairingCode }),
  })
  assert.equal(paired.status, 200)
  const cookie = paired.headers.get('set-cookie')
  assert.match(cookie ?? '', /thermal_lan_session=.*HttpOnly.*SameSite=Strict/u)
  assert.equal((await fetch(`${base}/api/private`, { headers: { Cookie: cookie } })).status, 200)
  assert.equal((await fetch(`${base}/api/write`, { method: 'POST', headers: { Cookie: cookie } })).status, 403)
  assert.equal((await fetch(`${base}/api/write`, {
    method: 'POST', headers: { Cookie: cookie, Origin: base },
  })).status, 200)

  await publisher.stop()
  assert.equal(publisher.status().enabled, false)
})
