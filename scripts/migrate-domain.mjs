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
import * as z from './console/zone.mjs'
import * as auth from './lib/cf-auth.mjs'
import { checkCfToken } from './console/checks.mjs'

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

// Getting a credential, with nothing typed.
//
// `wrangler login` is the right pattern and the rest of this project uses it.
// It cannot be used here. Its OAuth client offers 27 scopes and the only zone
// one is `zone:read`; asking for `zone:edit` or `dns_records:edit` is refused
// by wrangler before the browser even opens. Creating a zone and writing a
// record need both. So this needs an API token, and the only thing left to
// remove is the typing.
async function getToken() {
  let { token: T, from } = await auth.findToken()
  if (T) { say(dim(`  credential from ${from}`)); return T }
  if (dryRun) return null

  say('')
  say(b('One-time Cloudflare authorisation'))
  say('')
  say('  Opening the token page. The permission boxes are already ticked.')
  say('  Press ' + b('Continue to summary') + ', then ' + b('Create Token') + ', then the copy button.')
  say('')
  say(dim('  Nothing to paste. While this is waiting it watches the clipboard for a'))
  say(dim('  40-character Cloudflare token and takes it the moment it appears. It'))
  say(dim('  ignores anything of another shape and never prints what it saw.'))
  say('')
  await auth.openBrowser(auth.TOKEN_URL)
  say(dim('  if the browser did not open: ' + auth.TOKEN_URL))
  say('')

  const got = await auth.waitForTokenOnClipboard({
    seconds: 300,
    validate: (t) => checkCfToken(t),
    onTick: (msg, left) => {
      if (msg) say(red('  ' + msg))
      else process.stdout.write(`\r  waiting for the copy… ${left}s   `)
    },
  })
  process.stdout.write('\r' + ' '.repeat(46) + '\r')
  if (!got.token) {
    say(red('  nothing arrived. Run it again, or set CF_API_TOKEN yourself.'))
    process.exit(1)
  }
  // Keychain, not a dotfile: locked with the login password, absent from
  // directory listings, backups and anything anyone pastes into a chat window.
  await auth.keychainSet(got.token)
  say(grn('  got it — ' + got.note + ', saved to your login keychain'))
  say(dim('  it will not ask again. To forget it: security delete-generic-password -s ' + auth.SERVICE))
  return got.token
}

const ROOT = await getToken()

// Check the credential before using it. Without this the first failure is
// whatever call happens to run first, and its error describes that call rather
// than the real problem — a junk token was reporting as a missing Account:Read
// permission, which sends you to the wrong page to fix the wrong thing.
if (ROOT) {
  const v = await checkCfToken(ROOT)
  if (!v.ok) {
    say(red(`Cloudflare will not accept this credential: ${v.note}`))
    say(dim('  to forget the stored one and start again:'))
    say(dim('    security delete-generic-password -s ' + auth.SERVICE))
    process.exit(1)
  }
  say(dim(`  ${v.note}`))
}

// If the stored credential can mint tokens, do not use it for the work. Mint
// one that dies in an hour, use that, and delete it on the way out — including
// on Ctrl-C, which is the exit path that actually happens.
let T = ROOT
let ephemeral = null
if (ROOT && !dryRun) {
  const id = await z.accountId(ROOT)
  if (id) {
    ephemeral = await auth.mintEphemeral(ROOT, id, { hours: 1 })
    if (ephemeral) {
      T = ephemeral.token
      say(dim(`  minted a token that expires ${ephemeral.expires} and is deleted when this finishes`))
    }
  }
}

const bail = async (code) => { await cleanUp(); process.exit(code) }

async function cleanUp() {
  if (!ephemeral) return
  const gone = await auth.revokeToken(ROOT, ephemeral.id)
  ephemeral = null
  say(dim(gone ? '  ephemeral token deleted' : '  could not delete the ephemeral token — it expires within the hour'))
}
process.on('exit', () => { if (ephemeral) process.stderr.write('\n  ephemeral token left to expire\n') })
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await cleanUp(); process.exit(130) })
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
  if (!acct) { say(red('  the token cannot read an account — it needs Account:Read as well')); await bail(1) }
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
if (res.failed.length) { say(red(`  ${res.failed.length} refused — not safe to switch`)); await bail(1) }

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
  await bail(1)
}
say(grn(b('Identical. Cloudflare answers exactly as the old nameservers do.')))
// Nothing past here calls Cloudflare — the watch loop only asks nameservers.
// So the credential goes back now rather than sitting live for the wait.
await cleanUp()

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

if (!watch) { say(''); say(dim('  Run again with --watch and it will tell you when the change lands.')); await bail(0) }

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
    await bail(0)
  }
  process.stdout.write(`\r  ${new Date().toISOString().slice(11, 19)}  still ${now.join(', ') || 'unresolved'}   `)
  await new Promise((r) => setTimeout(r, 60000))
}
