// What a migration is allowed to tell the outside world, and what it is never
// allowed to tell it.
//
// Every test here comes from a defect in a notification module that was
// reviewed and read as correct: it aborted the migration when the webhook was
// down, and it put the shared secret in a header on every request.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notify, sign, verify, redact, formatTelegram } from '../scripts/lib/notify.mjs'

const BOT = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11'
const SECRET = 'shared-secret-for-hmac-verification'
const URL_ = 'https://ops.example.com/hooks/migration'

const EVENT = {
  event: 'migration.phase_complete',
  domain: 'mumchimp.com', phase: 'verify', status: 'identical', records: 8,
}

// A run with both channels on, a fetch under our control, and stderr captured.
const run = async (payload, { fetchImpl, env = {}, timeoutMs } = {}) => {
  const logged = []
  const out = await notify(payload, {
    env: { OPS_WEBHOOK_URL: URL_, OPS_WEBHOOK_SECRET: SECRET, ...env },
    fetchImpl,
    timeoutMs,
    log: (m) => logged.push(m),
  })
  return { out, logged: logged.join('\n') }
}

const ok = async () => new Response('{}', { status: 200 })

test('incident: a notification failure took the migration down with it', async () => {
  // The reviewed module had no try/catch and no timeout. An ops portal that
  // was merely down turned into an unhandled rejection in the middle of a
  // cutover. The tool must survive every way a remote host can fail.
  const ways = {
    'connection refused': async () => { throw new TypeError('fetch failed') },
    'a 500': async () => new Response('upstream exploded', { status: 500 }),
    'a 401': async () => new Response('nope', { status: 401 }),
    'garbage that is not a Response': async () => null,
  }
  for (const [why, fetchImpl] of Object.entries(ways)) {
    const { out } = await run(EVENT, { fetchImpl })
    assert.equal(out.webhook, 'failed', `${why}: reported as sent`)
  }
})

test('a hung endpoint is abandoned, not waited on', async () => {
  const hang = () => new Promise((_, rej) => {
    // Mirror what fetch does with an aborted signal, without a real socket.
    setTimeout(() => rej(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), 5)
  })
  const { out, logged } = await run(EVENT, { fetchImpl: hang, timeoutMs: 10 })
  assert.equal(out.webhook, 'failed')
  assert.match(logged, /no answer in|failed/)
})

test('incident: the shared secret was sent in a header on every request', async () => {
  // `X-Migration-Secret: <the secret>` is not HMAC verification. It hands the
  // secret to whoever receives one request, and to anyone the URL is wrong
  // about. What goes on the wire is a signature over the body, never the key.
  let seen = null
  await run(EVENT, { fetchImpl: async (url, opts) => { seen = { url, ...opts }; return ok() } })

  const wire = JSON.stringify(seen)
  assert.equal(wire.includes(SECRET), false, 'the shared secret is on the wire')
  assert.ok(seen.headers['x-migration-signature'].startsWith('sha256='))
  assert.ok(seen.headers['x-migration-timestamp'], 'no timestamp, so the request replays forever')
})

test('the signature covers the exact bytes sent, and a replay is refused', async () => {
  let seen = null
  await run(EVENT, { fetchImpl: async (url, opts) => { seen = opts; return ok() } })

  const ts = seen.headers['x-migration-timestamp']
  const sig = seen.headers['x-migration-signature'].replace('sha256=', '')
  const now = Number(ts) * 1000

  assert.equal(verify(seen.body, SECRET, ts, sig, { now }), true, 'an honest request did not verify')
  assert.equal(verify(seen.body + ' ', SECRET, ts, sig, { now }), false, 'a tampered body verified')
  assert.equal(verify(seen.body, 'wrong-key', ts, sig, { now }), false, 'any key verified')
  // Yesterday's captured request, replayed today.
  assert.equal(verify(seen.body, SECRET, ts, sig, { now: now + 3600_000 }), false, 'a replay verified')
})

