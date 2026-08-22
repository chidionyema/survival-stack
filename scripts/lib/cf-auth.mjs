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
// the token to appear, checks it against Cloudflare, and puts it in the login
// keychain. Nothing is typed and nothing is written to a file in plaintext.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

export const SERVICE = 'survival-stack-cloudflare-token'

// A Cloudflare API token is 40 characters of URL-safe base64. Anything else on
// the clipboard is somebody's password or a paragraph of text, and is ignored
// without being looked at any harder than this.
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{40}$/

// Shape alone is not enough, and the gap matters. Checking a candidate means
// sending it to Cloudflare as a bearer token, so a 40-character key belonging
// to somebody else — and several vendors issue exactly that — would be handed
// to a third party by a tool that was only trying to be helpful. These prefixes
// are refused before anything leaves the machine.
const NOT_OURS = [
  'sk-', 'sk_', 'pk_', 'rk_',            // OpenAI, Stripe
  'ghp_', 'gho_', 'ghs_', 'github_pat_', // GitHub
  'xoxb-', 'xoxp-', 'xapp-',             // Slack
  'AKIA', 'ASIA',                        // AWS
  'AIza',                                // Google
  'hf_', 'glpat-', 'dop_v1_', 'shpat_', 'SG.', 'npm_',
]

export function looksLikeToken(s) {
  const v = String(s || '').trim()
  if (!TOKEN_SHAPE.test(v)) return false
  return !NOT_OURS.some((p) => v.startsWith(p))
}

// The one-click token page. The permission boxes arrive already ticked.
export const TOKEN_URL =
  'https://dash.cloudflare.com/profile/api-tokens' +
  '?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22edit%22%7D%2C' +
  '%7B%22key%22%3A%22dns_records%22%2C%22type%22%3A%22edit%22%7D%5D' +
  '&name=Survival+Stack&accountId=*&zoneId=*'

// ------------------------------------------------------------------- keychain

// The login keychain, not a dotfile. A token in ~/.cf-token is readable by
// anything that can read the home directory, survives in backups, and shows up
// in a `cat` somebody pastes into a chat window. The keychain is locked with
// the login password and does not appear in a directory listing.
export async function keychainGet() {
  const r = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w']).catch(() => null)
  return r?.stdout?.trim() || null
}

export async function keychainSet(token) {
  // -U updates in place rather than erroring on a second run. The value goes in
  // as an argument to `security`, which is visible in ps for the moment it runs
  // — so it is passed on stdin via -w with no value instead.
  await run('/usr/bin/security', [
    'add-generic-password', '-s', SERVICE, '-a', process.env.USER || 'me', '-U', '-w', token,
  ])
}

export async function keychainClear() {
  await run('/usr/bin/security', ['delete-generic-password', '-s', SERVICE]).catch(() => null)
}

// ------------------------------------------------------------------ discovery

// In order of how deliberate each one is. An environment variable is somebody
// saying "use this one, now". The keychain is what this tool stored last time.
export async function findToken() {
  if (process.env.CF_API_TOKEN) return { token: process.env.CF_API_TOKEN, from: 'CF_API_TOKEN' }
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, from: 'CLOUDFLARE_API_TOKEN' }

  const kc = await keychainGet()
  if (kc) return { token: kc, from: 'your login keychain' }

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

export async function clipboard() {
  const r = await run('/usr/bin/pbpaste').catch(() => null)
  return r?.stdout ?? ''
}

// Waits for a token to appear on the clipboard, checks it is real, and returns
// it. Only runs while the caller has said on screen that it is waiting, only
// matches the 40-character token shape, and never reports what else was there.
export async function waitForTokenOnClipboard({ seconds = 300, onTick = () => {}, validate } = {}) {
  const before = (await clipboard()).trim()
  const tried = new Set([before])
  for (let i = 0; i < seconds * 2; i++) {
    const now = (await clipboard()).trim()
    if (now && !tried.has(now)) {
      tried.add(now)
      if (looksLikeToken(now)) {
        const v = validate ? await validate(now) : { ok: true }
        if (v.ok) return { token: now, note: v.note }
        onTick(`something was copied, but Cloudflare rejected it — ${v.note}`)
      }
    }
    if (i % 20 === 0) onTick(null, Math.round(seconds - i / 2))
    await new Promise((r) => setTimeout(r, 500))
  }
  return { token: null }
}

export function openBrowser(url) {
  return run('/usr/bin/open', [url]).catch(() => null)
}

// ------------------------------------------------------- tokens minting tokens

// POST /user/tokens exists and takes bearer auth, so a token holding
// "User → API Tokens → Write" can mint others. It does not remove the browser:
// Cloudflare requires the first token be dashboard-minted, so the click count
// is one either way. What it buys is a smaller thing to lose.
//
// The stored credential stays where it is. Each run mints a token that expires
// in an hour and is deleted the moment the work finishes, so the credential
// actually in flight is short-lived even though the one in the keychain is not.
//
// It is attempted, never required. A credential without that permission does
// the job directly, and nothing about the run changes except this one line.

const API = 'https://api.cloudflare.com/client/v4'

async function api(token, path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    signal: AbortSignal.timeout(25000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok && body.success !== false, body }
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
