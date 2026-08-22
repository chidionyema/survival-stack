// Getting a Cloudflare credential without typing one.
//
// The incident behind this file is not a bug in the code. It is a plan that
// was confidently wrong: "use wrangler login, it is the industry standard".
// It is the standard, and this project uses it for the deploy, and it cannot
// do this job. The first test pins that so nobody re-litigates it from memory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import * as auth from '../scripts/lib/cf-auth.mjs'

const run = promisify(execFile)
const WRANGLER = join(process.cwd(), 'node_modules', '.bin', 'wrangler')

test('incident: wrangler OAuth cannot create a zone or write DNS, whatever the flag says', async (t) => {
  const r = await run(WRANGLER, ['login', '--scopes-list'], { timeout: 90000 }).catch(() => null)
  if (!r) return t.skip('wrangler not installed')
  const scopes = r.stdout.split('\n').map((l) => (l.match(/^│ ([a-z0-9_.:-]+)\s/) || [])[1]).filter(Boolean)

  assert.ok(scopes.length > 10, 'expected wrangler to list its scopes')
  assert.ok(scopes.includes('zone:read'), 'zone:read should be on offer')

  // The two that would make an OAuth-only migration possible. Neither exists.
  // If a future wrangler adds them, this test fails and the token flow can go.
  assert.equal(scopes.includes('zone:edit'), false, 'zone:edit is now available — drop the API token')
  assert.equal(scopes.includes('dns_records:edit'), false, 'dns_records:edit is now available — drop the API token')
})

test('incident: a real token was ignored because it was not 40 characters', async () => {
  // The check was /^[A-Za-z0-9_-]{40}$/. Cloudflare started issuing a
  // `cfut_`-prefixed 53-character token, the watcher saw a live, active
  // credential, decided it was the wrong shape, and said nothing. Half an hour
  // of window went by looking like a broken clipboard.
  //
  // The rule that came out of it: never assume a vendor's format is static.
  // The API is the validator. This asserts both halves - the new shape passes,
  // and no length equality is left anywhere in the source.
  assert.equal(auth.looksLikeToken('cfut_' + 'x'.repeat(48)), true, 'the cfut_ form is refused again')
  assert.equal(auth.looksLikeToken('a'.repeat(40)), true, 'the old form stopped working')
  assert.equal(auth.looksLikeToken('a'.repeat(39)), true, 'a length is being enforced again')
  assert.equal(auth.looksLikeToken('a'.repeat(41)), true, 'a length is being enforced again')
  assert.equal(auth.looksLikeToken('q'.repeat(200)), true, 'an upper bound came back')

  // Comments stripped, or this matches the paragraph above describing the bug.
  const src = (await readFile(new URL('../scripts/lib/cf-auth.mjs', import.meta.url), 'utf8'))
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.equal(/length\s*[!=]==?\s*\d/.test(src), false, 'a length equality is back in the validator')
  assert.equal(/\{40\}/.test(src), false, 'the 40-character regex is back')
})

test('a candidate that is turned away says which thing went wrong', () => {
  // Silence was the defect. Every rejection carries the sentence that tells
  // the user whether to fix the copy or fix the token.
  for (const junk of ['', ' ', 'hunter2', 'a'.repeat(19)]) {
    const c = auth.tokenCandidate(junk)
    assert.equal(c.ok, false, `${JSON.stringify(junk)} was taken for a token`)
    assert.ok(c.why && c.why.length > 5, 'rejected with no reason given')
  }
  assert.match(auth.tokenCandidate('hunter2').why, /too short/)
  assert.match(auth.tokenCandidate('correct horse battery staple and more').why, /spaces|newlines/)
  assert.match(auth.tokenCandidate('https://example.com/quite/long/indeed/x').why, /URL/)
})

test("another vendor's key is never sent to Cloudflare to be checked", () => {
  // Checking a candidate means handing it to Cloudflare as a bearer token.
  // Several vendors issue keys of exactly this shape, so a stray copy would
  // otherwise leak one secret to an unrelated company. These stop at the door.
  for (const prefix of ['sk-', 'sk_', 'pk_', 'ghp_', 'xoxb-', 'AKIA', 'AIza', 'hf_', 'glpat-', 'dop_v1_', 'SG.', 'npm_']) {
    const key = prefix + 'x'.repeat(40)
    const c = auth.tokenCandidate(key)
    assert.equal(c.ok, false, `a ${prefix}… key would have been sent to Cloudflare`)
    assert.match(c.why, /another vendor/, 'refused, but not for the reason that matters')
  }
})

test('a multi-line clipboard is not a token', () => {
  assert.equal(auth.looksLikeToken('a'.repeat(20) + '\n' + 'a'.repeat(19)), false)
})

