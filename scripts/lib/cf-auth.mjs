// Finding a Cloudflare credential that can actually do the job.
//
// `wrangler login` is the right pattern and it is used, but its OAuth token
// cannot do this particular job and no flag makes it. Measured on wrangler
// 4.125.0:
//
//   wrangler login --scopes-list          → 27 scopes, and the only zone one
//                                           is `zone:read`
//   wrangler login --scopes zone:edit     → Invalid authentication scope
//   wrangler login --scopes dns_records:edit → Invalid authentication scope
//
// Creating a zone is POST /zones, which needs zone edit. Writing a record needs
// dns_records edit. Neither is on offer, so the OAuth token gets a 403 no matter
// how the flow is dressed up. Cloudflare has two permission systems and only one
// of them has an OAuth front door.
//
// So the token is unavoidable. What is avoidable is the typing. This module
// opens the token page with the boxes already ticked, watches the clipboard for
// the token to appear, checks it against Cloudflare, and puts it in whatever
// secret store the machine has. Nothing is typed and nothing reaches a file in
// plaintext unless the machine has no secret store at all, which it says.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { homedir, platform as osPlatform } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
// `which` is not everywhere and `command -v` is a shell builtin, so this asks a
// shell. On Windows there is no shell to ask, so it asks `where` instead.
const has = async (cmd) => {
  if (osPlatform() === 'win32') return !!(await run('where', [cmd]).catch(() => null))
  return !!(await run('/bin/sh', ['-c', `command -v ${JSON.stringify(cmd)}`]).catch(() => null))
}

// ------------------------------------------------------------------ platform

// WSL is Linux to uname and Windows to the clipboard, so it gets its own name.
// Everything downstream branches on this one string rather than re-sniffing.
let cached = null
export async function platform() {
  if (cached) return cached
  if (osPlatform() === 'darwin') return (cached = 'macos')
  if (osPlatform() === 'win32') return (cached = 'windows')
  if (osPlatform() === 'linux') {
    const v = await readFile('/proc/version', 'utf8').catch(() => '')
    return (cached = /microsoft/i.test(v) ? 'wsl' : 'linux')
  }
  return (cached = 'unknown')
}

// A team can point every machine at one name without editing code. The default
// is the name this tool has always used, so an existing stored token still
// resolves after this change.
export const SERVICE = process.env.CF_TOKEN_SERVICE
  || 'survival-stack-cloudflare-token' + (process.env.CF_TOKEN_TEAM ? `-${process.env.CF_TOKEN_TEAM}` : '')

// What a credential is, without claiming to know what Cloudflare's looks like.
//
// The incident: this used to be /^[A-Za-z0-9_-]{40}$/. Cloudflare started
// issuing a `cfut_`-prefixed 53-character form, the clipboard watcher saw a
// real, active token, decided it was the wrong shape and said nothing at all.
// It read as "the clipboard is broken" and burned a 30-minute window.
//
// So the length is a floor, never an equality, and there is no upper bound.
// Cloudflare is the only thing that gets to say whether a token is a token.
// The three checks left are not format guesses:
//   - a floor, because a 6-character string is a word, not a credential
//   - no whitespace and no "://", because that is prose or a URL
//   - a vendor prefix, because checking means SENDING it, and another
//     company's key must never be handed to Cloudflare to be graded
export const MIN_TOKEN_LENGTH = 20

// Shape alone is not enough, and the gap matters. Checking a candidate means
// sending it to Cloudflare as a bearer token, so a key belonging to somebody
// else - and several vendors issue plausible-looking ones - would be handed to
// a third party by a tool that was only trying to be helpful. These prefixes
// are refused before anything leaves the machine.
const NOT_OURS = [
  'sk-', 'sk_', 'pk_', 'rk_', 'whsec_',        // OpenAI, Stripe
  'ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_', 'github_pat_',
  'xoxb-', 'xoxp-', 'xapp-', 'xoxa-', 'xoxr-', // Slack
  'AKIA', 'ASIA', 'ABIA', 'ACCA',              // AWS
  'AIza', 'ya29.',                             // Google
  'hf_', 'glpat-', 'gldt-', 'dop_v1_', 'doo_v1_', 'dor_v1_',
  'shpat_', 'shpss_', 'SG.', 'npm_', 'pypi-', 'atlasv1.',
  'fly_', 'FlyV1', 'lin_api_', 'sntrys_', 'sq0atp-', 'sq0csp-',
  'EAAC', 'EAAG', 'r8_', 'tvly-', 'nvapi-', 'ntn_', 'secret_',
]

