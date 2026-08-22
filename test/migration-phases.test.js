// The failure matrix for a domain migration.
//
// Every one of these ran once for real, on mumchimp.com, and cost an evening:
// a token that could create a zone but not write to it, a zone created by a
// credential nobody had checked, a half-written zone with no way back. The
// point of this file is that none of them ever has to run for real again.
//
// It drives the real phases over real HTTP against test/helpers/mock-cf-api.mjs.
// That matters: a stubbed fetch agrees with whatever the caller does to it, and
// the two failures that actually bit - GET /accounts answering 200 with an
// empty list, and one DNS permission covering both read and write - are facts
// about the wire, not about the code.
//
// Only the outside world is faked. DNS is injected so the matrix runs on a
// train, and the registrar is never touched by anything here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockServer, scenarios } from './helpers/mock-cf-api.mjs'
import * as ph from '../scripts/console/phases.mjs'

const DOMAIN = 'mumchimp.com'

// What the old nameservers answer with. Eight records, including the mail ones
// that are the whole reason this is not done by eye.
const RECORDS = [
  { name: DOMAIN, type: 'A', content: '66.241.124.37' },
  { name: DOMAIN, type: 'MX', content: 'smtp.google.com', priority: 5 },
  { name: DOMAIN, type: 'TXT', content: 'v=spf1 include:_spf.google.com ~all' },
  { name: `www.${DOMAIN}`, type: 'CNAME', content: DOMAIN },
  { name: `api.${DOMAIN}`, type: 'A', content: '66.241.124.37' },
  { name: `_dmarc.${DOMAIN}`, type: 'TXT', content: 'v=DMARC1; p=none;' },
  { name: `mail.${DOMAIN}`, type: 'A', content: '66.241.124.37' },
  { name: `google._domainkey.${DOMAIN}`, type: 'TXT', content: 'v=DKIM1; k=rsa; p=MII' },
]

const OLD_NS = ['ns03.domaincontrol.com', 'ns04.domaincontrol.com']

// The outside world, in one object. registrarLock reports unlocked by default
// because the locked case is its own test.
const fakeDns = (over = {}) => ({
  authoritativeServers: async () => ({ names: OLD_NS, ips: ['1.1.1.1'] }),
  readZone: async () => RECORDS,
  registrarLock: async () => ({ known: true, locked: false, statuses: [] }),
  compare: async () => ({ total: RECORDS.length, missing: [], extra: [], ready: true }),
  ...over,
})
const resolves = async () => ['198.51.100.1']

// Every scenario gets its own server, its own state directory and its own
// process-wide CF_API_BASE, restored on the way out.
async function withMock(opts, fn) {
  const mock = await createMockServer({ port: 0, ...opts })
  const dir = await mkdtemp(join(tmpdir(), 'migration-'))
  const had = process.env.CF_API_BASE
  process.env.CF_API_BASE = mock.url
  try {
    return await fn({ ...mock, dir })
  } finally {
    if (had === undefined) delete process.env.CF_API_BASE
    else process.env.CF_API_BASE = had
    await mock.close()
    await rm(dir, { recursive: true, force: true })
  }
}

// Discover with no network, so every later phase has a baseline to work from.
const discovered = (dir, dns = fakeDns()) => ph.discover(DOMAIN, { dir, dns })

// ─── the matrix ───────────────────────────────────────────────────────────

// Three things hold in every scenario below, pass or fail. They are checked
// after the body rather than asserted inside it, because a guarantee that has
// to be remembered at each call site is a guarantee that will be forgotten.
async function invariants(api, { theirZoneId = null } = {}) {
  // 1. Nothing is created before something has been read. The incident: a zone
  //    created by a credential that turned out not to be able to write to it.
  api.assertNoMutationBeforeARead()

  // 2. A zone that was already there is never deleted. A permission failure
  //    must not be able to destroy somebody else's configuration.
  if (theirZoneId) {
    assert.equal(api.deletedZones.includes(theirZoneId), false,
      'a zone that existed before the run started was deleted')
  }

  // 3. Any zone this run created and then withdrew was probed in between.
  //    Create-then-delete with no read between them means it deleted a zone it
  //    had no reason to give up on.
  for (const id of api.createdZones) {
    if (!api.deletedZones.includes(id)) continue
    api.assertCallOrder(['POST /zones', `GET /zones/${id}/dns_records`, `DELETE /zones/${id}`])
  }
}

