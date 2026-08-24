// New-user setup: one command, three clicks, on whatever machine they have.
//
// The incidents pinned here both come from a plausible bootstrap script that
// was reviewed before it shipped. Neither is a typo; both read as correct.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import * as auth from '../scripts/lib/cf-auth.mjs'

// Incident 2026-08-24: this suite wrote to the founder's real pasteboard. Every
// clipboard read/write below goes to a private file instead.
import { mkdtempSync as _mkdtemp } from 'node:fs'
import { tmpdir as _tmpdir } from 'node:os'
import { join as _join } from 'node:path'
process.env.CF_CLIPBOARD_FILE = _join(_mkdtemp(_join(_tmpdir(), 'cf-clip-')), 'clipboard')

const run = promisify(execFile)

const withFetch = async (handler, fn) => {
  const real = globalThis.fetch
  globalThis.fetch = handler
  try { return await fn() } finally { globalThis.fetch = real }
}
const reply = (body, ok = true) => new Response(JSON.stringify({ success: ok, result: body }), {
  status: ok ? 200 : 403, headers: { 'content-type': 'application/json' },
})

test('incident: a token is never handed to `security` as an argument', async () => {
  // `security add-generic-password -w SECRET` puts the token in the process
  // argument list, where every user on the box can read it out of `ps` for as
  // long as the call runs. Measured: three matching lines. The value goes on
  // stdin instead, which means -w must be the last thing in the array.
  const src = await readFile(new URL('../scripts/lib/cf-auth.mjs', import.meta.url), 'utf8')
  assert.equal(/'-w',\s*token/.test(src), false, 'the token is back in argv where ps can read it')
  assert.ok(src.includes("'-U', '-w'\\]") || src.includes("'-U', '-w']"), 'expected -w with no value')
})

test('the keychain round-trips through stdin, so the stdin path actually works', async (t) => {
  // The security binary prompts twice for a password it did not get as an
  // argument. Feeding it once silently stores nothing, and looks identical.
  if ((await auth.platform()) !== 'macos') return t.skip('macOS keychain test')
  if (await auth.keychainGet()) return t.skip('a real token is already stored - not touching it')

  const canary = 'k'.repeat(40)
  try { await auth.keychainSet(canary) } catch { return t.skip('no keychain access here') }
  assert.equal(await auth.keychainGet(), canary, 'the store kept nothing, or kept half')
  await auth.keychainClear()
  assert.equal(await auth.keychainGet(), null)
})

test('incident: grading a token asks what it can do, not what tokens exist', async () => {
  // GET /user/tokens returns every token on the account. Grepping that listing
  // for "dns_records" answers a question about somebody else's token, so an
  // account with one powerful token would grade every weak token as powerful.
  // The only honest proof of minting is minting, so that is what is done.
  const listing = [
    { name: 'someone else, very powerful', policies: [{ permission_groups: [{ name: 'DNS Write' }, { name: 'API Tokens Write' }] }] },
  ]
  const seen = []
  const graded = await withFetch(async (url) => {
    const u = String(url)
    seen.push(u)
    if (u.includes('/user/tokens/verify')) return reply({ status: 'active' })
    if (u.includes('/accounts')) return reply([{ id: 'acct-1' }])
    if (u.includes('/zones')) return reply([{ name: 'example.com' }])
    if (u.includes('permission_groups')) return reply(null, false)   // no API Tokens Write
    if (u.endsWith('/user/tokens')) return reply(listing)             // the trap
    return reply(null, false)
  }, () => auth.capability('t'.repeat(40)))

  assert.equal(graded.valid, true)
  assert.equal(graded.canMint, false, 'another token on the account was mistaken for this one')
  assert.equal(seen.some((u) => u.endsWith('/user/tokens')), false, 'it read the account-wide token listing')
})

test('a token that can mint is graded by minting, and the probe is deleted again', async () => {
  const calls = []
  const graded = await withFetch(async (url, opts) => {
    const u = String(url)
    calls.push(`${opts?.method || 'GET'} ${u.replace('https://api.cloudflare.com/client/v4', '')}`)
    if (u.includes('/user/tokens/verify')) return reply({ status: 'active' })
    if (u.includes('/accounts')) return reply([{ id: 'acct-1' }])
    if (u.includes('/zones')) return reply([{ name: 'example.com' }])
    if (u.includes('permission_groups')) {
      return reply([
        { id: 'g1', name: 'Zone Write', scopes: ['com.cloudflare.api.account'] },
        { id: 'g2', name: 'DNS Write', scopes: ['com.cloudflare.api.account.zone'] },
      ])
    }
    if (u.endsWith('/user/tokens') && opts.method === 'POST') return reply({ id: 'probe', value: 'p'.repeat(40) })
    if (u.endsWith('/user/tokens/probe') && opts.method === 'DELETE') return reply({ id: 'probe' })
    throw new Error('unexpected ' + u)
  }, () => auth.capability('t'.repeat(40)))

  assert.equal(graded.canMint, true)
  // A probe left behind is a permanent credential created by a status check.
  assert.ok(calls.includes('DELETE /user/tokens/probe'), 'the probe token was not deleted')
})

