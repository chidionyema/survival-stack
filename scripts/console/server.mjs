// The setup console. It exists because the terminal wizard it replaces asked
// eighteen questions in a fixed order, checked none of the answers until the
// end, and lost all of them when one step failed.
//
// This serves one page on the loopback interface and nothing else. Values live
// in this process's memory, go out over stdin to `wrangler secret put`, and are
// gone when the process exits. Nothing is written to disk, ever, including the
// generated TOTP secret.
import { createServer } from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as dnsp } from 'node:dns'
import * as check from './checks.mjs'
import * as zonelib from './zone.mjs'
import { isLoggedIn } from './checks.mjs'
import { base32Encode, verifyTotp } from '../../src/totp.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler')
const PORT = Number(process.env.SETUP_PORT || 8791)

// Any page in any tab can POST to a loopback port. The token in the URL is what
// stops a site you happen to be visiting from driving your setup.
const TOKEN = randomBytes(24).toString('hex')

// ------------------------------------------------------------------- state
// Secrets in here. Never logged, never serialised to the page, never on disk.
const secrets = {}
const state = {
  account: null,             // { id, name, email }
  login: { running: false, url: null, error: null },
  zones: [],
  zone: null,                // { id, name }
  migration: null,           // { domain, ns, oldNs, ready } once a move is proved
  recordId: null,
  telegram: { username: null, chatId: null },
  sshKeys: [],
  checks: {},                // field -> { ok, note }
  totp: { verified: false },
  applied: false,
}

secrets.TOTP_SECRET = base32Encode(randomBytes(20))
secrets.JWT_SECRET = randomBytes(32).toString('base64url')
secrets.TELEGRAM_WEBHOOK_SECRET = randomBytes(24).toString('base64url').slice(0, 32)

const otpauthUri = (label) =>
  `otpauth://totp/${encodeURIComponent(label)}?secret=${secrets.TOTP_SECRET}&issuer=Survival&digits=6&period=30`

// ------------------------------------------------------------------- helpers