test('a credential Cloudflare will not accept stops before anything is created', async () => {
  await withMock({}, async ({ api, dir }) => {
    await discovered(dir)
    const r = await ph.validate(DOMAIN, scenarios.invalidToken.token, { dir })

    assert.equal(r.ok, false)
    assert.match(r.stop, scenarios.invalidToken.expect.stops)
    assert.equal(api.mutations.length, 0, 'an unusable credential still changed something')
    await invariants(api)
  })
})

test('a credential that cannot list zones says so, instead of reading it as "no such zone"', async () => {
  // The trap this pins: findZone and listZones both flatten a 403 into an
  // empty answer. Without the explicit zone-read check, a token with no
  // Zone:Read looks exactly like an account with no zones, and the run goes on
  // to create one.
  await withMock({}, async ({ api, dir }) => {
    const theirs = api.addZone(DOMAIN)
    await discovered(dir)
    const r = await ph.validate(DOMAIN, scenarios.noZoneRead.token, { dir })

    assert.equal(r.ok, false)
    assert.match(r.stop, scenarios.noZoneRead.expect.stops)
    assert.match(r.need, scenarios.noZoneRead.expect.need)
    assert.equal(api.createdZones.length, 0, 'it created a zone that was already there')
    assert.equal(api.mutations.length, 0)
    await invariants(api, { theirZoneId: theirs.id })
  })
})

test('no DNS permission, zone already there: it names the permission and changes nothing', async () => {
  await withMock({}, async ({ api, dir }) => {
    const theirs = api.addZone(DOMAIN, [{ type: 'A', name: DOMAIN, content: '66.241.124.37' }])
    await discovered(dir)
    const r = await ph.validate(DOMAIN, scenarios.noDnsEditExistingZone.token, { dir })

    assert.equal(r.ok, false)
    assert.match(r.stop, scenarios.noDnsEditExistingZone.expect.stops)
    assert.match(r.need, /DNS/)
    assert.equal(api.mutations.length, 0)
    assert.equal(api.recordsIn(theirs.id).length, 1, 'their record was touched')
    await invariants(api, { theirZoneId: theirs.id })
  })
})

test('no DNS permission and nothing in scope: it creates a zone to ask, then withdraws it', async () => {
  // The only case where a failed validate creates anything. There has to be a
  // zone to ask "can this token write DNS here", and if the answer is no the
  // question is taken back. Net zero, which is the guarantee - not zero calls.
  await withMock({}, async ({ api, dir }) => {
    await discovered(dir)
    const r = await ph.validate(DOMAIN, scenarios.noDnsEditMissingZone.token, { dir })

    assert.equal(r.ok, false)
    assert.match(r.stop, scenarios.noDnsEditMissingZone.expect.stops)
    assert.equal(r.rolledBack, true, 'the probe zone was left behind')
    assert.equal(api.createdZones.length, 1)
    assert.deepEqual(api.deletedZones, api.createdZones, 'created a zone and kept it')
    assert.equal(api.zoneIds.length, 0, 'the account did not end as it started')
    await invariants(api)
  })
})

test('somebody else\'s zone is used as the question, and never as the answer', async () => {
  // A different zone is in scope, so that one gets probed and this one is
  // never created. Deleting theirs over a permission failure would turn a bad
  // first run into a lost configuration.
  await withMock({}, async ({ api, dir }) => {
    const theirs = api.addZone('someone-else.co.uk')
    await discovered(dir)
    const r = await ph.validate(DOMAIN, scenarios.noDnsEditExistingZone.token, { dir })

    assert.equal(r.ok, false)
    assert.match(r.stop, /cannot write DNS/i)
    assert.equal(api.createdZones.length, 0, 'it created our zone before checking')
    assert.equal(api.deletedZones.length, 0)
    await invariants(api, { theirZoneId: theirs.id })
  })
})

test('a credential that cannot create a zone says that, not "no DNS"', async () => {
  await withMock({}, async ({ api, dir }) => {
    await discovered(dir)
    const r = await ph.validate(DOMAIN, scenarios.noZoneEdit.token, { dir })

    assert.equal(r.ok, false)
    assert.match(r.stop, scenarios.noZoneEdit.expect.stops)
    assert.match(r.need, scenarios.noZoneEdit.expect.need)
    assert.equal(api.createdZones.length, 0)
    await invariants(api)
  })
})