test('no network is not a bad token', async () => {
  const graded = await withFetch(async () => { throw new TypeError('fetch failed') },
    () => auth.capability('t'.repeat(40)))
  assert.equal(graded.valid, false)
  assert.equal(graded.offline, true, 'an unreachable Cloudflare reads as a rejected credential')
})

test('the store is the best one the machine has, and says when it is not secure', async () => {
  const p = await auth.platform()
  assert.ok(['macos', 'linux', 'wsl', 'windows', 'unknown'].includes(p))

  const s = await auth.secretStore()
  assert.ok(['keychain', 'secret-tool', 'plaintext'].includes(s.kind))
  if (p === 'macos') assert.equal(s.kind, 'keychain', 'macOS fell back off the keychain')
  // A plaintext file is the absence of a store. It must never claim otherwise,
  // and it must say what to install to stop being the answer.
  if (s.kind === 'plaintext') {
    assert.equal(s.secure, false)
    assert.ok(s.hint, 'plaintext with no way out of it')
  } else {
    assert.equal(s.secure, true)
  }
})

test('a clipboard reader is found here, or its absence is actionable', async () => {
  const r = await auth.clipboardReader()
  if (r) {
    assert.ok(r.cmd, 'a reader with no command')
    assert.ok(Array.isArray(r.args))
    const out = await auth.clipboard()
    assert.equal(typeof out, 'string', 'reading the clipboard did not return text')
  } else {
    // No reader is allowed. Silently no reader is not: the flow falls back to
    // a hidden paste, and the user is told how to stop needing it.
    const fix = await auth.clipboardInstall()
    assert.ok(fix === null || /install/.test(fix))
  }
})

test('the full page asks for three permissions and the default asks for two', () => {
  const perms = (u) => JSON.parse(decodeURIComponent(new URL(u).searchParams.get('permissionGroupKeys')))
  const basic = perms(auth.TOKEN_URL)
  const full = perms(auth.TOKEN_URL_FULL)

  assert.deepEqual(basic.map((k) => k.key), ['zone', 'dns_records'])
  assert.deepEqual(full.map((k) => k.key), ['zone', 'dns_records', 'api_tokens'])
  // API Tokens Edit mints permissions, so it is never the default. If it ever
  // appears in the basic link, this fails.
  assert.equal(basic.some((k) => k.key === 'api_tokens'), false)
})

test('a team can share one name without editing code, and the old name still resolves', async () => {
  const read = async (env) => (await run(process.execPath, [
    '-e', "import('./scripts/lib/cf-auth.mjs').then(m => console.log(m.SERVICE))",
  ], { env: { ...process.env, CF_TOKEN_SERVICE: '', CF_TOKEN_TEAM: '', ...env } })).stdout.trim()

  assert.equal(await read({}), 'survival-stack-cloudflare-token', 'the default name changed - stored tokens went missing')
  assert.equal(await read({ CF_TOKEN_TEAM: 'acme' }), 'survival-stack-cloudflare-token-acme')
  assert.equal(await read({ CF_TOKEN_SERVICE: 'cf-root-token' }), 'cf-root-token')
})

test('--check reports the credential and never prints it', async () => {
  // The whole point of the clipboard path is that the value is never rendered.
  // A status line that helpfully echoes it undoes all of it in one character.
  const canary = 'Zq7canary000000000000000000000000000000x'
  assert.equal(canary.length, 40)
  const r = await run(process.execPath, ['scripts/cf-bootstrap.mjs', '--check'], {
    env: { ...process.env, CF_API_TOKEN: canary },
  }).catch((e) => e)
  const out = String(r.stdout || '') + String(r.stderr || '')

  assert.ok(out.includes('Cloudflare bootstrap'), 'it did not run')
  assert.equal(out.includes(canary), false, 'the credential was printed')
  // --check answers a question. It must not open a browser to do it.
  assert.equal(/Continue to summary/.test(out), false, '--check started the interactive flow')
})

test('incident: a token copied before the tool started was waited for anyway', async () => {
  // The watcher used to snapshot the clipboard and exclude it, so copying the
  // token first - the obvious thing to do - meant waiting out the whole window
  // for a copy that had already happened. Nothing was printed while it waited.
  const writeClip = async (s) => {
    const w = await auth.clipboardWriter()
    const p = execFile(w.cmd, w.args)
    p.stdin.end(s)
    await new Promise((r) => p.on('close', r))
  }
  const original = await auth.clipboard().catch(() => null)
  if (original === null) return t?.skip?.('no clipboard here')

  try {
    const already = 'q'.repeat(44)
    await writeClip(already)
    const got = await auth.waitForTokenOnClipboard({
      seconds: 3,
      validate: async () => ({ ok: true, note: 'valid' }),
      onTick: () => {},
    })
    assert.equal(got.token, already, 'a token already on the clipboard was ignored')
  } finally {
    await writeClip(original)
  }
})
