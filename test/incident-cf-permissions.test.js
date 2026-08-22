// Two incidents from one migration run, both of the same class: a Cloudflare
// answer was read as meaning something it does not mean.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as z from '../scripts/console/zone.mjs'

// whois is a binary, so it is stubbed by putting a fake one first on PATH.
import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const withWhois = async (output, fn) => {
  const dir = await mkdtemp(join(tmpdir(), 'whois-'))
  const bin = join(dir, 'whois')
  await writeFile(bin, output === null
    ? '#!/bin/sh\nexit 127\n'
    : `#!/bin/sh\ncat <<'WEOF'\n${output}\nWEOF\n`)
  await chmod(bin, 0o755)
  const had = process.env.PATH
  process.env.PATH = dir + ':' + had   // the stub wins; /bin stays reachable for cat
  try { return await fn() } finally { process.env.PATH = had }
}


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

test('incident: "Invalid nameservers" was a registrar lock, not a nameserver', async () => {
  // Both Cloudflare nameservers resolved, both already answered authoritatively
  // for the zone, and 123-reg still refused the change with "Invalid
  // nameservers". The domain carried clientUpdateProhibited - the registrar
  // lock - which blocks updates to the domain object including its nameserver
  // set. The form reports that as a problem with what was typed.
  const { registrarLock } = z
  assert.equal(typeof registrarLock, 'function')

  // The parse is the part that can rot. whois output varies by registry, so
  // this pins the shape that was actually seen for mumchimp.com at 123-reg.
  const locked = await withWhois(`
   Domain Name: EXAMPLE.COM
   Registrar: 123-Reg Limited
   Domain Status: clientDeleteProhibited https://icann.org/epp#clientDeleteProhibited
   Domain Status: clientTransferProhibited https://icann.org/epp#clientTransferProhibited
   Domain Status: clientUpdateProhibited https://icann.org/epp#clientUpdateProhibited
`, () => registrarLock('example.com'))
  assert.equal(locked.locked, true, 'clientUpdateProhibited was not read as a lock')
  assert.ok(locked.statuses.includes('clientUpdateProhibited'))

  // Transfer-locked but update-allowed is the normal, fine case. Calling that
  // locked would send somebody to unlock a domain that is already changeable.
  const fine = await withWhois(`
   Domain Status: clientTransferProhibited https://icann.org/epp#clientTransferProhibited
   Domain Status: ok
`, () => registrarLock('example.com'))
  assert.equal(fine.locked, false, 'a transfer lock was mistaken for an update lock')

  // No whois binary is not a claim that the domain is unlocked.
  const unknown = await withWhois(null, () => registrarLock('example.com'))
  assert.equal(unknown.known, false)
  assert.equal(unknown.locked, false, 'unknown must never print the unlock instruction')
})
