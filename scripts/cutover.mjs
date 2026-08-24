#!/usr/bin/env node
// Move mumchimp.com off whatever is serving it today, onto a box you name by IP.
//
//   node scripts/cutover.mjs --show                 what the zone says right now
//   node scripts/cutover.mjs --to 1.2.3.4 --dry-run every API call, none of them made
//   node scripts/cutover.mjs --to 1.2.3.4           do it
//   node scripts/cutover.mjs --rollback             put back exactly what was there
//
// WHY THIS EXISTS. Everything else in the estate could be moved between providers except the
// four seconds that actually decide who serves the customer. `src/dns.js` does this from inside
// the Worker, which is right for automatic failover and useless for a planned migration you are
// standing over. `scripts/dns-diff.sh` reads. Nothing wrote, so every cutover plan on this estate
// ended with the sentence "then repoint DNS" and no way to do it.
//
// IT IS NOT ABOUT ANY ONE PROVIDER. It takes an IP. A box is a box.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findToken } from './lib/cf-auth.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const API = process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4'

const DOMAIN = process.env.CUTOVER_DOMAIN || 'mumchimp.com'
const ZONE = process.env.CF_ZONE_ID || 'f52b061676b12e4650d87d3ce57d4896'
const ROLLBACK = join(ROOT, '.migration', `${DOMAIN}.rollback.json`)

// The names a customer resolves. Everything else in the zone -- MX, SPF, DKIM, DMARC -- is mail,
// and mail is not moving. A cutover that touches an MX record takes the business's email down
// alongside its website, which is how a bad hour becomes a bad week.
const SERVING = [DOMAIN, `www.${DOMAIN}`, `api.${DOMAIN}`]

let DRY = false
let FORCE = false

// --------------------------------------------------------------------------- cloudflare

async function cf(token, path, init = {}) {
  if (DRY && init.method && init.method !== 'GET') {
    console.log(`   [dry-run] ${init.method} ${path}  ${init.body || ''}`)
    return { id: 'dry-run', content: JSON.parse(init.body || '{}').content }
  }
  const res = await fetch(API + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const json = await res.json().catch(() => ({ success: false }))
  if (!json.success) {
    throw new Error(`cloudflare ${init.method || 'GET'} ${path}: ${JSON.stringify(json.errors ?? json)}`)
  }
  return json.result
}

const records = (token) => cf(token, `/zones/${ZONE}/dns_records?per_page=100`)

// Only the records that decide who serves. Sorted so the printed order is stable.
const serving = (all) =>
  all
    .filter((r) => SERVING.includes(r.name) && ['A', 'AAAA', 'CNAME'].includes(r.type))
    .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))

// --------------------------------------------------------------------------- the probe

// A cutover onto a box that is not serving is an outage you caused on purpose. So ask the box,
// with the Host header it will actually receive, before touching anything.
//
// It asks over plain HTTP on port 80. The box will not hold a certificate for these names until
// it owns the DNS record, which it cannot do until this script runs -- so requiring HTTPS here
// would make the guard unsatisfiable, and an unsatisfiable guard is one everybody skips.
//
// CUTOVER_PROBE_BASE swaps the address the probe dials, exactly as CF_API_BASE swaps the API and
// LAB_ORIGIN_P1 swaps the origin in src/dns.js. It exists so the ALLOW half of this guard can be
// tested against a box that is genuinely answering, which is the half a fence usually ships
// without: on 2026-08-23 two guards on this estate refused correct work in one evening, both
// tested only on the case they were meant to refuse.
async function probe(ip, host) {
  const ctl = AbortSignal.timeout(10000)
  const base = process.env.CUTOVER_PROBE_BASE || `http://${ip}`
  try {
    const res = await fetch(`${base}/`, { headers: { host }, redirect: 'manual', signal: ctl })
    return { host, status: res.status, ok: res.status > 0 && res.status < 500 }
  } catch (e) {
    return { host, status: 0, ok: false, error: String(e.message || e) }
  }
}