test('the happy path creates the zone, writes all eight records and verifies', async () => {
  await withMock({}, async ({ api, dir }) => {
    await discovered(dir)
    const v = await ph.validate(DOMAIN, scenarios.happyCreate.token, { dir })
    assert.equal(v.ok, true)
    assert.equal(v.fresh, true)
    assert.equal(api.createdZones.length, 1)

    const p = await ph.prepare(DOMAIN, scenarios.happyCreate.token, { dir })
    assert.equal(p.ok, true)
    assert.equal(p.added, RECORDS.length)
    assert.equal(api.recordsIn(v.zone.id).length, RECORDS.length)

    const r = await ph.verify(DOMAIN, { dir, dns: fakeDns(), resolve4: resolves })
    assert.equal(r.ok, true)
    assert.equal(r.diff.missing.length, 0)

    // The state file, not memory, is what the next phase reads.
    const state = await ph.loadState(DOMAIN, dir)
    assert.equal(state.zoneCreatedByUs, true)
    assert.equal(state.addedRecordIds.length, RECORDS.length)
    assert.ok(state.verifiedAt)
    await invariants(api)
  })
})

test('the happy path into a zone that was already there does not create one', async () => {
  await withMock({}, async ({ api, dir }) => {
    const theirs = api.addZone(DOMAIN)
    await discovered(dir)
    const v = await ph.validate(DOMAIN, scenarios.happyExisting.token, { dir })

    assert.equal(v.ok, true)
    assert.equal(v.fresh, false)
    assert.equal(api.createdZones.length, 0)
    assert.equal((await ph.loadState(DOMAIN, dir)).zoneCreatedByUs, false,
      'a zone we did not create is flagged as ours, and rollback would delete it')

    const p = await ph.prepare(DOMAIN, scenarios.happyExisting.token, { dir })
    assert.equal(p.ok, true)
    await invariants(api, { theirZoneId: theirs.id })
  })
})

test('a record refused halfway through takes the records and the zone back out', async () => {
  // Four in and a refusal on the fifth used to leave four records and a zone
  // behind, and the next run could not tell them from configuration somebody
  // meant. failAfter: 3 is that exact moment.
  const s = scenarios.partialFailure
  await withMock({ injectFailures: s.injectFailures }, async ({ api, dir }) => {
    await discovered(dir)
    const v = await ph.validate(DOMAIN, s.token, { dir })
    assert.equal(v.ok, true)

    const p = await ph.prepare(DOMAIN, s.token, { dir })
    assert.equal(p.ok, false)
    assert.match(p.stop, s.expect.stops)
    assert.equal(p.rolledBack.ok, true)
    assert.equal(p.rolledBack.recordsRemoved, 3, 'the three that were written were not removed')
    assert.equal(p.rolledBack.zoneDeleted, true)
    assert.equal(api.zoneIds.length, 0, 'the account did not end as it started')
    await invariants(api)
  })
})

test('the same refusal in somebody else\'s zone removes our records and keeps their zone', async () => {
  const s = scenarios.partialFailureTheirZone
  await withMock({ injectFailures: s.injectFailures }, async ({ api, dir }) => {
    const theirs = api.addZone(DOMAIN, [{ type: 'TXT', name: `_seed.${DOMAIN}`, content: 'theirs' }])
    await discovered(dir)
    const v = await ph.validate(DOMAIN, s.token, { dir })
    assert.equal(v.ok, true)

    const p = await ph.prepare(DOMAIN, s.token, { dir })
    assert.equal(p.ok, false)
    assert.equal(p.rolledBack.zoneDeleted, false)
    assert.match(p.rolledBack.keptBecause, /already there/)
    assert.deepEqual(api.recordsIn(theirs.id).map((r) => r.name), [`_seed.${DOMAIN}`],
      'rollback removed a record it did not write')
    await invariants(api, { theirZoneId: theirs.id })
  })
})

