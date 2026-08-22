#!/usr/bin/env node
// One command, three clicks, and this machine can drive Cloudflare.
//
//   ./scripts/cf-bootstrap.sh            the two permissions the work needs
//   ./scripts/cf-bootstrap.sh --full     also API Tokens: Edit, so runs can
//                                        mint a one-hour token and revoke it
//   ./scripts/cf-bootstrap.sh --forget   remove the stored credential
//   ./scripts/cf-bootstrap.sh --stdin    type or pipe it in, never the clipboard
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
// --stdin never touches the clipboard. The watcher is the seamless path and it
// has a cost: between copying the token and this tool reading it, the credential
// is on the pasteboard, where every process running as this user can read it.
// Typing it, or piping it out of a password manager, skips that entirely.
const stdinOnly = process.argv.includes('--stdin')

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
    if (can.canWriteDns === false) {
      say(red('  but it cannot write DNS. Add Zone → DNS → Edit, then ./scripts/cf-bootstrap.sh --force'))
      process.exit(1)
    }
    say(dim('  DNS writes: ' + (can.canWriteDns === true ? 'yes'
      : 'not checkable yet - no zone in scope. The migration checks before it changes anything.')))
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
for (const line of auth.tokenSteps(process.env.CF_DOMAIN)) say(line ? '  ' + line : '')
say('')
if (full) {
  say(dim('  --full: the page also asks for API Tokens: Edit. That permission can'))
  say(dim('  mint a token that does anything the account can do. Grant it knowingly.'))
}
// A pipe means the token already exists somewhere, so the page that creates one
// is noise. Everything above still prints: it is the permission list, and it is
// what the value being piped in has to have.
const opened = process.stdin.isTTY ? await auth.openBrowser(url) : false
if (!opened && process.stdin.isTTY) {
  say(yel('  could not open a browser. Open this:'))
  say('  ' + url)
}
say('')

const reader = stdinOnly ? null : await auth.clipboardReader()
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
  // Read is not the same as taken. The token is still sitting on the pasteboard
  // and stays there until somebody copies something else, so it is overwritten
  // here rather than left for whatever reads the clipboard next.
  if (token) {
    say(dim(await auth.clipboardClear()
      ? '  clipboard cleared'
      : '  could not clear the clipboard - copy something else before you walk away'))
  }
} else if (stdinOnly) {
  say(dim('  --stdin: nothing is read from the clipboard.'))
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
  if (process.stdin.isTTY) {
    token = await readHidden('  Paste the token (it will not echo): ')
  } else {
    // A pipe is the best input there is: the value comes straight out of a
    // password manager and never lands on a clipboard, in a shell history or
    // in this process's argv.
    //   op read 'op://Private/Cloudflare/token' | ./scripts/cf-bootstrap.sh --stdin
    token = await readPipe()
    if (!token) {
      say(red('  nothing arrived on stdin and there is no terminal to paste into.'))
      say(dim('  pipe the token in, or set CF_API_TOKEN in the environment.'))
      process.exit(1)
    }
    say(dim('  read from stdin'))
  }
}

if (!token) {
  say(red('  nothing supplied.'))
  process.exit(1)
}

// The vendor check runs before the token is sent anywhere. Validating means
// handing it to Cloudflare as a bearer token, and several other companies issue
// keys of exactly this shape.
const extracted = auth.extractToken(token)
if (!extracted.value) {
  say(red('  not sending that to Cloudflare: ' + auth.tokenCandidate(token).why))
  process.exit(1)
}
if (extracted.from !== 'the clipboard') say(dim('  took the token out of ' + extracted.from))
token = extracted.value

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

// The one that actually stopped a migration. Said here, before the credential
// is stored, so a token that cannot do the work never becomes the stored answer
// to "is this machine set up?".
if (can.canWriteDns === false) {
  say('')
  say(red('  Token valid, but it cannot write DNS. Add Zone → DNS → Edit and try again.'))
  say(dim('  Nothing has been stored. The link above is still the right one.'))
  process.exit(1)
}

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
say(dim('  DNS writes: ' + (can.canWriteDns === true ? 'yes'
  : can.canWriteDns === false ? 'NO'
    : 'not checkable yet - no zone in scope. The migration checks before it changes anything.')))
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
// stdin to the end, for the piped case. Trimmed, because a here-string and
// every password manager add a newline, and a token with one on the end fails
// the shape check for a reason nobody would guess.
async function readPipe() {
  let buf = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) buf += chunk
  return buf.trim()
}

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