// Returns a reason, never a bare false. A candidate that is turned away in
// silence is the bug this replaces: the user is owed the sentence that says
// which of the two things went wrong, the copy or the token.
export function tokenCandidate(s) {
  const v = String(s || '').trim()
  if (!v) return { ok: false, why: 'nothing to check' }
  if (v.length < MIN_TOKEN_LENGTH) {
    return { ok: false, why: `${v.length} characters is too short to be a credential` }
  }
  if (/\s/.test(v)) return { ok: false, why: 'it contains spaces or newlines, so it is text' }
  if (v.includes('://')) return { ok: false, why: 'it is a URL' }
  const vendor = NOT_OURS.find((pfx) => v.startsWith(pfx))
  if (vendor) {
    return { ok: false, why: `it starts with "${vendor}" - that is another vendor's key, and sending it to Cloudflare to be checked would leak it` }
  }
  return { ok: true }
}

export function looksLikeToken(s) {
  return tokenCandidate(s).ok
}

// The one-click token page. The permission boxes arrive already ticked.
export const TOKEN_URL =
  'https://dash.cloudflare.com/profile/api-tokens' +
  '?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22edit%22%7D%2C' +
  '%7B%22key%22%3A%22dns_records%22%2C%22type%22%3A%22edit%22%7D%5D' +
  '&name=Survival+Stack&accountId=*&zoneId=*'

// The same page with the permission that lets one token mint others. Offered,
// never the default: a credential holding it can create a token that does
// anything the account can do, and it sits in the store between runs.
export const TOKEN_URL_FULL = TOKEN_URL.replace(
  '%22dns_records%22%2C%22type%22%3A%22edit%22%7D%5D',
  '%22dns_records%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22api_tokens%22%2C%22type%22%3A%22edit%22%7D%5D',
)

// -------------------------------------------------------------- secret store

const FILE_DIR = join(homedir(), '.config', 'survival-stack')
const FILE_PATH = join(FILE_DIR, SERVICE)

// Where a token can be kept on this machine, best first. `plaintext` is last
// and says so out loud every time it is used — a file is not a secret store,
// it is the absence of one.
export async function secretStore() {
  const p = await platform()
  if (p === 'macos') return { kind: 'keychain', name: 'your login keychain', secure: true }
  if ((p === 'linux' || p === 'wsl') && (await has('secret-tool'))) {
    return { kind: 'secret-tool', name: 'the GNOME keyring', secure: true }
  }
  return {
    kind: 'plaintext',
    name: `${FILE_PATH} (mode 0600)`,
    secure: false,
    hint: p === 'linux' || p === 'wsl'
      ? 'install libsecret-tools (apt) or libsecret (dnf/pacman) and re-run to use the keyring instead'
      : 'this platform has no secret store this tool can drive',
  }
}

export async function keychainGet() {
  const s = await secretStore()
  if (s.kind === 'keychain') {
    const r = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w']).catch(() => null)
    return r?.stdout?.trim() || null
  }
  if (s.kind === 'secret-tool') {
    const r = await run('secret-tool', ['lookup', 'service', SERVICE]).catch(() => null)
    return r?.stdout?.trim() || null
  }
  const v = await readFile(FILE_PATH, 'utf8').catch(() => null)
  return v?.trim() || null
}

export async function keychainSet(token) {
  const s = await secretStore()
  if (s.kind === 'keychain') {
    // The value goes in on stdin, not as an argument. `security ... -w SECRET`
    // puts the token in the process argument list, where any user on the box
    // can read it out of `ps` for as long as the command runs — measured, three
    // matching lines. With -w and no value it prompts twice, so it is fed twice.
    await feed('/usr/bin/security',
      ['add-generic-password', '-s', SERVICE, '-a', process.env.USER || 'me', '-U', '-w'],
      `${token}\n${token}\n`)
  } else if (s.kind === 'secret-tool') {
    await feed('secret-tool', ['store', '--label=Cloudflare API token', 'service', SERVICE], token)
  } else {
    await mkdir(FILE_DIR, { recursive: true, mode: 0o700 })
    await writeFile(FILE_PATH, token + '\n', { mode: 0o600 })
  }
  return s
}

export async function keychainClear() {
  const s = await secretStore()
  if (s.kind === 'keychain') await run('/usr/bin/security', ['delete-generic-password', '-s', SERVICE]).catch(() => null)
  else if (s.kind === 'secret-tool') await run('secret-tool', ['clear', 'service', SERVICE]).catch(() => null)
  else await rm(FILE_PATH, { force: true })
}

function feed(cmd, args, stdin) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    p.stdin.end(stdin)
  })
}

// ------------------------------------------------------------------ discovery

