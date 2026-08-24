/**
 * The cutover is the four seconds that decide who serves the customer.
 *
 * These assert the RULES, not the implementation: which records move, which are deliberately
 * destroyed, which are never touched, and that the thing can be undone. A rewrite of
 * scripts/cutover.mjs that keeps all six passing is a rewrite that cannot lose the business's
 * email or leave half the world on the old host.
 *
 * The ALLOW case is first on purpose. A guard tested only on what it refuses is how two guards on
 * this estate refused correct work in one evening on 2026-08-23.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockServer } from './helpers/mock-cf-api.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'scripts', 'cutover.mjs')
const DOMAIN = 'cutover-test.example'
const ROLLBACK = join(ROOT, '.migration', `${DOMAIN}.rollback.json`)

// What mumchimp.com actually looked like on 2026-08-24, with the names swapped. Four records that
// decide who serves, and four that are mail and must survive untouched.
const ZONE = [
  { name: DOMAIN, type: 'A', content: '66.241.124.37' },
  { name: DOMAIN, type: 'AAAA', content: '2a09:8280:1::130:427c:0' },
  { name: DOMAIN, type: 'MX', content: 'smtp.google.com', priority: 5 },
  { name: DOMAIN, type: 'TXT', content: 'v=spf1 include:_spf.google.com ~all' },
  { name: `www.${DOMAIN}`, type: 'CNAME', content: 'old-web.example.net' },
  { name: `api.${DOMAIN}`, type: 'CNAME', content: 'old-api.example.net' },
  { name: `_dmarc.${DOMAIN}`, type: 'TXT', content: 'v=DMARC1; p=quarantine;' },
  { name: `sel._domainkey.${DOMAIN}`, type: 'TXT', content: 'k=rsa; p=AAAA' },
]

/** A box that answers. Something has to, or the ALLOW half cannot be tested at all. */
async function liveBox() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function harness({ probeBase } = {}) {
  const mock = await createMockServer({ port: 0, tokens: { 'test-token-good': ['zone:read', 'zone:edit', 'dns_records:edit'] } })
  const zone = mock.api.addZone(DOMAIN, ZONE)
  const env = {
    ...process.env,
    CF_API_BASE: mock.url,
    CF_API_TOKEN: 'test-token-good',
    CF_ZONE_ID: zone.id,
    CUTOVER_DOMAIN: DOMAIN,
    ...(probeBase ? { CUTOVER_PROBE_BASE: probeBase } : {}),
  }
  const run = (...args) =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { env, cwd: ROOT }, (err, stdout, stderr) =>
        resolve({ code: err?.code ?? 0, out: String(stdout), err: String(stderr) }),
      )
    })
  const cleanup = async () => {
    mock.server.close()
    await rm(ROLLBACK, { force: true })
  }
  return { mock, zone, run, cleanup }
}

const byName = (records, name, type) => records.filter((r) => r.name === name && r.type === type)

test('it points every serving name at the new box', async () => {
  const box = await liveBox()
  const h = await harness({ probeBase: box.base })
  try {
    const r = await h.run('--to', '203.0.113.9')
    assert.equal(r.code, 0, `refused a live box:\n${r.out}${r.err}`)

    const after = h.mock.api.recordsIn(h.zone.id)
    for (const name of [DOMAIN, `www.${DOMAIN}`, `api.${DOMAIN}`]) {
      const a = byName(after, name, 'A')
      assert.equal(a.length, 1, `${name} should have exactly one A record, has ${a.length}`)
      assert.equal(a[0].content, '203.0.113.9', `${name} still points at ${a[0].content}`)
      assert.equal(a[0].proxied, false, `${name} was proxied; nothing in this zone is`)
    }
    // A CNAME left behind alongside the new A record is a zone Cloudflare will not even accept.
    assert.equal(byName(after, `www.${DOMAIN}`, 'CNAME').length, 0)
    assert.equal(byName(after, `api.${DOMAIN}`, 'CNAME').length, 0)
  } finally {
    box.server.close()
    await h.cleanup()
  }
})

test('it destroys the apex AAAA, because a v6 client would otherwise stay on the old host', async () => {
  const box = await liveBox()
  const h = await harness({ probeBase: box.base })
  try {
    await h.run('--to', '203.0.113.9')
    const after = h.mock.api.recordsIn(h.zone.id)
    assert.equal(
      byName(after, DOMAIN, 'AAAA').length,
      0,
      'the AAAA survived. Every v6-capable customer would keep reaching the old host, and nothing ' +
        'about the zone or the site would look wrong from here.',
    )
  } finally {
    box.server.close()
    await h.cleanup()
  }
})

test('it never touches mail', async () => {
  const box = await liveBox()
  const h = await harness({ probeBase: box.base })
  try {
    const before = h.mock.api.recordsIn(h.zone.id).filter((r) => ['MX', 'TXT'].includes(r.type))
    await h.run('--to', '203.0.113.9')
    const after = h.mock.api.recordsIn(h.zone.id).filter((r) => ['MX', 'TXT'].includes(r.type))
    const key = (rs) => rs.map((r) => `${r.name} ${r.type} ${r.content}`).sort().join('\n')
    assert.equal(key(after), key(before), 'a cutover changed a mail record; that is a week of outage, not an hour')
    assert.equal(after.length, 4)
  } finally {
    box.server.close()
    await h.cleanup()
  }
})

test('rollback puts back exactly what was there', async () => {
  const box = await liveBox()
  const h = await harness({ probeBase: box.base })
  try {
    const key = (rs) =>
      rs
        .filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type))
        .map((r) => `${r.name} ${r.type} ${r.content} ttl=${r.ttl} proxied=${r.proxied}`)
        .sort()
        .join('\n')
    const before = key(h.mock.api.recordsIn(h.zone.id))

    await h.run('--to', '203.0.113.9')
    assert.notEqual(key(h.mock.api.recordsIn(h.zone.id)), before, 'nothing moved, so rollback proves nothing')

    const saved = JSON.parse(await readFile(ROLLBACK, 'utf8'))
    assert.equal(saved.records.length, 4, 'the rollback point did not record all four serving records')

    const r = await h.run('--rollback')
    assert.equal(r.code, 0, `rollback failed:\n${r.out}${r.err}`)
    assert.equal(key(h.mock.api.recordsIn(h.zone.id)), before, 'rollback did not restore the zone exactly')
  } finally {
    box.server.close()
    await h.cleanup()
  }
})

test('it refuses a box that is not answering, and names it', async () => {
  // No probeBase: the probe dials the address itself, which is TEST-NET-3 and routes nowhere.
  const h = await harness()
  try {
    const r = await h.run('--to', '198.51.100.7')
    assert.equal(r.code, 1, 'it pointed the domain at a box that never answered')
    assert.match(r.err, /198\.51\.100\.7 did not answer/)
    assert.match(r.err, /--force/, 'it refused without saying how to proceed deliberately')
    assert.equal(h.mock.api.mutations.length, 0, 'it refused and still changed the zone')
  } finally {
    await h.cleanup()
  }
})

test('--dry-run changes nothing', async () => {
  const box = await liveBox()
  const h = await harness({ probeBase: box.base })
  try {
    const r = await h.run('--to', '203.0.113.9', '--dry-run')
    assert.equal(r.code, 0, `${r.out}${r.err}`)
    assert.equal(h.mock.api.mutations.length, 0, 'a dry run made a mutating call')
    assert.match(r.out, /\[dry-run\]/, 'a dry run that prints nothing tells you nothing')
    assert.match(r.out, /unchanged/)
  } finally {
    box.server.close()
    await h.cleanup()
  }
})