test('rollback refuses to delete a zone that has anything in it', async () => {
  // The second question that does not depend on the state file being right.
  // A wrong zoneCreatedByUs can then only ever delete something already empty.
  await withMock({}, async ({ api, dir }) => {
    const theirs = api.addZone(DOMAIN, [{ type: 'A', name: DOMAIN, content: '203.0.113.9' }])
    await ph.saveState(DOMAIN, {
      zoneId: theirs.id, zoneCreatedByUs: true, addedRecordIds: [],
    }, dir)

    const r = await ph.undo(DOMAIN, 'test-token-good', { dir })
    assert.equal(r.ok, true)
    assert.equal(r.zoneDeleted, false)
    assert.match(r.keptBecause, /not written by this run/)
    assert.equal(api.deletedZones.length, 0)
  })
})

test('verify says wait, not fail, while the new nameservers are still coming up', async () => {
  await withMock({}, async ({ dir }) => {
    await discovered(dir)
    await ph.validate(DOMAIN, 'test-token-good', { dir })
    await ph.prepare(DOMAIN, 'test-token-good', { dir })

    const r = await ph.verify(DOMAIN, { dir, dns: fakeDns(), resolve4: async () => [] })
    assert.equal(r.ok, false)
    assert.match(r.stop, /do not resolve yet/)
    assert.equal((await ph.loadState(DOMAIN, dir)).verifiedAt, undefined)
  })
})

test('verify refuses when a record did not make it across, and names it', async () => {
  const missing = `google._domainkey.${DOMAIN} TXT v=DKIM1; k=rsa; p=MII`
  await withMock({}, async ({ dir }) => {
    await discovered(dir)
    await ph.validate(DOMAIN, 'test-token-good', { dir })
    await ph.prepare(DOMAIN, 'test-token-good', { dir })

    const r = await ph.verify(DOMAIN, {
      dir,
      resolve4: resolves,
      sleep: async () => {},
      dns: fakeDns({ compare: async () => ({ total: 8, missing: [missing], extra: [], ready: false }) }),
    })
    assert.equal(r.ok, false)
    assert.deepEqual(r.diff.missing, [missing])
    assert.equal((await ph.loadState(DOMAIN, dir)).verifiedAt, null, 'a stale pass was left in the file')
  })
})

test('incident: verify called its own writes missing, seconds after making them', async () => {
  // mumchimp.com, 2026-08-22. prepare wrote all 8 records and verify, running
  // immediately after in the same process, reported all 8 missing and printed
  // "NOT READY. Do not touch the registrar." The records were there: the same
  // command 40 seconds later said Identical, and dig against both Cloudflare
  // nameservers answered correctly the whole time.
  //
  // The gate was right to be strict and wrong to be instant. A false NOT READY
  // teaches the reader to re-run the gate until it agrees with them, which is
  // exactly the habit that puts a half-written zone onto a live domain.
  let asked = 0
  const slept = []
  await withMock({}, async ({ dir }) => {
    await discovered(dir)
    await ph.validate(DOMAIN, 'test-token-good', { dir })
    await ph.prepare(DOMAIN, 'test-token-good', { dir })

    const r = await ph.verify(DOMAIN, {
      dir,
      resolve4: resolves,
      sleep: async (ms) => { slept.push(ms) },
      // The edge catches up on the third question, as it did for real.
      dns: fakeDns({
        compare: async () => (++asked >= 3
          ? { total: 8, missing: [], extra: [], ready: true }
          : { total: 8, missing: ['not answered yet'], extra: [], ready: false }),
      }),
    })

    assert.equal(r.ok, true, 'verify still reports its own writes as missing')
    assert.equal(asked, 3, 'it did not ask again')
    assert.equal(slept.length, 2, 'it retried without waiting, so the retry proves nothing')
    assert.ok(slept.every((ms) => ms > 0))
    assert.ok((await ph.loadState(DOMAIN, dir)).verifiedAt, 'the pass was not recorded')
  })
})

test('verify still refuses when the records really are missing, however long it waits', async () => {
  // The other half of the incident fix. Waiting must not become agreeing.
  await withMock({}, async ({ dir }) => {
    await discovered(dir)
    await ph.validate(DOMAIN, 'test-token-good', { dir })
    await ph.prepare(DOMAIN, 'test-token-good', { dir })

    const r = await ph.verify(DOMAIN, {
      dir,
      resolve4: resolves,
      sleep: async () => {},
      dns: fakeDns({ compare: async () => ({ total: 8, missing: ['gone'], extra: [], ready: false }) }),
    })
    assert.equal(r.ok, false, 'the retry loop turned a real failure into a pass')
    assert.equal((await ph.loadState(DOMAIN, dir)).verifiedAt, null)
  })
})

