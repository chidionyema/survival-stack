// Moving a domain to Cloudflare, without a dashboard.
//
// The manual version is: log in, add a site, wait for a scan, check every
// record it guessed, add the ones it missed, then compare by eye. The eye is
// the part that fails, and mail records are what it fails on — an SPF or DKIM
// record that did not come across breaks nothing visible and quietly costs you
// deliverability for a week.
//
// So this reads the zone from the nameservers actually answering for it, writes
// every record into Cloudflare through the API, and then asks both sides the
// same questions and refuses to say ready unless the answers match.
import { Resolver, promises as dnsp } from 'node:dns'

const CF = 'https://api.cloudflare.com/client/v4'

// Everything a small business is likely to have, plus every DKIM selector the
// common mail providers use. A name nobody ever asks about costs one UDP packet.
const NAMES = ['@', 'www', 'mail', 'smtp', 'imap', 'pop', 'webmail', 'autodiscover',
  'autoconfig', 'ftp', 'blog', 'shop', 'app', 'api', 'dev', 'staging', 'm', 'cdn',
  'static', 'assets', 'calendar', 'docs', 'drive', 'sites', 'status', 'support',
  'help', 'admin', 'portal', 'vpn', 'git', 'ns1', 'ns2',
  '_dmarc', 'google._domainkey', 'mailjet._domainkey', 'default._domainkey',
  'selector1._domainkey', 'selector2._domainkey', 'k1._domainkey', 'k2._domainkey',
  's1._domainkey', 's2._domainkey', 'mandrill._domainkey', 'sendgrid._domainkey',
  'em._domainkey', 'dkim._domainkey', 'smtp._domainkey', 'pm._domainkey',
  'zoho._domainkey', 'mail._domainkey', 'fm1._domainkey', 'fm2._domainkey', 'fm3._domainkey']

const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA', 'SRV', 'NS']

async function cf(token, path, opts = {}) {
  const r = await fetch(CF + path, {
    ...opts,
    signal: AbortSignal.timeout(25000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) },
  })
  const body = await r.json().catch(() => ({}))
  return { status: r.status, ok: r.ok && body.success !== false, body }
}

const firstError = (b) => b?.errors?.[0]?.message || b?.messages?.[0]?.message || 'Cloudflare said no'

// -------------------------------------------------------------- reading a zone

// Ask the servers that hold the zone, not a resolver. A resolver hands back
// whatever it has cached, which during a migration is exactly the wrong answer.
export async function authoritativeServers(domain) {
  const names = await dnsp.resolveNs(domain)
  const ips = []
  for (const n of names) {
    for (const ip of await dnsp.resolve4(n).catch(() => [])) ips.push(ip)
  }
  if (!ips.length) throw new Error(`no reachable nameserver for ${domain}`)
  return { names: names.sort(), ips }
}

function resolverOn(ips) {
  const r = new Resolver({ timeout: 3000, tries: 2 })
  r.setServers(ips)
  return r
}

const ask = (res, name, type) => new Promise((resolve) => {
  res.resolve(name, type, (err, out) => resolve(err ? [] : out))
})

// One flat list of strings, so two zones can be compared by set difference.
export async function readZone(domain, ips, { names = NAMES } = {}) {
  const res = resolverOn(ips)
  const out = []
  const jobs = []
  for (const n of names) {
    const fqdn = n === '@' ? domain : `${n}.${domain}`
    for (const type of TYPES) {
      jobs.push(ask(res, fqdn, type).then((rows) => {
        for (const row of rows) out.push({ name: fqdn, type, ...normalise(type, row) })
      }))
    }
  }
  await Promise.all(jobs)
  return out.sort((a, b) => key(a).localeCompare(key(b)))
}

function normalise(type, row) {
  if (type === 'MX') return { content: row.exchange.replace(/\.$/, ''), priority: row.priority }
  if (type === 'TXT') return { content: (Array.isArray(row) ? row.join('') : row) }
  if (type === 'SRV') return { content: `${row.weight} ${row.port} ${row.name}`, priority: row.priority }
  if (type === 'CAA') return { content: `${row.critical} ${row.issue ? 'issue' : 'iodef'} "${row.issue || row.iodef}"` }
  return { content: String(row).replace(/\.$/, '') }
}

