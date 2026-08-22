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

test('the token shape is strict enough to ignore a password on the clipboard', () => {
  assert.equal(auth.looksLikeToken('a'.repeat(40)), true)
  assert.equal(auth.looksLikeToken('Ab9_-'.repeat(8)), true)

  for (const junk of [
    '', ' ', 'hunter2', 'a'.repeat(39), 'a'.repeat(41),
    'https://example.com/something/quite/long/indeed/x',
    'correct horse battery staple and then some more!!',
    'a'.repeat(20) + '@' + 'a'.repeat(19),          // an email-ish thing
  ]) {
    assert.equal(auth.looksLikeToken(junk), false, `${JSON.stringify(junk.slice(0, 20))} was taken for a token`)
  }
})

test("another vendor's key is never sent to Cloudflare to be checked", () => {
  // Checking a candidate means handing it to Cloudflare as a bearer token.
  // Several vendors issue keys of exactly this shape, so a stray copy would
  // otherwise leak one secret to an unrelated company. These stop at the door.
  for (const prefix of ['sk-', 'sk_', 'pk_', 'ghp_', 'xoxb-', 'AKIA', 'AIza', 'hf_', 'glpat-', 'dop_v1_', 'SG.', 'npm_']) {
    const key = (prefix + 'x'.repeat(40)).slice(0, 40)
    assert.equal(key.length, 40)
    assert.equal(auth.looksLikeToken(key), false, `a ${prefix}… key would have been sent to Cloudflare`)
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