function run(cmd, args, { input, timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const p = execFile(cmd, args, { cwd: ROOT, timeout, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}`, err }))
    if (input !== undefined) { p.stdin.write(input); p.stdin.end() }
  })
}

const HEX32 = /\b[0-9a-f]{32}\b/

async function whoami() {
  const r = await run(WRANGLER, ['whoami'], { timeout: 60000 })
  if (!isLoggedIn(r.out)) return null
  const id = r.out.match(HEX32)?.[0] || null
  const email = r.out.match(/email ([^\s.]+@[^\s.]+\.[^\s]+?)\.?$/m)?.[1] || null
  const row = r.out.split('\n').find((l) => l.includes(id))
  const name = row ? row.split('│').map((s) => s.trim()).filter(Boolean)[0] : null
  return id ? { id, name, email } : null
}

// ------------------------------------------------------------------- routes

const json = (res, obj, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

// What the page is allowed to know: whether each field is good, and what the
// service said about it. Not one character of any value.
const publicState = () => ({
  account: state.account,
  login: state.login,
  zones: state.zones,
  zone: state.zone,
  migration: state.migration,
  recordId: state.recordId,
  telegram: state.telegram,
  sshKeys: state.sshKeys,
  checks: state.checks,
  totp: state.totp,
  applied: state.applied,
})

const FIELD_CHECKS = {
  CF_API_TOKEN: async (v) => {
    const r = await check.checkCfToken(v)
    state.zones = r.zones || []
    return r
  },
  TELEGRAM_BOT_TOKEN: async (v) => {
    const r = await check.checkTelegramBot(v)
    state.telegram.username = r.username || null
    return r
  },
  HETZNER_TOKEN: async (v) => absorbKeys(await check.checkHetzner(v)),
  DIGITALOCEAN_TOKEN: async (v) => absorbKeys(await check.checkDigitalOcean(v)),
  VULTR_TOKEN: async (v) => absorbKeys(await check.checkVultr(v)),
  STRIPE_SECRET_KEY: (v) => check.checkStripe(v),
  R2_ACCESS_KEY: () => checkR2Pair(),
  R2_SECRET_KEY: () => checkR2Pair(),
}

function absorbKeys(r) {
  for (const k of r.keys || []) if (!state.sshKeys.includes(k)) state.sshKeys.push(k)
  return r
}

async function checkR2Pair() {
  if (!secrets.R2_ACCESS_KEY || !secrets.R2_SECRET_KEY) {
    return { ok: false, note: 'waiting for the other half' }
  }
  const r = await check.checkR2(state.account?.id, secrets.R2_ACCESS_KEY, secrets.R2_SECRET_KEY)
  state.checks.R2_ACCESS_KEY = r
  state.checks.R2_SECRET_KEY = r
  return r
}

async function handle(req, res, url, body) {
  const p = url.pathname

  if (p === '/api/state') return json(res, publicState())

  if (p === '/api/set') {
    const { field, value } = body
    if (typeof field !== 'string' || !/^[A-Z][A-Z0-9_]{2,40}$/.test(field)) {
      return json(res, { ok: false, note: 'unknown field' }, 400)
    }
    if (value === '') delete secrets[field]
    else secrets[field] = value
    const fn = FIELD_CHECKS[field]
    const result = value === '' ? { ok: false, note: 'cleared' } : fn ? await fn(value) : { ok: true, note: 'saved' }
    state.checks[field] = result
    return json(res, { ...result, state: publicState() })
  }

  // A plain value, not a secret: the domain, the images, the SSH key name.
  if (p === '/api/var') {
    const { name, value } = body
    if (!/^[A-Z][A-Z0-9_]{2,40}$/.test(String(name))) return json(res, { ok: false }, 400)
    secrets[name] = value
    state.checks[name] = { ok: !!value, note: value ? 'set' : 'empty' }
    return json(res, { ok: true, state: publicState() })
  }

  if (p === '/api/cf/whoami') {
    state.account = await whoami()
    if (state.account) state.login.running = false
    return json(res, publicState())
  }

  if (p === '/api/cf/login') {
    if (state.login.running) return json(res, publicState())
    state.login = { running: true, url: null, error: null }
    const child = spawn(WRANGLER, ['login'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    const grab = (buf) => {
      const m = String(buf).match(/https:\/\/dash\.cloudflare\.com\/oauth2\/auth\S+/)
      if (m) state.login.url = m[0]
    }
    child.stdout.on('data', grab)
    child.stderr.on('data', grab)
    child.on('exit', async () => {
      state.account = await whoami()
      state.login.running = false
      if (!state.account) state.login.error = 'the approval did not come back — press it again'
    })
    return json(res, publicState())
  }

  if (p === '/api/cf/zone') {
    const zone = state.zones.find((z) => z.name === body.zone)
    if (!zone) return json(res, { ok: false, note: 'not one of your zones' })
    state.zone = zone
    const r = await check.findOrCreateApex(secrets.CF_API_TOKEN, zone.id, zone.name)
    if (r.ok) { state.recordId = r.recordId; secrets.DOMAIN = zone.name }
    state.checks.DOMAIN = r
    return json(res, { ...r, state: publicState() })
  }

  // Moving a domain that is not on Cloudflare yet. The dashboard version of this
  // is add-a-site, wait for a scan, then check a guessed record list by eye. The
  // eye is the part that fails, and it fails on mail records, silently, for
  // about a week before anyone notices the bounces.
  if (p === '/api/domain/migrate') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    const say = (line, kind = 'step') => res.write(`data: ${JSON.stringify({ kind, line })}\n\n`)
    const done = (ok, line) => { res.write(`data: ${JSON.stringify({ kind: ok ? 'done' : 'fail', line })}\n\n`); res.end() }
    const domain = String(url.searchParams.get('domain') || '').trim().toLowerCase()
    try {
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return done(false, 'that does not look like a domain')
      if (!secrets.CF_API_TOKEN) return done(false, 'paste the Cloudflare token first')

      say(`reading ${domain} from the nameservers answering for it now`)
      const before = await zonelib.authoritativeServers(domain)
      say(`  ${before.names.join(', ')}`)
      const live = (await zonelib.readZone(domain, before.ips))
        .filter((r) => !(r.type === 'NS' && r.name === domain))
      for (const r of live) say('  ' + zonelib.key(r).slice(0, 90))
      if (!live.length) return done(false, 'nothing answered — check the spelling')

      let zone = await zonelib.findZone(secrets.CF_API_TOKEN, domain)
      if (zone) say(`the zone already exists on Cloudflare (${zone.status})`)
      else {
        const acct = (await zonelib.accountId(secrets.CF_API_TOKEN)) || state.account?.id
        if (!acct) return done(false, 'the token cannot see an account — it needs Account:Read too')
        say('creating the zone on Cloudflare')
        zone = await zonelib.createZone(secrets.CF_API_TOKEN, acct, domain)
        say('  waiting 20s for Cloudflare to run its own scan, as a second opinion')
        await new Promise((r) => setTimeout(r, 20000))
      }

      say('writing every record in, all grey-clouded')
      const w = await zonelib.writeRecords(secrets.CF_API_TOKEN, zone.id, live, (r) =>
        say(`  ${r.state === 'added' ? '+' : r.state === 'already there' ? '=' : '!'} ${r.type} ${r.name} ${r.state.startsWith('refused') ? r.state : ''}`))
      if (w.failed.length) return done(false, `${w.failed.length} record(s) refused — not safe to switch`)

      const fresh = await zonelib.findZone(secrets.CF_API_TOKEN, domain)
      const ns = (fresh.name_servers || []).map((s) => s.toLowerCase()).sort()
      const newIps = []
      for (const n of ns) for (const ip of await dnsp.resolve4(n).catch(() => [])) newIps.push(ip)

      say('asking both sets of nameservers the same questions')
      const d = await zonelib.compare(domain, before.ips, newIps)
      for (const k of d.missing) say('  MISSING on Cloudflare: ' + k.slice(0, 90), 'bad')
      if (!d.ready) return done(false, 'not identical yet — do not touch the registrar')
      say(`  identical, ${d.total} records answer the same on both sides`)

      state.migration = { domain, ns, oldNs: before.names, ready: true }
      state.zones = [...state.zones.filter((z) => z.name !== domain), { id: zone.id, name: domain }]
      const apex = await check.findOrCreateApex(secrets.CF_API_TOKEN, zone.id, domain)
      if (apex.ok) {
        state.recordId = apex.recordId
        secrets.DOMAIN = domain
        state.zone = { id: zone.id, name: domain }
        state.checks.DOMAIN = apex
      }
      return done(true, `done — now set the nameservers at your registrar to ${ns.join(' and ')}`)
    } catch (e) {
      return done(false, String(e.message || e))
    }
  }

  if (p === '/api/telegram/chat') {
    const r = await check.findChatId(secrets.TELEGRAM_BOT_TOKEN)
    if (r.ok) { state.telegram.chatId = r.chatId; secrets.TELEGRAM_CHAT_ID = r.chatId }
    state.checks.TELEGRAM_CHAT_ID = r
    return json(res, { ...r, state: publicState() })
  }

  if (p === '/api/totp/qr.png') {
    const label = secrets.DOMAIN ? `Survival (${secrets.DOMAIN})` : 'Survival Stack'
    const file = join(tmpdir(), `qr-${randomUUID()}.png`)
    const r = await run('/usr/bin/osascript', ['-l', 'JavaScript', join(ROOT, 'scripts', 'qr.js'),
      otpauthUri(label), file, '8'], { timeout: 20000 })
    try {
      const png = await readFile(file)
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(png)
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(`no QR: ${r.out.slice(0, 200)}`)
    } finally { unlink(file).catch(() => {}) }
    return
  }

  // The secret is shown once, to the person it belongs to, only if the QR could
  // not be drawn. Typing it is the fallback, not the plan.
  if (p === '/api/totp/manual') {
    return json(res, { secret: secrets.TOTP_SECRET })
  }

  if (p === '/api/totp/verify') {
    const matched = await verifyTotp(secrets.TOTP_SECRET, String(body.code || ''))
    state.totp.verified = matched !== null
    state.checks.TOTP_SECRET = state.totp.verified
      ? { ok: true, note: 'your phone and this stack agree on the time' }
      : { ok: false, note: 'that code does not match — check the clock on your phone' }
    return json(res, { ok: state.totp.verified, state: publicState() })
  }

  if (p === '/api/apply') return apply(res)

  if (p === '/api/quit') {
    json(res, { ok: true })
    setTimeout(() => process.exit(0), 200)
    return
  }

  res.writeHead(404); res.end('no')
}

// --------------------------------------------------------------------- apply

// Present is not the same as working. A token that was pasted wrong is still a
// string, and requiring only that it exists is how a broken credential reaches
// the deploy. Every one of these has to be green, not merely filled in.
const REQUIRED = {
  CF_API_TOKEN: 'the Cloudflare API token',
  DOMAIN: 'your domain',
  TOTP_SECRET: 'a code from your phone',
  TELEGRAM_BOT_TOKEN: 'the Telegram bot token',
  TELEGRAM_CHAT_ID: 'a message to your bot',
}

async function apply(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  })
  const say = (line, kind = 'step') => res.write(`data: ${JSON.stringify({ kind, line })}\n\n`)
  const done = (ok, line) => { res.write(`data: ${JSON.stringify({ kind: ok ? 'done' : 'fail', line })}\n\n`); res.end() }

  const missing = Object.entries(REQUIRED)
    .filter(([k]) => !secrets[k] || !state.checks[k]?.ok)
    .map(([, label]) => label)
  if (missing.length) return done(false, `not ready yet — still needs ${missing.join(', ')}`)
  if (!state.totp.verified) return done(false, 'the code from your phone has not been checked yet')

  try {
    say('creating the KV namespace')
    let kvId = null
    const made = await run(WRANGLER, ['kv', 'namespace', 'create', 'STATE'])
    kvId = made.out.match(HEX32)?.[0] || null
    if (!kvId) {
      const list = await run(WRANGLER, ['kv', 'namespace', 'list'])
      try {
        kvId = JSON.parse(list.out.slice(list.out.indexOf('['))).find((n) => n.title.endsWith('STATE'))?.id || null
      } catch { /* fall through to the error below */ }
    }
    if (!kvId) return done(false, `no KV namespace: ${made.out.trim().split('\n').pop()}`)
    say(`KV namespace ${kvId.slice(0, 8)}…`, 'ok')

    say('creating the two R2 buckets')
    await run(WRANGLER, ['r2', 'bucket', 'create', 'survival-audit'])
    await run(WRANGLER, ['r2', 'bucket', 'create', 'survival-data'])
    say('survival-audit and survival-data exist', 'ok')

    say('writing wrangler.jsonc')
    await patchConfig({
      kvId,
      DOMAIN: secrets.DOMAIN,
      R2_ENDPOINT: `https://${state.account.id}.r2.cloudflarestorage.com`,
      ...(secrets.ENGINE_IMAGE ? { ENGINE_IMAGE: secrets.ENGINE_IMAGE } : {}),
      ...(secrets.DB_BACKUP_IMAGE ? { DB_BACKUP_IMAGE: secrets.DB_BACKUP_IMAGE } : {}),
    })
    say('config filled in', 'ok')

    const toStore = ['TOTP_SECRET', 'JWT_SECRET', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_CHAT_ID', 'CF_API_TOKEN', 'CF_ZONE_ID', 'CF_DNS_RECORD_ID', 'HETZNER_TOKEN',
      'DIGITALOCEAN_TOKEN', 'VULTR_TOKEN', 'R2_ACCESS_KEY', 'R2_SECRET_KEY', 'STRIPE_SECRET_KEY',
      'DB_PASSWORD', 'SSH_KEY_NAME']
    secrets.CF_ZONE_ID = state.zone.id
    secrets.CF_DNS_RECORD_ID = state.recordId
    for (const name of toStore) {
      if (!secrets[name]) continue
      const r = await run(WRANGLER, ['secret', 'put', name], { input: secrets[name] })
      if (r.code !== 0) return done(false, `${name} was refused: ${r.out.trim().split('\n').pop()}`)
      say(`stored ${name}`, 'ok')
    }

    say('deploying the Worker')
    const dep = await run(WRANGLER, ['deploy'], { timeout: 300000 })
    const workerUrl = dep.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0]
    if (!workerUrl) return done(false, `deploy did not print a URL:\n${dep.out.slice(-600)}`)
    say(`deployed to ${workerUrl}`, 'ok')

    // CONTROL_URL is what a booting box calls back on. It is not knowable until
    // the first deploy has told us the hostname, so the second deploy is the
    // one that makes cold start work at all.
    say('telling the Worker its own address, and deploying again')
    await patchConfig({ CONTROL_URL: workerUrl })
    const dep2 = await run(WRANGLER, ['deploy'], { timeout: 300000 })
    if (dep2.code !== 0) return done(false, `second deploy failed:\n${dep2.out.slice(-600)}`)
    say('CONTROL_URL is live', 'ok')

    say('pointing Telegram at the Worker')
    const hook = await check.setWebhook(secrets.TELEGRAM_BOT_TOKEN, `${workerUrl}/telegram`,
      secrets.TELEGRAM_WEBHOOK_SECRET)
    if (!hook.body?.ok) return done(false, `Telegram refused the webhook: ${hook.body?.description}`)
    say('webhook set', 'ok')

    // The proof. Not "it should work" — a message that either arrives on the
    // phone or does not.
    say('sending you a message')
    const sent = await check.sendTelegram(secrets.TELEGRAM_BOT_TOKEN, secrets.TELEGRAM_CHAT_ID,
      `*Survival Stack is up.*\nControl plane: ${workerUrl}\nSend /status to check it.`)
    if (!sent.body?.ok) return done(false, `the message did not send: ${sent.body?.description}`)
    state.applied = true
    say('sent', 'ok')
    done(true, `Done. Check your phone, then send the bot /status. Control plane: ${workerUrl}`)
  } catch (e) {
    done(false, `stopped: ${e.message}`)
  }
}

