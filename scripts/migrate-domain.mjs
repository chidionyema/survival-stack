#!/usr/bin/env node
// Move a domain onto Cloudflare without opening a dashboard.
//
//   CF_API_TOKEN=... node scripts/migrate-domain.mjs mumchimp.com
//   CF_API_TOKEN=... node scripts/migrate-domain.mjs mumchimp.com --watch
//
// It reads the zone off the nameservers currently answering for it, creates the
// Cloudflare zone, writes every record in, asks both sets of nameservers the
// same questions, and refuses to print the go-ahead unless the answers match.
//
// The only step it cannot do is the registrar. 123-reg has no public API for a
// retail account, so the last move is two strings pasted into one form. It
// prints them, and with --watch it waits and tells you when the change lands.
import { readFile } from 'node:fs/promises'
import * as z from './console/zone.mjs'

const b = (s) => `\x1b[1m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const grn = (s) => `\x1b[32m${s}\x1b[0m`
const say = (s = '') => process.stdout.write(s + '\n')

const domain = process.argv[2]
const watch = process.argv.includes('--watch')
const dryRun = process.argv.includes('--dry-run')

if (!domain || domain.startsWith('-')) {
  say('usage: CF_API_TOKEN=... node scripts/migrate-domain.mjs <domain> [--watch] [--dry-run]')
  process.exit(2)
}

async function token() {
  const env = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN
  if (env) return env
  // A token in a file beats a token in a shell history.
  for (const f of ['.cf-token', `${process.env.HOME}/.cf-token`]) {
    const v = await readFile(f, 'utf8').catch(() => null)
    if (v?.trim()) return v.trim()
  }
  return null
}

const T = await token()
if (!T && !dryRun) {
  say(red('No Cloudflare token.'))
  say('')
  say('  One click makes one, already ticked:')
  say('  ' + b('https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22dns_records%22%2C%22type%22%3A%22edit%22%7D%5D&name=Survival+Stack&accountId=*&zoneId=*'))
  say('')
  say('  Then:  echo "PASTE" > ~/.cf-token && chmod 600 ~/.cf-token')
  say('  Then:  node scripts/migrate-domain.mjs ' + domain + ' --watch')
  process.exit(1)
}

// ---------------------------------------------------------------- 1. read it

say('')
say(b(`Reading ${domain} from the nameservers answering for it now`))
const before = await z.authoritativeServers(domain)
say(`  ${before.names.join(', ')}`)
const live = await z.readZone(domain, before.ips)
const real = live.filter((r) => !(r.type === 'NS' && r.name === domain))
for (const r of real) say('  ' + dim(z.key(r).slice(0, 110)))
say(`  ${real.length} records`)

if (!real.some((r) => r.type === 'MX')) say(red('  no MX — if this domain takes mail, the sweep missed it. Stop.'))

if (dryRun) { say(''); say('--dry-run: nothing was created.'); process.exit(0) }

// -------------------------------------------------------------- 2. create it

say('')
say(b('Cloudflare'))
let zone = await z.findZone(T, domain)
if (zone) {
  say(`  zone already exists (${zone.status})`)
} else {
  const acct = await z.accountId(T)
  if (!acct) { say(red('  the token cannot read an account — it needs Account:Read as well')); process.exit(1) }
  zone = await z.createZone(T, acct, domain)
  say(`  zone created (${zone.status})`)
  say(dim('  waiting for its own scan, as a second opinion on the record list'))
  await new Promise((r) => setTimeout(r, 20000))
}

// --------------------------------------------------- 3. two guessers compared

const cfNow = await z.allRecords(T, zone.id)
const cfKeys = new Set(cfNow
  .filter((r) => r.type !== 'NS')
  .map((r) => z.key({ name: r.name, type: r.type, content: String(r.content).replace(/\.$/, ''), priority: r.priority ?? undefined })))
const mine = new Set(real.map(z.key))
const onlyCf = [...cfKeys].filter((k) => !mine.has(k))
if (onlyCf.length) {
  say('')
  say(b("Cloudflare's scan found records this sweep did not:"))
  for (const k of onlyCf) say('  ' + k.slice(0, 110))
  say(dim('  they are kept. A name only one of two methods found is still a real name.'))
}

// --------------------------------------------------------------- 4. write it

say('')
say(b('Writing the records in, all grey-clouded'))
const res = await z.writeRecords(T, zone.id, real, (r) => {
  const mark = r.state === 'added' ? grn('+') : r.state === 'already there' ? dim('=') : red('!')
  say(`  ${mark} ${r.type.padEnd(5)} ${r.name.padEnd(38)} ${r.state === 'added' || r.state === 'already there' ? '' : r.state}`)
})
if (res.failed.length) { say(red(`  ${res.failed.length} refused — not safe to switch`)); process.exit(1) }

// -------------------------------------------------------------- 5. prove it

const newNs = (zone.name_servers || (await z.findZone(T, domain)).name_servers || []).map((s) => s.toLowerCase()).sort()
say('')
say(b('Asking both sets of nameservers the same questions'))
const newIps = []
for (const n of newNs) for (const ip of await (await import('node:dns')).promises.resolve4(n).catch(() => [])) newIps.push(ip)
const d = await z.compare(domain, before.ips, newIps)
say(`  ${d.total} records asked for on the old side`)
if (d.missing.length) { for (const k of d.missing) say(red('  missing on Cloudflare: ') + k.slice(0, 100)) }
for (const k of d.extra) say(dim('  extra on Cloudflare:   ') + k.slice(0, 100))

say('')
if (!d.ready) {
  say(red(b('NOT READY. Do not touch the registrar.')))
  say('  Every line above marked missing has to be there first.')
  process.exit(1)
}
say(grn(b('Identical. Cloudflare answers exactly as the old nameservers do.')))

// ----------------------------------------------------------- 6. the one step

say('')
say(b('Your one step, at 123-reg — nowhere else'))
say('  https://www.123-reg.co.uk/secure/cpanel/domain/' + domain + '/manage-nameservers')
say('  Replace the two nameservers with:')
say('')
for (const n of newNs) say('    ' + b(n))
say('')
say(dim('  Nothing else changes. Every record above already answers identically,'))
say(dim('  so the shop and the mail carry on through the switch. To undo: put'))
say(dim(`  ${before.names.join(' and ')} back.`))

if (!watch) { say(''); say(dim('  Run again with --watch and it will tell you when the change lands.')); process.exit(0) }

// -------------------------------------------------------------- 7. wait for it

say('')
say(b('Watching for the registrar change. Ctrl-C to stop.'))
const want = newNs.join(',')
for (let i = 0; i < 720; i++) {
  const now = await z.nameserversNowServing(domain)
  if (now.join(',') === want) {
    say('')
    say(grn(b('Live on Cloudflare.')) + ` ${domain} is answered by ${newNs.join(' and ')}.`)
    const post = await z.compare(domain, newIps, newIps)
    say(`  ${post.total} records still answering.`)
    process.exit(0)
  }
  process.stdout.write(`\r  ${new Date().toISOString().slice(11, 19)}  still ${now.join(', ') || 'unresolved'}   `)
  await new Promise((r) => setTimeout(r, 60000))
}
