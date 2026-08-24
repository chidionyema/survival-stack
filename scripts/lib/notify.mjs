// Migration status, to a phone and to an ops portal.
//
// The one rule this file exists to keep: a notification can never fail the
// thing it is reporting on. A dead webhook, a revoked bot token, a hung
// endpoint and an unset variable all end the same way — the migration carries
// on and the reason is on stderr. Nothing here throws, and nothing here waits
// longer than the timeout.
//
// Telegram sending is not reimplemented. src/telegram.js already does it, takes
// its configuration as a plain object and already fails soft, so it is handed
// process.env plus a FETCH that carries this module's timeout.
import { createHmac, timingSafeEqual } from 'node:crypto'
import * as tg from '../../src/telegram.js'

export const EVENTS = [
  'migration.phase_start',
  'migration.phase_complete',
  'migration.phase_failed',
  'migration.cutover_ready',
  'migration.cutover_done',
  'migration.lockdown_done',
  'migration.rollback',
]

const ICON = {
  'migration.phase_start': '▶️',
  'migration.phase_complete': '✅',
  'migration.phase_failed': '❌',
  'migration.cutover_ready': '🔓',
  'migration.cutover_done': '🚀',
  'migration.lockdown_done': '🔒',
  'migration.rollback': '↩️',
}

// The env is read on every call, never captured at import. Capturing it at
// import is what makes a module untestable and what made CF_API_BASE a bug:
// the test sets the variable, the module already read the old one.
const cfg = (env) => ({
  botToken: env.TELEGRAM_BOT_TOKEN || null,
  chatId: env.TELEGRAM_CHAT_ID || null,
  webhookUrl: env.OPS_WEBHOOK_URL || null,
  webhookSecret: env.OPS_WEBHOOK_SECRET || null,
})

// Everything printed by this module goes through here first.
//
// A notification failure is reported by printing the failure, and the failure
// text is written by whoever is on the other end of the wire. Telegram puts the
// bot token in the URL, an ops portal can echo a request header back in its own
// error body, and `fetch` attaches the URL to some causes. So the secrets are
// removed from the string rather than trusted not to be in it.
export function redact(text, env = process.env) {
  let s = String(text ?? '')
  const secrets = [
    env.TELEGRAM_BOT_TOKEN, env.OPS_WEBHOOK_SECRET, env.OPS_WEBHOOK_URL,
    env.CF_API_TOKEN, env.TELEGRAM_WEBHOOK_SECRET,
  ].filter((v) => typeof v === 'string' && v.length >= 8)
  for (const v of secrets) s = s.split(v).join('[redacted]')
  // A bot token in a URL survives the loop above when it came from somewhere
  // other than this process's environment.
  return s.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, '/bot[redacted]')
}

export function formatTelegram(p) {
  const icon = ICON[p.event] || 'ℹ️'
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = [`${icon} <b>${esc(p.domain)}</b> — ${esc(p.phase || p.event)}`]
  if (p.status) lines.push(`Status: ${esc(p.status)}`)
  if (p.records !== undefined) lines.push(`Records: ${esc(p.records)}`)
  if (p.seconds !== undefined) lines.push(`Took: ${esc(p.seconds)}s`)
  if (p.error) lines.push(`Error: <code>${esc(redact(p.error))}</code>`)
  return lines.join('\n')
}

// The signature covers the exact bytes on the wire and a timestamp, so a
// captured request cannot be replayed tomorrow. The secret itself is never
// transmitted: a header carrying the shared secret hands it to whoever receives
// one request, and to anyone the URL is wrong about.
export function sign(body, secret, timestamp) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