async function patchConfig(values) {
  const path = join(ROOT, 'wrangler.jsonc')
  let text = await readFile(path, 'utf8')
  if (values.kvId) {
    text = text.replace(/("binding":\s*"STATE",\s*"id":\s*")[^"]*"/, `$1${values.kvId}"`)
  }
  for (const [k, v] of Object.entries(values)) {
    if (k === 'kvId' || v == null) continue
    const re = new RegExp(`("${k}":\\s*")[^"]*"`)
    if (!re.test(text)) throw new Error(`wrangler.jsonc has no ${k} to fill in`)
    text = text.replace(re, `$1${v}"`)
  }
  await writeFile(path, text)
}

// -------------------------------------------------------------------- server

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  // Three locks, because this process can store credentials and destroy nothing
  // it cannot rebuild: the token, the Host header, and a same-origin check on
  // anything that changes state.
  const tokenOk = url.searchParams.get('t') === TOKEN || req.headers['x-setup-token'] === TOKEN
  const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')
  const origin = req.headers.origin
  const originOk = !origin || origin === `http://127.0.0.1:${PORT}`
  if (!hostOk || !originOk) { res.writeHead(403); return res.end('not from here') }

  if (url.pathname === '/' && tokenOk) {
    const html = await readFile(join(HERE, 'page.html'), 'utf8')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(html.replace('__TOKEN__', TOKEN))
  }
  if (!tokenOk) { res.writeHead(403); return res.end('open the link the terminal printed') }

  let body = {}
  if (req.method === 'POST') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { body = {} } }
  }
  try {
    await handle(req, res, url, body)
  } catch (e) {
    if (!res.headersSent) json(res, { ok: false, note: e.message }, 500)
    else res.end()
  }
})

server.listen(PORT, '127.0.0.1', async () => {
  const link = `http://127.0.0.1:${PORT}/?t=${TOKEN}`
  // The link goes out before anything slow. `wrangler whoami` takes ten seconds
  // and printing after it means ten seconds of a terminal that looks hung.
  process.stdout.write(`\n  Setup console: ${link}\n\n`)
  // The test harness drives this with a headless browser and does not want a
  // window opening on somebody's desktop every time the suite runs.
  if (!process.env.SETUP_NO_OPEN) {
    spawn('/usr/bin/open', [link], { stdio: 'ignore', detached: true }).unref()
  }
  state.account = await whoami()
})

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e
  process.stderr.write(`\n  Port ${PORT} is busy — another setup console is already running.\n` +
    `  Close it, or start this one on a different port:  SETUP_PORT=8792 npm run secrets\n\n`)
  process.exit(1)
})