test('the token page asks for exactly the two permissions the job needs', () => {
  const u = new URL(auth.TOKEN_URL)
  const keys = JSON.parse(decodeURIComponent(u.searchParams.get('permissionGroupKeys')))
  assert.deepEqual(keys, [{ key: 'zone', type: 'edit' }, { key: 'dns_records', type: 'edit' }])
  // Zone edit is what creates the zone; anything less and POST /zones is a 403.
  assert.ok(keys.some((k) => k.key === 'zone' && k.type === 'edit'))
})

test('an environment variable beats what was stored last time', async () => {
  const had = process.env.CF_API_TOKEN
  process.env.CF_API_TOKEN = 'e'.repeat(40)
  try {
    const r = await auth.findToken()
    assert.equal(r.token, 'e'.repeat(40))
    assert.equal(r.from, 'CF_API_TOKEN')
  } finally {
    if (had === undefined) delete process.env.CF_API_TOKEN
    else process.env.CF_API_TOKEN = had
  }
})

test('the keychain round-trips, and forgetting actually forgets', async (t) => {
  const canary = 'k'.repeat(40)
  const before = await auth.keychainGet()
  if (before) return t.skip('a real token is already stored — not touching it')

  try {
    await auth.keychainSet(canary)
  } catch {
    return t.skip('no keychain access in this environment')
  }
  assert.equal(await auth.keychainGet(), canary, 'what went in did not come back')
  await auth.keychainClear()
  assert.equal(await auth.keychainGet(), null, 'clearing left it behind')
})

test('the clipboard watcher takes a token and leaves everything else alone', async (t) => {
  const pbcopy = async (s) => {
    const p = execFile('/usr/bin/pbcopy')
    p.stdin.end(s)
    await new Promise((r) => p.on('close', r))
  }
  const original = await auth.clipboard().catch(() => null)
  if (original === null) return t.skip('no clipboard here')

  try {
    await pbcopy('some notes the founder had copied earlier')
    const token = 'z'.repeat(40)

    // The token lands a moment after the watcher starts, as it would in life.
    const watching = auth.waitForTokenOnClipboard({ seconds: 6, validate: async () => ({ ok: true, note: 'valid' }) })
    setTimeout(() => pbcopy('a password, copied by mistake'), 300)
    setTimeout(() => pbcopy(token), 900)

    const got = await watching
    assert.equal(got.token, token, 'the token was not picked up')
  } finally {
    await pbcopy(original)
  }
})

test('a token Cloudflare rejects is not accepted just because it is the right shape', async (t) => {
  const pbcopy = async (s) => {
    const p = execFile('/usr/bin/pbcopy')
    p.stdin.end(s)
    await new Promise((r) => p.on('close', r))
  }
  const original = await auth.clipboard().catch(() => null)
  if (original === null) return t.skip('no clipboard here')

  try {
    await pbcopy('starting point')
    const watching = auth.waitForTokenOnClipboard({
      seconds: 3,
      validate: async () => ({ ok: false, note: 'Cloudflare rejected this token' }),
      onTick: () => {},
    })
    setTimeout(() => pbcopy('y'.repeat(40)), 300)
    const got = await watching
    assert.ok(!got.token, 'a rejected token was returned anyway')
  } finally {
    await pbcopy(original)
  }
})

// --------------------------------------------------------- minting a token

// POST /user/tokens takes bearer auth, so a credential holding User → API
// Tokens → Write can mint others. It does not remove the browser — Cloudflare
// requires the first token be dashboard-minted either way — but it means the
// credential actually in flight during a run is one that expires in an hour
// and is deleted at the end.
const withFetch = async (handler, fn) => {
  const real = globalThis.fetch
  globalThis.fetch = handler
  try { return await fn() } finally { globalThis.fetch = real }
}
const reply = (body, ok = true) => new Response(JSON.stringify({ success: ok, result: body }), {
  status: ok ? 200 : 403, headers: { 'content-type': 'application/json' },
})

const GROUPS = [
  { id: 'grp-zone-write', name: 'Zone Write', scopes: ['com.cloudflare.api.account'] },
  { id: 'grp-dns-write', name: 'DNS Write', scopes: ['com.cloudflare.api.account.zone'] },
  { id: 'grp-zone-read', name: 'Zone Read', scopes: ['com.cloudflare.api.account'] },
]