// In order of how deliberate each one is. An environment variable is somebody
// saying "use this one, now". The store is what this tool kept last time.
export async function findToken() {
  if (process.env.CF_API_TOKEN) return { token: process.env.CF_API_TOKEN, from: 'CF_API_TOKEN' }
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, from: 'CLOUDFLARE_API_TOKEN' }

  const kc = await keychainGet()
  if (kc) return { token: kc, from: (await secretStore()).name }

  // Kept only because earlier versions of this documented it. Read, never written.
  for (const f of [join(process.cwd(), '.cf-token'), join(homedir(), '.cf-token')]) {
    const v = await readFile(f, 'utf8').catch(() => null)
    if (v?.trim()) return { token: v.trim(), from: f }
  }
  return { token: null, from: null }
}

// What wrangler's OAuth login gives you. Real, useful, and not enough for this:
// it covers the deploy — workers, KV, secrets — and stops at zone:read.
export async function wranglerLoggedIn(wranglerPath) {
  const r = await run(wranglerPath, ['whoami'], { timeout: 60000 }).catch((e) => e)
  const out = String(r?.stdout || '') + String(r?.stderr || '')
  const id = out.match(/\b[0-9a-f]{32}\b/)
  return { loggedIn: /Account ID|associated with the email/.test(out), accountId: id?.[0] || null }
}

// ------------------------------------------------------------------ clipboard

// One reader per platform. Returned rather than run so a pre-flight check can
// say which tool is missing and how to get it, before anything starts waiting.
export async function clipboardReader() {
  const p = await platform()
  if (p === 'macos') return { cmd: '/usr/bin/pbpaste', args: [] }
  if (p === 'wsl' || p === 'windows') {
    const exe = p === 'wsl' ? 'powershell.exe' : 'powershell'
    if (await has(exe)) return { cmd: exe, args: ['-NoProfile', '-Command', 'Get-Clipboard'], crlf: true }
    return null
  }
  if (process.env.WAYLAND_DISPLAY && (await has('wl-paste'))) return { cmd: 'wl-paste', args: ['--no-newline'] }
  if (await has('xclip')) return { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] }
  if (await has('xsel')) return { cmd: 'xsel', args: ['--clipboard', '--output'] }
  return null
}

// What to type to get one, per package manager actually present. Returned as a
// command so the caller can offer to run it rather than printing a wiki page.
export async function clipboardInstall() {
  if ((await platform()) !== 'linux') return null
  const wayland = !!process.env.WAYLAND_DISPLAY
  const pkg = wayland ? { apt: 'wl-clipboard', dnf: 'wl-clipboard', pacman: 'wl-clipboard' }
    : { apt: 'xclip', dnf: 'xclip', pacman: 'xclip' }
  if (await has('apt-get')) return `sudo apt-get install -y ${pkg.apt}`
  if (await has('dnf')) return `sudo dnf install -y ${pkg.dnf}`
  if (await has('pacman')) return `sudo pacman -S --noconfirm ${pkg.pacman}`
  return null
}

export async function clipboard() {
  const r = await clipboardReader()
  if (!r) return ''
  const out = await run(r.cmd, r.args).catch(() => null)
  if (!out) return ''
  return r.crlf ? out.stdout.replace(/\r/g, '') : out.stdout
}

// Waits for a token to appear on the clipboard, checks it is real, and returns
// it. Only runs while the caller has said on screen that it is waiting, only
// sends on what could be a credential, and never reports what else was there.
export async function waitForTokenOnClipboard({ seconds = 300, onTick = () => {}, validate } = {}) {
  const before = (await clipboard()).trim()
  const tried = new Set([before])
  for (let i = 0; i < seconds * 2; i++) {
    const now = (await clipboard()).trim()
    if (now && !tried.has(now)) {
      tried.add(now)
      // Loud on every path. The old version skipped a candidate that failed
      // the shape test without a word, which is how a real token sat on the
      // clipboard being ignored. Cloudflare is the validator; this only says
      // why something never reached it.
      const c = tokenCandidate(now)
      if (!c.ok) {
        onTick(`something was copied and it was not sent to Cloudflare: ${c.why}`)
      } else {
        const v = validate ? await validate(now) : { ok: true }
        if (v.ok) return { token: now, note: v.note }
        onTick(`something was copied, but Cloudflare rejected it - ${v.note}`)
      }
    }
    if (i % 20 === 0) onTick(null, Math.round(seconds - i / 2))
    await new Promise((r) => setTimeout(r, 500))
  }
  return { token: null }
}

