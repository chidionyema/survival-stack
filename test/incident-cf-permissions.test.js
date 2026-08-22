// Two incidents from one migration run, both of the same class: a Cloudflare
// answer was read as meaning something it does not mean.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as z from '../scripts/console/zone.mjs'

const withFetch = async (handler, fn) => {
  const real = globalThis.fetch
  globalThis.fetch = handler
  try { return await fn() } finally { globalThis.fetch = real }
}
const reply = (body, ok = true) => new Response(JSON.stringify({ success: ok, result: body, errors: ok ? [] : [{ code: 10000, message: 'Authentication error' }] }), {
  status: ok ? 200 : 403, headers: { 'content-type': 'application/json' },
})

test('incident: a zone-scoped token sees no account, and that is not a missing permission', async () => {
  // GET /accounts returned 200 with an empty array, so accountId() was null,
  // and the run stopped saying the token needed Account:Read. It did not. A
  // token scoped to zones rather than to an account is simply not in the
  // account listing, and POST /zones without an account attaches the zone to
  // the only account the credential belongs to. Measured live: 200, created.
  let sent = null
  const zone = await withFetch(async (url, opts) => {
    sent = JSON.parse(opts.body)
    return reply({ id: 'z1', status: 'pending', name_servers: ['a.ns', 'b.ns'] })
  }, () => z.createZone('t', null, 'example.com'))

  assert.equal(zone.id, 'z1')
  assert.equal('account' in sent, false, 'a null account was sent as {id: null} and the API will refuse it')
  assert.equal(sent.name, 'example.com')

  // An account id, when there is one, still goes in.
  const withAcct = await withFetch(async (url, opts) => {
    sent = JSON.parse(opts.body)
    return reply({ id: 'z2' })
  }, () => z.createZone('t', 'acct-1', 'example.com'))
  assert.equal(withAcct.id, 'z2')
  assert.deepEqual(sent.account, { id: 'acct-1' })
})

test('incident: Zone:Edit without DNS:Edit refused eight writes and named no permission', async () => {
  // The credential created the zone, listed it, and reported "valid, 1 zone in
  // scope". Every DNS endpoint on that zone was 403 "Authentication error" -
  // a message that describes the token rather than the permission it lacks.
  // One probe up front turns eight cryptic lines into one that says what to fix.
  const denied = await withFetch(async () => reply(null, false),
    () => z.dnsReachable('t', 'z1'))
  assert.equal(denied, false, 'a 403 on the DNS listing was read as reachable')

  const allowed = await withFetch(async (url) => {
    assert.match(String(url), /\/zones\/z1\/dns_records/)
    return reply([])
  }, () => z.dnsReachable('t', 'z1'))
  assert.equal(allowed, true, 'an empty zone was mistaken for no permission')
})