test('property: no configured secret ever reaches what this module prints', async () => {
  // Every string a remote host controls is a place a secret can come back:
  // Telegram puts the bot token in the URL, and an error cause can carry it.
  const env = { TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: '99', OPS_WEBHOOK_URL: URL_, OPS_WEBHOOK_SECRET: SECRET }
  const nasty = [
    `fetch failed for https://api.telegram.org/bot${BOT}/sendMessage`,
    `401 unauthorized: your secret ${SECRET} is wrong`,
    `could not reach ${URL_}`,
  ]
  for (const message of nasty) {
    const { logged } = await run(EVENT, {
      env, fetchImpl: async () => { throw new Error(message) },
    })
    for (const secret of [BOT, SECRET, URL_]) {
      assert.equal(logged.includes(secret), false, `a secret was printed: ${message.slice(0, 30)}`)
    }
  }
  // And a bot token that did not come from this process's environment.
  assert.equal(redact('GET /bot777:AAH-xyz/sendMessage', {}).includes('777:AAH-xyz'), false)
})

test('a failing notification never says it worked, and a working one never says it failed', async () => {
  const good = await run(EVENT, { fetchImpl: ok })
  assert.equal(good.out.webhook, 'sent')
  assert.equal(good.logged, '', 'a successful send printed something')
})

test('nothing configured sends nothing at all, and is not an error', async () => {
  let called = 0
  const out = await notify(EVENT, {
    env: {}, fetchImpl: async () => { called++; return ok() }, log: () => {},
  })
  assert.equal(called, 0, 'it called out with nothing configured')
  assert.deepEqual(out, { telegram: 'not configured', webhook: 'not configured' })
})

test('a webhook with no secret still sends, unsigned, and says nothing about a key', async () => {
  // Signing is the better path and it is not the only one. An internal endpoint
  // on a private network is a legitimate reason to have no shared secret.
  let seen = null
  await notify(EVENT, {
    env: { OPS_WEBHOOK_URL: URL_ },
    fetchImpl: async (url, opts) => { seen = opts; return ok() },
    log: () => {},
  })
  assert.equal('x-migration-signature' in seen.headers, false)
  assert.equal(JSON.parse(seen.body).domain, 'mumchimp.com')
})

test('the Telegram message escapes what a domain or an error can put in it', () => {
  // parse_mode is HTML, so an unescaped angle bracket is a broken message at
  // best. The error text is the one field an outsider writes.
  const text = formatTelegram({
    event: 'migration.phase_failed', domain: 'a<b>.com', phase: 'verify',
    status: 'blocked', error: '<script>x</script> & more',
  })
  assert.equal(text.includes('<script>'), false)
  assert.ok(text.includes('&lt;script&gt;'))
  assert.ok(text.includes('a&lt;b&gt;.com'))
})

test('incident: the Telegram path went around the injected fetch and hit the network', async () => {
  // Caught by this suite's own output: three "telegram sendMessage 401
  // Unauthorized" lines, from api.telegram.org, during a test run that claims
  // no network. src/telegram.js used the global fetch, so the injected one and
  // the timeout covered the webhook and nothing else - which means production
  // had no timeout on Telegram either.
  const real = globalThis.fetch
  let escaped = 0
  globalThis.fetch = async (...a) => { escaped++; return real(...a) }
  try {
    let injected = 0
    const out = await notify(EVENT, {
      env: { TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: '99' },
      fetchImpl: async () => { injected++; return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })) },
      log: () => {},
    })
    assert.equal(escaped, 0, 'the Telegram send went around the injected fetch')
    assert.equal(injected, 1, 'the Telegram send did not happen at all')
    assert.equal(out.telegram, 'sent')
  } finally { globalThis.fetch = real }
})

test('a hung Telegram is abandoned on the same timeout as the webhook', async () => {
  const out = await notify(EVENT, {
    env: { TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: '99' },
    fetchImpl: (url, opts) => new Promise((_, rej) =>
      opts.signal.addEventListener('abort', () => rej(opts.signal.reason))),
    timeoutMs: 20,
    log: () => {},
  })
  assert.equal(out.telegram, 'failed', 'a hung Telegram was reported as sent, or hung the run')
})

test('the signature is stable for the same bytes and different for different bytes', () => {
  assert.equal(sign('{"a":1}', SECRET, '100'), sign('{"a":1}', SECRET, '100'))
  assert.notEqual(sign('{"a":1}', SECRET, '100'), sign('{"a":2}', SECRET, '100'))
  assert.notEqual(sign('{"a":1}', SECRET, '100'), sign('{"a":1}', SECRET, '101'))
})
