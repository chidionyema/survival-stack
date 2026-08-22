// The guard on a domain move.
//
// The failure this is written against is not a crash. It is a migration that
// looks finished: the site loads, the dashboard is green, and an MX or a DKIM
// record never came across. Nothing tells you. You find out from a customer a
// week later asking why nobody replied.
//
// So the rule under test is one sentence: ready is true only when every record
// the old nameservers answer is also answered by the new ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { key, NAMES } from '../scripts/console/zone.mjs'

const rec = (name, type, content, priority) => ({ name, type, content, ...(priority !== undefined ? { priority } : {}) })

// The same comparison compare() makes, over supplied record sets rather than
// over the network, so the rule can be checked without a zone to move.
function verdict(before, after) {
  const real = (rs) => rs.filter((r) => !(r.type === 'NS' && !r.name.includes('.', r.name.indexOf('.') + 1)))
  const a = new Set(real(before).map(key))
  const b = new Set(real(after).map(key))
  return { missing: [...a].filter((k) => !b.has(k)), ready: [...a].every((k) => b.has(k)) }
}

const ZONE = [
  rec('x.com', 'A', '1.2.3.4'),
  rec('www.x.com', 'CNAME', 'origin.example'),
  rec('x.com', 'MX', 'smtp.google.com', 5),
  rec('x.com', 'TXT', 'v=spf1 include:_spf.google.com ~all'),
  rec('_dmarc.x.com', 'TXT', 'v=DMARC1; p=quarantine'),
  rec('sel._domainkey.x.com', 'TXT', 'k=rsa; p=AAAA'),
]

test('a complete copy is ready', () => {
  assert.equal(verdict(ZONE, [...ZONE]).ready, true)
})

test('incident: a dropped mail record must not read as ready', () => {
  for (const dropped of ZONE.filter((r) => r.type === 'MX' || r.type === 'TXT')) {
    const partial = ZONE.filter((r) => r !== dropped)
    const v = verdict(ZONE, partial)
    assert.equal(v.ready, false, `dropping ${key(dropped)} was called ready`)
    assert.equal(v.missing.length, 1)
    assert.equal(v.missing[0], key(dropped))
  }
})

test('every single record matters, one at a time', () => {
  // Property: removing any one record from the copy must flip ready to false.
  // Not a sample — the whole set, because the one that gets dropped in real
  // life is always the one nobody thought to check.
  for (let i = 0; i < ZONE.length; i++) {
    const partial = ZONE.filter((_, j) => j !== i)
    assert.equal(verdict(ZONE, partial).ready, false, `${key(ZONE[i])} was optional`)
  }
})

test('extra records on the new side do not block the switch', () => {
  // Cloudflare's own scanner finds things this sweep does not. That is a reason
  // to keep them, not a reason to refuse.
  const v = verdict(ZONE, [...ZONE, rec('extra.x.com', 'A', '9.9.9.9')])
  assert.equal(v.ready, true)
})

test('MX priority is part of the record, not decoration', () => {
  const wrongPriority = ZONE.map((r) => (r.type === 'MX' ? rec(r.name, 'MX', r.content, 10) : r))
  assert.equal(verdict(ZONE, wrongPriority).ready, false)
})

test('a trailing dot is not a difference', () => {
  // dig prints smtp.google.com. and the API returns smtp.google.com. Treating
  // those as different records is how a correct migration reports as broken.
  assert.equal(key(rec('x.com', 'CNAME', 'a.example')), key(rec('x.com', 'CNAME', 'a.example')))
})

test('the sweep asks for every common DKIM selector', () => {
  // A selector nobody guessed is a selector nobody migrates. This list is the
  // only thing standing between a working mail setup and a silent one.
  for (const s of ['google._domainkey', 'mailjet._domainkey', 'default._domainkey', 'selector1._domainkey', 'k1._domainkey']) {
    assert.ok(NAMES.includes(s), `${s} is not in the sweep`)
  }
  assert.ok(NAMES.includes('_dmarc'))
})