export async function openBrowser(url) {
  const p = await platform()
  const tries = p === 'macos' ? [['/usr/bin/open', [url]]]
    : p === 'wsl' ? [['wslview', [url]], ['cmd.exe', ['/c', 'start', '', url]]]
      : p === 'windows' ? [['cmd', ['/c', 'start', '', url]]]
        : [['xdg-open', [url]], ['gio', ['open', url]], ['sensible-browser', [url]]]
  for (const [cmd, args] of tries) {
    const ok = await run(cmd, args).then(() => true).catch(() => false)
    if (ok) return true
  }
  return false
}

// ------------------------------------------------------- tokens minting tokens

// POST /user/tokens exists and takes bearer auth, so a token holding
// "User → API Tokens → Write" can mint others. It does not remove the browser:
// Cloudflare requires the first token be dashboard-minted, so the click count
// is one either way. What it buys is a smaller thing to lose.
//
// The stored credential stays where it is. Each run mints a token that expires
// in an hour and is deleted the moment the work finishes, so the credential
// actually in flight is short-lived even though the one in the store is not.
//
// It is attempted, never required. A credential without that permission does
// the job directly, and nothing about the run changes except this one line.

const API = 'https://api.cloudflare.com/client/v4'

// A network failure is not a bad token, and neither is a DNS outage on a train.
// Both come back as `ok: false` so the caller reports "cannot reach Cloudflare"
// rather than throwing a stack trace at somebody setting up their laptop.
async function api(token, path, opts = {}) {
  try {
    const r = await fetch(API + path, {
      ...opts,
      signal: AbortSignal.timeout(25000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) },
    })
    const body = await r.json().catch(() => ({}))
    return { ok: r.ok && body.success !== false, body }
  } catch (e) {
    return { ok: false, body: {}, offline: true, error: String(e.message || e) }
  }
}

// The permission group ids are UUIDs and they are not stable enough to paste
// into source. Ask for them.
export async function permissionGroups(token) {
  const r = await api(token, '/user/tokens/permission_groups?per_page=200')
  if (!r.ok) return null
  return r.body.result || []
}

const findGroup = (groups, name, scope) =>
  groups.find((g) => g.name === name && (g.scopes || []).includes(scope))

// Returns null when the credential cannot mint, which is the normal case and
// not an error. The caller carries on with what it already has.
export async function mintEphemeral(token, accountId, { hours = 1 } = {}) {
  const groups = await permissionGroups(token)
  if (!groups) return null

  const zoneWrite = findGroup(groups, 'Zone Write', 'com.cloudflare.api.account')
  const dnsWrite = findGroup(groups, 'DNS Write', 'com.cloudflare.api.account.zone')
  if (!zoneWrite || !dnsWrite) return null

  // Account scope, not zone scope. Creating a zone is an account-level act and
  // the zone it creates has no id to narrow to yet. The expiry is what bounds
  // this one, not the resource list.
  const expires = new Date(Date.now() + hours * 3600_000).toISOString().replace(/\.\d{3}/, '')
  const r = await api(token, '/user/tokens', {
    method: 'POST',
    body: JSON.stringify({
      name: `survival-stack ephemeral ${expires.slice(0, 16)}`,
      status: 'active',
      expires_on: expires,
      policies: [{
        effect: 'allow',
        resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
        permission_groups: [{ id: zoneWrite.id }, { id: dnsWrite.id }],
      }],
    }),
  })
  if (!r.ok || !r.body.result?.value) return null
  return { token: r.body.result.value, id: r.body.result.id, expires }
}

export async function revokeToken(rootToken, tokenId) {
  const r = await api(rootToken, `/user/tokens/${tokenId}`, { method: 'DELETE' })
  return r.ok
}

// --------------------------------------------------------------- what it can do

// Grading a token by asking Cloudflare what it can do, not by reading the name
// off a listing. `GET /user/tokens` returns every token on the account, so
// grepping it for "dns_records" answers a question about somebody else's token.
//
// Two of the three answers are proofs and one cannot be:
//   valid   — /user/tokens/verify says so
//   canMint — it minted a token and the token was deleted again
//   zone edit — unprovable without creating a zone, so it is not claimed here
export async function capability(token) {
  const v = await api(token, '/user/tokens/verify')
  if (!v.ok) return { valid: false, canMint: false, accountId: null, zones: null, offline: !!v.offline }

  const acc = await api(token, '/accounts?per_page=1')
  const accountId = acc.ok ? acc.body.result?.[0]?.id || null : null

  const zr = await api(token, '/zones?per_page=50')
  const zones = zr.ok ? (zr.body.result || []).map((z) => z.name) : null

  let canMint = false
  if (accountId) {
    const probe = await mintEphemeral(token, accountId, { hours: 1 })
    if (probe) {
      canMint = true
      await revokeToken(token, probe.id)
    }
  }
  return { valid: true, canMint, accountId, zones }
}