// The other half, exported so an ops portal in this estate can verify without
// writing its own and getting the comparison wrong.
export function verify(body, secret, timestamp, signature, { now = Date.now(), toleranceMs = 300_000 } = {}) {
  if (!body || !secret || !timestamp || !signature) return false
  if (Math.abs(now - Number(timestamp) * 1000) > toleranceMs) return false
  const want = Buffer.from(sign(body, secret, timestamp), 'utf8')
  const got = Buffer.from(String(signature), 'utf8')
  if (want.length !== got.length) return false
  return timingSafeEqual(want, got)
}

async function postWebhook(payload, c, { env, fetchImpl, timeoutMs }) {
  const body = JSON.stringify({
    ...payload,
    timestamp: new Date().toISOString(),
    source: 'survival-stack/migrate-domain',
  })
  const headers = { 'content-type': 'application/json' }
  if (c.webhookSecret) {
    const ts = Math.floor(Date.now() / 1000).toString()
    headers['x-migration-timestamp'] = ts
    headers['x-migration-signature'] = `sha256=${sign(body, c.webhookSecret, ts)}`
  }
  const res = await fetchImpl(c.webhookUrl, {
    method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    // The status is the useful part. The response body is written by a remote
    // host and is not printed for that reason.
    return { ok: false, why: `ops webhook answered ${res.status}` }
  }
  return { ok: true }
}

// Never throws. Returns what happened to each channel so a caller can say so.
export async function notify(payload, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  log = (m) => process.stderr.write(m + '\n'),
} = {}) {
  const c = cfg(env)
  const out = { telegram: 'not configured', webhook: 'not configured' }

  const jobs = []
  if (c.botToken && c.chatId) {
    jobs.push((async () => {
      try {
        // Telegram goes through the same fetch and the same timeout as the
        // webhook. Measured: without this the module's own tests reached
        // api.telegram.org, which means production had no timeout on it either.
        const withTimeout = (url, opts = {}) =>
          fetchImpl(url, { ...opts, signal: opts.signal ?? AbortSignal.timeout(timeoutMs) })
        const id = await tg.send({ ...env, FETCH: withTimeout }, formatTelegram(payload))
        out.telegram = id ? 'sent' : 'failed'
      } catch (err) {
        out.telegram = 'failed'
        log(redact(`  telegram notify failed: ${err?.message || err}`, env))
      }
    })())
  }
  if (c.webhookUrl) {
    jobs.push((async () => {
      try {
        const r = await postWebhook(payload, c, { env, fetchImpl, timeoutMs })
        out.webhook = r.ok ? 'sent' : 'failed'
        if (!r.ok) log(redact('  ' + r.why, env))
      } catch (err) {
        out.webhook = 'failed'
        const why = err?.name === 'TimeoutError' ? `no answer in ${timeoutMs}ms` : (err?.message || String(err))
        log(redact(`  ops webhook notify failed: ${why}`, env))
      }
    })())
  }

  // AbortSignal.timeout's timer is unref'd. A fetch that only settles on abort
  // let the event loop drain first, so notify() never returned (CI run
  // 32764888678, "Promise resolution is still pending"). Hold the loop open.
  const hold = setTimeout(() => {}, timeoutMs)
  try { await Promise.all(jobs) } finally { clearTimeout(hold) }
  return out
}

// node scripts/lib/notify.mjs --test
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
    && process.argv.includes('--test')) {
  const c = cfg(process.env)
  if (!c.botToken && !c.webhookUrl) {
    process.stdout.write('Nothing is configured, so nothing was sent.\n'
      + '  Telegram: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID\n'
      + '  Ops portal: OPS_WEBHOOK_URL, and OPS_WEBHOOK_SECRET to sign it\n')
    process.exit(1)
  }
  const r = await notify({
    event: 'migration.phase_complete',
    domain: 'test.example.com', phase: 'verify', status: 'identical', records: 8, seconds: 45,
  })
  process.stdout.write(`telegram: ${r.telegram}\nops webhook: ${r.webhook}\n`)
  // A test that reports success when nothing arrived is worse than no test.
  process.exit(Object.values(r).includes('failed') ? 1 : 0)
}