test('every phase refuses to run before the one it depends on', async () => {
  await withMock({}, async ({ dir }) => {
    assert.match((await ph.validate(DOMAIN, 'test-token-good', { dir })).stop, /run discover first/)
    assert.match((await ph.prepare(DOMAIN, 'test-token-good', { dir })).stop, /run validate first/)
    assert.match((await ph.verify(DOMAIN, { dir, dns: fakeDns() })).stop, /run prepare first/)
    assert.match((await ph.cutover(DOMAIN, { dir, dns: fakeDns() })).stop, /verify has not passed/)
    assert.match((await ph.lockdown(DOMAIN, { dir, dns: fakeDns() })).stop, /no target nameserver set/)
  })
})

test('cutover refuses a stale verify and a locked registrar, and never touches either', async () => {
  await withMock({}, async ({ dir }) => {
    await ph.saveState(DOMAIN, {
      oldNameServers: OLD_NS,
      newNameServers: ['danica.ns.cloudflare.com', 'kai.ns.cloudflare.com'],
      verifiedAt: new Date().toISOString(),
    }, dir)

    const stale = await ph.cutover(DOMAIN, { dir, dns: fakeDns(), now: Date.now() + ph.VERIFY_TTL_MS + 1000 })
    assert.equal(stale.ok, false)
    assert.match(stale.stop, /run verify again/)

    // The one that produced "Invalid nameservers" at 123-reg with nothing wrong
    // with the nameservers. clientUpdateProhibited blocks the change; the form
    // reports it as a problem with what was typed.
    const locked = await ph.cutover(DOMAIN, {
      dir,
      dns: fakeDns({ registrarLock: async () => ({ known: true, locked: true, statuses: ['clientUpdateProhibited'] }) }),
    })
    assert.equal(locked.ok, false)
    assert.match(locked.stop, /locked at the registrar/)
    assert.deepEqual(locked.statuses, ['clientUpdateProhibited'])

    const ok = await ph.cutover(DOMAIN, { dir, dns: fakeDns() })
    assert.equal(ok.ok, true)
    assert.equal(ok.manual, true, 'the tool claimed it could change the registrar itself')
    assert.deepEqual(ok.from, OLD_NS)
  })
})

test('lockdown fails while any resolver is still answering with the old nameservers', async () => {
  const want = ['danica.ns.cloudflare.com', 'kai.ns.cloudflare.com']
  await withMock({}, async ({ dir }) => {
    await ph.saveState(DOMAIN, { newNameServers: want }, dir)

    const behind = await ph.lockdown(DOMAIN, {
      dir,
      dns: fakeDns(),
      resolvers: { '1.1.1.1': '1.1.1.1', '8.8.8.8': '8.8.8.8' },
      ask: async (_d, ip) => (ip === '8.8.8.8' ? OLD_NS : want),
    })
    assert.equal(behind.ok, false)
    assert.match(behind.stop, /8\.8\.8\.8 still answer/)

    // Propagated everywhere, but the door was left open.
    const open = await ph.lockdown(DOMAIN, {
      dir, dns: fakeDns(), resolvers: { '1.1.1.1': '1.1.1.1' }, ask: async () => want,
    })
    assert.equal(open.ok, false)
    assert.match(open.stop, /lock is still off/)

    const shut = await ph.lockdown(DOMAIN, {
      dir,
      resolvers: { '1.1.1.1': '1.1.1.1' },
      ask: async () => want,
      dns: fakeDns({ registrarLock: async () => ({ known: true, locked: true, statuses: ['clientUpdateProhibited'] }) }),
    })
    assert.equal(shut.ok, true)
    assert.ok((await ph.loadState(DOMAIN, dir)).lockedDownAt)
  })
})

test('the mock answers GET /accounts the way the real API does', async () => {
  // Measured on the live API and got wrong twice: a zone-scoped token reads
  // 200 with an empty list, not 403. The old code stopped there saying the
  // token needed Account:Read. It does not - POST /zones with no account
  // attaches the zone to the only account the credential belongs to.
  await withMock({}, async ({ url }) => {
    const r = await fetch(`${url}/client/v4/accounts?per_page=5`, {
      headers: { authorization: 'Bearer test-token-good' },
    })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(body.success, true)
    assert.deepEqual(body.result, [])
  })
})