test('the minted token is scoped, time-boxed, and asks for the two groups it needs', async () => {
  let sent = null
  const got = await withFetch(async (url, opts) => {
    if (String(url).includes('permission_groups')) return reply(GROUPS)
    if (String(url).endsWith('/user/tokens') && opts.method === 'POST') {
      sent = JSON.parse(opts.body)
      return reply({ id: 'tok-1', value: 'v'.repeat(40) })
    }
    throw new Error('unexpected call: ' + url)
  }, () => auth.mintEphemeral('r'.repeat(40), 'acct-123', { hours: 1 }))

  assert.equal(got.id, 'tok-1')
  assert.equal(got.token, 'v'.repeat(40))

  assert.deepEqual(sent.policies[0].permission_groups, [{ id: 'grp-zone-write' }, { id: 'grp-dns-write' }])
  assert.deepEqual(Object.keys(sent.policies[0].resources), ['com.cloudflare.api.account.acct-123'])

  // Time-boxed, and in the future. A token minted without an expiry is just a
  // second permanent credential with extra steps.
  assert.ok(sent.expires_on, 'no expiry was set')
  const secondsOut = (Date.parse(sent.expires_on) - Date.now()) / 1000
  assert.ok(secondsOut > 3000 && secondsOut < 3900, `expiry was ${secondsOut}s out`)
})

test('a credential that cannot mint returns null rather than failing the run', async () => {
  // The normal case. Most tokens do not carry API Tokens Write, and the run
  // must carry on with what it has instead of stopping.
  const denied = await withFetch(async () => reply(null, false),
    () => auth.mintEphemeral('r'.repeat(40), 'acct-123'))
  assert.equal(denied, null)

  // Present but missing a group it needs — also null, not a half-scoped token.
  const partial = await withFetch(async (url) => {
    if (String(url).includes('permission_groups')) return reply([GROUPS[2]])
    throw new Error('should not have tried to mint')
  }, () => auth.mintEphemeral('r'.repeat(40), 'acct-123'))
  assert.equal(partial, null)
})

test('revoking uses the root credential, not the token being deleted', async () => {
  let sawAuth = null
  let sawUrl = null
  const ok = await withFetch(async (url, opts) => {
    sawUrl = String(url)
    sawAuth = opts.headers.authorization
    return reply({ id: 'tok-1' })
  }, () => auth.revokeToken('r'.repeat(40), 'tok-1'))

  assert.equal(ok, true)
  assert.equal(sawUrl, 'https://api.cloudflare.com/client/v4/user/tokens/tok-1')
  assert.equal(sawAuth, 'Bearer ' + 'r'.repeat(40), 'the ephemeral token cannot delete itself')
})

// ------------------------------------------- the two copy buttons on that page

test('incident: the curl example was copied instead of the token, and thrown away', () => {
  // Cloudflare's confirmation page puts a copy button on the token and another
  // on a curl command that tests it. The founder pressed the second. The value
  // was on the clipboard for the whole window, inside an Authorization header,
  // and the watcher rejected the string as "text" without looking in it.
  const tok = 'Zq7' + 'x'.repeat(37)
  const curl = 'curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \\\n'
    + `     -H "Authorization: Bearer ${tok}"`
  assert.equal(auth.tokenCandidate(curl).ok, false, 'the whole curl string is not a token')
  assert.equal(auth.extractToken(curl).value, tok, 'the token inside the curl example was missed again')

  // A bare token still comes back untouched, and says so.
  assert.equal(auth.extractToken(tok).value, tok)
  assert.equal(auth.extractToken(tok).from, 'the clipboard')
})

test('two different bearer tokens in one paste yields neither', () => {
  // Guessing which credential a person meant is worse than asking for it again.
  const two = `Bearer ${'a'.repeat(40)} ... Bearer ${'b'.repeat(40)}`
  assert.equal(auth.extractToken(two).value, null)
  // The same token twice is not ambiguous.
  const same = `Bearer ${'a'.repeat(40)} ... Bearer ${'a'.repeat(40)}`
  assert.equal(auth.extractToken(same).value, 'a'.repeat(40))
})

test("another vendor's key inside prose is still not sent to Cloudflare", () => {
  assert.equal(auth.extractToken(`Authorization: Bearer sk-${'x'.repeat(40)}`).value, null)
})

test('incident: the token page was described as pre-ticked, and it is not', () => {
  // permissionGroupKeys is in TOKEN_URL and the dashboard ignores it. A run was
  // lost to a token created with Zone:Edit and no DNS:Edit, because the flow
  // said "three clicks" and never named the rows. Both rows are named now.
  const steps = auth.tokenSteps('example.com').join('\n')
  assert.match(steps, /Zone\s+·\s+Zone\s+·\s+Edit/, 'the Zone row is not named')
  assert.match(steps, /Zone\s+·\s+DNS\s+·\s+Edit/, 'the DNS row is not named - this is the one that was missed')
  assert.match(steps, /example\.com/, 'the zone resource does not name the domain')
  assert.equal(/three clicks/i.test(steps), false, 'the pre-ticked claim is back')
})
