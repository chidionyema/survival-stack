// Incident, found by the dry run on 2026-08-22: in degraded mode a POST /order
// came back {"ok":false,"error":"bad json"}. The failed origin attempt had
// already consumed the request body, so the order was lost at the exact moment
// nothing else could take it. Second defect in the same path: the degraded
// catalog posts an HTML form, which the JSON-only parser also refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serve } from '../src/degraded.js'
import { setBox } from '../src/state.js'
import { baseEnv } from './helpers/fakes.js'

const pending = []
const ctx = { waitUntil: (p) => pending.push(p) }
const settle = () => Promise.allSettled(pending.splice(0))

async function bothBoxesDead() {
  const env = baseEnv()
  await setBox(env, 'primary', { ip: '10.0.0.1', provider: 'hetzner', providerId: '1' })
  await setBox(env, 'standby', { ip: '10.0.0.2', provider: 'vultr', providerId: '2' })
  globalThis.fetch = async () => { throw new Error('connection refused') }
  return env
}

test('a JSON order survives both origins being dead', async () => {
  const env = await bothBoxesDead()
  const res = await serve(env, new Request('https://shop.test/order', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sku: 'pack-basic', email: 'a@b.test' }),
  }), ctx)

  await settle()
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)

  const keys = (await env.DATA.list({ prefix: 'orders/queued/' })).objects
  assert.equal(keys.length, 1, 'exactly one order written to R2')
  const stored = JSON.parse(await (await env.DATA.get(keys[0].key)).text())
  assert.equal(stored.order.sku, 'pack-basic', 'the order contents survived, not just the fact of one')
})

test('an order from the degraded catalog form is kept too', async () => {
  const env = await bothBoxesDead()
  const res = await serve(env, new Request('https://shop.test/order', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'sku=pack-family&email=c%40d.test',
  }), ctx)

  await settle()
  assert.equal(res.status, 200)
  const keys = (await env.DATA.list({ prefix: 'orders/queued/' })).objects
  const stored = JSON.parse(await (await env.DATA.get(keys[0].key)).text())
  assert.equal(stored.order.sku, 'pack-family')
  assert.equal(stored.order.email, 'c@d.test')
})

test('an empty body is still refused', async () => {
  const env = await bothBoxesDead()
  const res = await serve(env, new Request('https://shop.test/order', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '',
  }), ctx)
  await settle()
  assert.equal(res.status, 400)
})