// In parallel, so a box that is simply not there costs one timeout rather than three. That is
// also the difference between a 10-second wait and a 30-second one for the person standing over
// this command at the moment they are least patient.
async function probeAll(ip) {
  console.log(`\n== is ${ip} serving?`)
  const out = await Promise.all(SERVING.map((host) => probe(ip, host)))
  for (const r of out) {
    console.log(`   ${r.ok ? 'ok ' : '!! '} ${r.host.padEnd(24)} HTTP ${r.status}${r.error ? '  ' + r.error : ''}`)
  }
  return out
}

// --------------------------------------------------------------------------- commands

async function show(token) {
  const all = await records(token)
  console.log(`\n== ${DOMAIN}: ${all.length} records, ${serving(all).length} of them decide who serves\n`)
  for (const r of serving(all)) {
    console.log(`   ${r.name.padEnd(24)} ${r.type.padEnd(6)} ttl=${String(r.ttl).padEnd(5)} ${r.content}`)
  }
  const rb = await readFile(ROLLBACK, 'utf8').catch(() => null)
  if (rb) {
    const saved = JSON.parse(rb)
    console.log(`\n   a rollback point exists, taken ${saved.at}`)
    console.log(`   restore it with: node scripts/cutover.mjs --rollback`)
  }
  return 0
}

async function cutover(token, ip) {
  const all = await records(token)
  const before = serving(all)

  console.log(`\n== what is serving ${DOMAIN} today`)
  for (const r of before) console.log(`   ${r.name.padEnd(24)} ${r.type.padEnd(6)} ${r.content}`)

  const results = await probeAll(ip)
  const dead = results.filter((r) => !r.ok)
  if (dead.length && !FORCE) {
    console.error(
      `\n!! ${ip} did not answer for ${dead.map((d) => d.host).join(', ')}.\n` +
        `   Pointing the domain at it would take the shop down for as long as it takes to notice.\n` +
        `   Ship the stack to the box first, then run this again.\n` +
        `   If the box is genuinely fine and the probe is wrong, say so on purpose: --force`,
    )
    return 1
  }
  if (dead.length) console.log(`\n   !! --force given; proceeding with ${dead.length} host(s) not answering`)

  // The rollback point is written BEFORE anything changes, and it is written to disk rather than
  // held in this process. A cutover that fails halfway through leaves the zone in a state nobody
  // recorded, and the person fixing it at that moment is not in a position to reconstruct it.
  await mkdir(dirname(ROLLBACK), { recursive: true })
  const point = { domain: DOMAIN, at: new Date().toISOString(), to: ip, records: before }
  if (DRY) console.log(`\n   [dry-run] would write the rollback point to .migration/${DOMAIN}.rollback.json`)
  else {
    await writeFile(ROLLBACK, JSON.stringify(point, null, 2) + '\n')
    console.log(`\n   rollback point saved: .migration/${DOMAIN}.rollback.json`)
  }

  console.log(`\n== pointing ${DOMAIN} at ${ip}`)
  for (const r of before) {
    // AAAA IS THE ONE THAT BITES. Every v6-capable client prefers it, so an apex AAAA left
    // pointing at the old host means the cutover half-happened: some customers move, some do
    // not, and the ones who did not are invisible from here. A v4 address cannot go in an AAAA
    // record, so the honest move is to delete it and let the A record answer everybody.
    if (r.type === 'AAAA') {
      await cf(token, `/zones/${ZONE}/dns_records/${r.id}`, { method: 'DELETE' })
      console.log(`   deleted  ${r.name.padEnd(24)} AAAA  ${r.content}   (it would have kept v6 clients on the old host)`)
      continue
    }
    // A CNAME cannot be edited into an A record, so the pair is delete-then-create. The gap
    // between them is the only moment in this script where a name resolves to nothing, and it is
    // one API call wide.
    if (r.type === 'CNAME') {
      await cf(token, `/zones/${ZONE}/dns_records/${r.id}`, { method: 'DELETE' })
      await cf(token, `/zones/${ZONE}/dns_records`, {
        method: 'POST',
        body: JSON.stringify({ type: 'A', name: r.name, content: ip, proxied: false, ttl: 60 }),
      })
      console.log(`   replaced ${r.name.padEnd(24)} CNAME ${r.content}  ->  A ${ip}`)
      continue
    }
    // PUT, not PATCH. Both work against the real API, but PUT means "this record is now exactly
    // this", which is the intent here and leaves nothing of the old value behind by omission.
    await cf(token, `/zones/${ZONE}/dns_records/${r.id}`, {
      method: 'PUT',
      body: JSON.stringify({ type: 'A', name: r.name, content: ip, proxied: false, ttl: 60 }),
    })
    console.log(`   updated  ${r.name.padEnd(24)} A     ${r.content}  ->  ${ip}`)
  }

  if (DRY) {
    console.log(`\n== dry run complete -- ${DOMAIN} is unchanged`)
    return 0
  }

  const after = serving(await records(token))
  console.log(`\n== the zone now says`)
  for (const r of after) console.log(`   ${r.name.padEnd(24)} ${r.type.padEnd(6)} ttl=${String(r.ttl).padEnd(5)} ${r.content}`)
  console.log(
    `\n   TTL is 60s, so the world follows within a minute and a rollback lands just as fast.\n` +
      `   Undo everything: node scripts/cutover.mjs --rollback\n` +
      `   The old host is still running and still holds the data it held. Leave it up until a\n` +
      `   day of real orders has gone through the new one.`,
  )
  return 0
}

