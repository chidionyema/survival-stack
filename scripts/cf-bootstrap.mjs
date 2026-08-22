#!/usr/bin/env node
// One command, three clicks, and this machine can drive Cloudflare.
//
//   ./scripts/cf-bootstrap.sh            the two permissions the work needs
//   ./scripts/cf-bootstrap.sh --full     also API Tokens: Edit, so runs can
//                                        mint a one-hour token and revoke it
//   ./scripts/cf-bootstrap.sh --forget   remove the stored credential
//
// It never prints a token, never writes one to a file where a secret store
// exists, and refuses a credential belonging to another vendor before anything
// leaves the machine.
import * as auth from './lib/cf-auth.mjs'

const b = (s) => `\x1b[1m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const grn = (s) => `\x1b[32m${s}\x1b[0m`
const yel = (s) => `\x1b[33m${s}\x1b[0m`
const say = (s = '') => process.stdout.write(s + '\n')

const full = process.argv.includes('--full')
const forget = process.argv.includes('--forget')
const force = process.argv.includes('--force')
// --check answers "is this machine set up?" and never opens anything. It is
// what a script or a test asks, and what somebody asks before starting a
// migration they do not want to abandon halfway.
const checkOnly = process.argv.includes('--check')

const plat = await auth.platform()
const store = await auth.secretStore()

if (forget) {
  await auth.keychainClear()
  say(`Forgotten. ${auth.SERVICE} is no longer in ${store.name}.`)
  process.exit(0)
}

// ------------------------------------------------------- what is here already

say('')
say(b('Cloudflare bootstrap'))
say(dim(`  ${plat} - storing as ${auth.SERVICE} in ${store.name}`))
if (!store.secure) say(yel(`  no secret store on this machine - ${store.hint}`))

const found = await auth.findToken()
if (found.token && !force) {
  say(dim(`  a credential is already set (${found.from}) - checking what it can do`))
  const can = await auth.capability(found.token)
  if (can.valid) {
    say(grn('  it works.') + dim(` ${can.zones === null ? 'cannot list zones' : `${can.zones.length} zone(s) in scope`}`))
    say(can.canMint
      ? grn('  it can mint tokens, so every run gets a one-hour credential that is deleted at the end')
      : dim('  it cannot mint tokens - the work runs on this credential directly, which is fine'))
    say('')
    say('  Next: ' + b('node scripts/migrate-domain.mjs <your-domain> --watch'))
    say(dim('  To replace it: ./scripts/cf-bootstrap.sh --force'))
    process.exit(0)
  }
  say(red(can.offline
    ? '  cannot reach Cloudflare, so this credential cannot be checked'
    : '  the stored credential is no longer accepted by Cloudflare'))
  if (checkOnly) process.exit(1)
  say(dim('  replacing it'))
}
if (checkOnly) {
  say(red('  no credential on this machine.'))
  say(dim('  run ./scripts/cf-bootstrap.sh to get one'))
  process.exit(1)
}

// --------------------------------------------------------------- three clicks

const url = full ? auth.TOKEN_URL_FULL : auth.TOKEN_URL
say('')
say(b('  1.') + ' Continue to summary   ' + b('2.') + ' Create Token   ' + b('3.') + ' the copy button')
say('')
if (full) {
  say(dim('  --full: the page also asks for API Tokens: Edit. That permission can'))
  say(dim('  mint a token that does anything the account can do. Grant it knowingly.'))
}
const opened = await auth.openBrowser(url)
if (!opened) {
  say(yel('  could not open a browser. Open this:'))
  say('  ' + url)
}
say('')

const reader = await auth.clipboardReader()
let token = null

if (reader) {
  say(dim('  Nothing to paste and nothing to press. This watches the clipboard and'))
  say(dim('  hands whatever is copied to Cloudflare to be checked, saying either way.'))
  say('')
  const got = await auth.waitForTokenOnClipboard({
    seconds: Number(process.env.CF_TOKEN_WAIT || 1800),
    validate: (t) => auth.capability(t).then((c) => (c.valid ? { ok: true } : { ok: false, note: 'Cloudflare rejected it' })),
    onTick: (msg, left) => {
      if (msg) say(red('  ' + msg))
      else process.stdout.write(`\r  waiting for the copy... ${left}s   `)
    },
  })
  process.stdout.write('\r' + ' '.repeat(46) + '\r')
  token = got.token
} else {
  const install = await auth.clipboardInstall()
  say(yel('  no clipboard tool on this machine, so this one time it has to be pasted.'))
  if (install) say(dim(`  to skip this next time: ${install}`))
}

// ------------------------------------------------------------ graceful retry

// The clipboard path is the good one and it is not always available: a headless
// box, a locked-down Linux, an ssh session with no X. Falling through to a
// hidden paste is the difference between "works everywhere" and "works here".
if (!token) {
  if (!process.stdin.isTTY) {
    say(red('  nothing arrived and there is no terminal to paste into.'))
    say(dim('  set CF_API_TOKEN in the environment instead.'))
    process.exit(1)
  }
  token = await readHidden('  Paste the token (it will not echo): ')
}

if (!token) {
  say(red('  nothing supplied.'))
  process.exit(1)
}

// The vendor check runs before the token is sent anywhere. Validating means
// handing it to Cloudflare as a bearer token, and several other companies issue
// keys of exactly this shape.
const candidate = auth.tokenCandidate(token)
if (!candidate.ok) {
  say(red('  not sending that to Cloudflare: ' + candidate.why))
  process.exit(1)
}

// ------------------------------------------------------------- what it can do

say(dim('  asking Cloudflare what this credential can do'))
const can = await auth.capability(token)
if (!can.valid) {
  say(red(can.offline
    ? '  could not reach Cloudflare to check it, so nothing was stored.'
    : '  Cloudflare rejected it. Copy the whole token and run this again.'))
  process.exit(1)
}
if (can.zones === null) say(yel('  it cannot list zones - add Zone: Read, or zone lookups will fail'))
if (!can.accountId) say(yel('  it cannot see an account - add Account Settings: Read'))

const s = await auth.keychainSet(token)

// Round-trip, because storing is a claim about a keychain and reading it back
// is the fact. A store that silently kept nothing looks identical until the
// next run says "no credential found".
const back = await auth.keychainGet()
if (back !== token) {
  say(red(`  ${s.name} did not keep it. Nothing stored.`))
  process.exit(1)
}

say('')
say(grn(b('  Done.')) + ` stored in ${s.name}${s.secure ? '' : yel(' - plaintext, no secret store here')}`)
say(dim(`  ${can.zones === null ? 'zones: not readable' : `zones in scope: ${can.zones.length}`}`))
say(can.canMint
  ? dim('  ephemeral tokens: on. Each run mints one for an hour and deletes it at the end.')
  : dim('  ephemeral tokens: off. Runs use this credential directly.')
    + dim(' ./scripts/cf-bootstrap.sh --full --force to change that.'))
say('')
say('  Next: ' + b('node scripts/migrate-domain.mjs <your-domain> --watch'))
say(dim('  To remove it: ./scripts/cf-bootstrap.sh --forget'))
say('')

// Nothing is echoed, so a shoulder, a screen share and the scrollback all see
// the same thing: the prompt, and no characters after it.
function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    let buf = ''
    const done = (v) => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener('data', onData)
      process.stdout.write('\n')
      resolve(v)
    }
    const onData = (chunk) => {
      for (const ch of chunk) {
        const c = ch.charCodeAt(0)
        if (c === 13 || c === 10) return done(buf.trim())   // enter
        if (c === 3) return done('')                        // ctrl-c
        if (c === 127 || c === 8) { buf = buf.slice(0, -1); continue }
        buf += ch
      }
    }
    process.stdin.on('data', onData)
  })
}