export const key = (r) => `${r.name} ${r.type} ${r.priority ?? ''} ${r.content}`.trim()

// ------------------------------------------------------------- writing a zone

export async function accountId(token) {
  const r = await cf(token, '/accounts?per_page=5')
  if (!r.ok) return null
  return r.body.result?.[0]?.id || null
}

export async function findZone(token, domain) {
  const r = await cf(token, `/zones?name=${encodeURIComponent(domain)}`)
  if (!r.ok) return null
  return r.body.result?.[0] || null
}

// jump_start is left on deliberately. Cloudflare's scanner looks for records the
// same way this file does and gets different answers, because neither can list a
// zone it cannot transfer — both are guessing names. Two guessers that agree is
// the closest thing to a listing available without the registrar's own API, and
// where they disagree is the only part worth a human's attention.
export async function createZone(token, account, domain, jumpStart = true) {
  const r = await cf(token, '/zones', {
    method: 'POST',
    body: JSON.stringify({ name: domain, account: { id: account }, type: 'full', jump_start: jumpStart }),
  })
  if (!r.ok) throw new Error(firstError(r.body))
  return r.body.result
}

// Everything goes in grey-clouded. Today nothing is proxied, so proxying on the
// way in would change how traffic reaches the origin and how TLS terminates, on
// the same day as the move, with two changes to untangle if anything breaks.
export async function writeRecords(token, zoneId, records, onEach = () => {}) {
  const existing = await allRecords(token, zoneId)
  const have = new Set(existing.map((r) => key(fromCf(r))))
  const results = { added: 0, already: 0, skipped: [], failed: [] }

  for (const rec of records) {
    if (rec.type === 'NS' && rec.name === records.domain) continue
    if (have.has(key(rec))) { results.already++; onEach({ ...rec, state: 'already there' }); continue }
    const body = {
      type: rec.type,
      name: rec.name,
      content: rec.content,
      ttl: 300,
      proxied: false,
      ...(rec.priority !== undefined ? { priority: rec.priority } : {}),
    }
    const r = await cf(token, `/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify(body) })
    if (r.ok) { results.added++; onEach({ ...rec, state: 'added' }) }
    else { results.failed.push({ ...rec, why: firstError(r.body) }); onEach({ ...rec, state: `refused: ${firstError(r.body)}` }) }
  }
  return results
}

export async function allRecords(token, zoneId) {
  const out = []
  for (let page = 1; page <= 10; page++) {
    const r = await cf(token, `/zones/${zoneId}/dns_records?per_page=100&page=${page}`)
    if (!r.ok) break
    out.push(...r.body.result)
    if (r.body.result.length < 100) break
  }
  return out
}

const fromCf = (r) => ({
  name: r.name, type: r.type, content: String(r.content).replace(/\.$/, ''),
  ...(r.priority !== undefined && r.priority !== null ? { priority: r.priority } : {}),
})

// ------------------------------------------------------------------- the check

// The guard. Two nameserver sets, the same questions, and a refusal unless the
// answers match. NS records are excluded because they differ by definition
// while a migration is in progress.
export async function compare(domain, oldIps, newIps) {
  const [before, after] = await Promise.all([readZone(domain, oldIps), readZone(domain, newIps)])
  const real = (rs) => rs.filter((r) => !(r.type === 'NS' && r.name === domain))
  const a = new Set(real(before).map(key))
  const b = new Set(real(after).map(key))
  return {
    total: a.size,
    missing: [...a].filter((k) => !b.has(k)).sort(),
    extra: [...b].filter((k) => !a.has(k)).sort(),
    ready: [...a].every((k) => b.has(k)),
  }
}

export async function nameserversNowServing(domain) {
  return (await dnsp.resolveNs(domain).catch(() => [])).map((n) => n.toLowerCase()).sort()
}

export { NAMES }