async function rollback(token) {
  const raw = await readFile(ROLLBACK, 'utf8').catch(() => null)
  if (!raw) {
    console.error(`!! no rollback point at .migration/${DOMAIN}.rollback.json -- nothing to restore`)
    return 1
  }
  const point = JSON.parse(raw)
  console.log(`\n== restoring ${DOMAIN} to what it was at ${point.at} (before the move to ${point.to})`)

  const now = serving(await records(token))
  for (const r of now) {
    await cf(token, `/zones/${ZONE}/dns_records/${r.id}`, { method: 'DELETE' })
    console.log(`   removed  ${r.name.padEnd(24)} ${r.type.padEnd(6)} ${r.content}`)
  }
  for (const r of point.records) {
    await cf(token, `/zones/${ZONE}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ type: r.type, name: r.name, content: r.content, proxied: r.proxied, ttl: r.ttl }),
    })
    console.log(`   restored ${r.name.padEnd(24)} ${r.type.padEnd(6)} ${r.content}`)
  }
  if (DRY) {
    console.log(`\n== dry run complete -- ${DOMAIN} is unchanged`)
    return 0
  }
  console.log(`\n== restored. ${point.records.length} records are back exactly as they were.`)
  return 0
}

// --------------------------------------------------------------------------- entry

async function main(argv) {
  let mode = null
  let ip = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') DRY = true
    else if (a === '--force') FORCE = true
    else if (a === '--show') mode = 'show'
    else if (a === '--rollback') mode = 'rollback'
    else if (a === '--to') {
      mode = 'cutover'
      ip = argv[++i]
    } else if (a === '-h' || a === '--help') mode = 'help'
    else {
      console.error(`unknown argument: ${a}`)
      return 2
    }
  }

  if (!mode || mode === 'help') {
    console.log(
      [
        `Move ${DOMAIN} onto a box you name by IP.`,
        ``,
        `  --show                what the zone says right now`,
        `  --to <ip>             point ${SERVING.join(', ')} at that box`,
        `  --rollback            put back exactly what was there before`,
        `  --dry-run             with --to or --rollback: print every call, make none`,
        `  --force               with --to: proceed even though the box did not answer`,
        ``,
      ].join('\n'),
    )
    return mode === 'help' ? 0 : 2
  }

  if (mode === 'cutover' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip || '')) {
    console.error(`!! --to needs an IPv4 address, got: ${ip ?? '<nothing>'}`)
    return 2
  }

  const { token, from } = await findToken()
  if (!token) {
    console.error(
      `!! no Cloudflare credential.\n` +
        `   Get one into the keychain once: ./scripts/cf-bootstrap.sh\n` +
        `   Or pass it for this run only: CF_API_TOKEN=... node scripts/cutover.mjs ...`,
    )
    return 1
  }
  console.log(`credential: ${from}`)

  if (mode === 'show') return show(token)
  if (mode === 'rollback') return rollback(token)
  return cutover(token, ip)
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`!! ${err.message || err}`)
    process.exit(1)
  })
