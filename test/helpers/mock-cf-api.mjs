/**
 * Mock Cloudflare API Server
 * Single file, stateful, queryable call order, failure-injection ready.
 *
 * Usage:
 *   node test/helpers/mock-cf-api.mjs        # start server on :9999
 *   CF_API_BASE=http://localhost:9999 node scripts/migrate-domain.mjs mumchimp.com
 *
 *   import { createMockServer, scenarios } from './mock-cf-api.mjs'
 *   const { server, api, url } = await createMockServer({ port: 0 })
 *   // run tests
 *   server.close()
 *
 * ---------------------------------------------------------------------------
 * Five changes from the version this was written as, each one measured against
 * the real API or against what the code under test actually calls:
 *
 *  1. GET /accounts exists and answers 200 with an empty list for a zone-scoped
 *     token. Real Cloudflare does not 403 there, and zone.mjs:accountId reads
 *     the empty list as "no account id to send", which is the normal path. A
 *     404 here would have broken every run against the mock.
 *  2. Failure injection counts. `{ 'POST /zones/*\/dns_records': { status: 500,
 *     failAfter: 3 } }` lets the 4th record be the one refused, which is the
 *     only way to express "three written, then refused" - the partial write
 *     this whole harness exists for. A bare status still fails every call.
 *  3. POST /zones returns name_servers. phases.mjs:validate stores them and
 *     verify resolves them, so a zone without them is a zone no later phase
 *     can use.
 *  4. Every server owns its own state, in a closure. Module-level state means
 *     two servers in one process share zones and call logs, and node --test
 *     runs files in parallel.
 *  5. createdZones and deletedZones report what the server actually did, not
 *     what was asked for. A DELETE that came back 403 is not a deletion, and
 *     the invariant "it never deleted their zone" has to be able to tell.
 */

import http from 'http'
import { randomUUID } from 'crypto'

const MUTATING = ['POST', 'PUT', 'DELETE', 'PATCH']

// Cloudflare's envelope. Errors carry a message; zone.mjs reads errors[0].
function send(res, status, data, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    success: status < 400,
    errors: status >= 400 ? [{ code: status * 10, message: message || 'error' }] : [],
    messages: [],
    result: status < 400 ? data : null,
  }))
}

const NS = ['danica.ns.cloudflare.com', 'kai.ns.cloudflare.com']

export async function createMockServer(opts = {}) {
  // Per-server, not module-level. See note 4 above.
  const state = {
    zones: new Map(),   // id -> { id, name, status, name_servers, dns_records: Map }
    tokens: new Map(),  // token -> { permissions, status }
    accounts: opts.accounts || [],
    calls: [],
    createdZoneIds: [],
    deletedZoneIds: [],
  }
  const config = {
    port: opts.port ?? 9999,
    injectFailures: opts.injectFailures || {},
    slowEndpoints: opts.slowEndpoints || {},
  }
  const injectCounts = new Map()

  if (opts.tokens) {
    for (const [token, perms] of Object.entries(opts.tokens)) {
      state.tokens.set(token, { permissions: perms, status: 'active' })
    }
  } else {
    state.tokens.set('test-token-good', { permissions: ['zone:read', 'zone:edit', 'dns_records:edit'], status: 'active' })
    state.tokens.set('test-token-no-zone-read', { permissions: ['dns_records:edit'], status: 'active' })
    state.tokens.set('test-token-no-dns-edit', { permissions: ['zone:read', 'zone:edit'], status: 'active' })
    state.tokens.set('test-token-no-zone-edit', { permissions: ['zone:read', 'dns_records:edit'], status: 'active' })
    state.tokens.set('test-token-invalid', { permissions: [], status: 'inactive' })
  }

  const tokenOf = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const perm = (req, p) => {
    const t = state.tokens.get(tokenOf(req))
    return Boolean(t) && t.status === 'active' && t.permissions.includes(p)
  }

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handlers = {
    // Real CF returns {id, status} only. No policies here - which is why the
    // code grades a token by using it, not by reading what it claims to be.
    'GET /user/tokens/verify': (req, res) => {
      const t = state.tokens.get(tokenOf(req))
      if (!t || t.status !== 'active') return send(res, 401, null, 'Invalid API Token')
      send(res, 200, { id: randomUUID().replace(/-/g, ''), status: t.status })
    },

    // Measured on the live API: a token scoped to zones and not to the account
    // gets 200 and an empty list here, never a 403.
    'GET /accounts': (req, res) => {
      if (!state.tokens.get(tokenOf(req))) return send(res, 401, null, 'Invalid API Token')
      send(res, 200, state.accounts)
    },

    'GET /zones': (req, res, _body, _params, url) => {
      if (!perm(req, 'zone:read')) return send(res, 403, null, 'Authentication error')
      const name = url.searchParams.get('name')
      let zones = [...state.zones.values()].map(publicZone)
      if (name) zones = zones.filter((z) => z.name === name)
      send(res, 200, zones)
    },

    'POST /zones': (req, res, body) => {
      if (!perm(req, 'zone:edit')) return send(res, 403, null, 'Authentication error')
      if (!body?.name) return send(res, 400, null, 'Missing name')
      const zone = {
        id: randomUUID().replace(/-/g, ''),
        name: body.name,
        status: 'pending',
        name_servers: NS,
        dns_records: new Map(),
        created_at: '2026-08-22T00:00:00.000Z',
      }
      state.zones.set(zone.id, zone)
      state.createdZoneIds.push(zone.id)
      send(res, 200, publicZone(zone))
    },

    'DELETE /zones/:id': (req, res, _body, p) => {
      if (!perm(req, 'zone:edit')) return send(res, 403, null, 'Authentication error')
      if (!state.zones.has(p.id)) return send(res, 404, null, 'Zone not found')
      state.zones.delete(p.id)
      state.deletedZoneIds.push(p.id)
      send(res, 200, { id: p.id })
    },

    // The DNS-write probe is a read. One Cloudflare permission covers reading
    // and writing records, so a GET that comes back 200 proves the write will
    // be allowed - and unlike a throwaway TXT it cannot leave one behind.
    'GET /zones/:id/dns_records': (req, res, _body, p, url) => {
      if (!perm(req, 'dns_records:edit') && !perm(req, 'dns_records:read')) {
        return send(res, 403, null, 'Authentication error')
      }
      const zone = state.zones.get(p.id)
      if (!zone) return send(res, 404, null, 'Zone not found')
      const all = [...zone.dns_records.values()]
      const per = Number(url.searchParams.get('per_page') || 100)
      const page = Number(url.searchParams.get('page') || 1)
      send(res, 200, all.slice((page - 1) * per, page * per))
    },

    'POST /zones/:id/dns_records': (req, res, body, p) => {
      if (!perm(req, 'dns_records:edit')) return send(res, 403, null, 'Authentication error')
      const zone = state.zones.get(p.id)
      if (!zone) return send(res, 404, null, 'Zone not found')
      const record = {
        id: randomUUID().replace(/-/g, ''),
        type: body.type,
        name: body.name,
        content: body.content,
        ttl: body.ttl || 1,
        proxied: body.proxied || false,
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
      }
      zone.dns_records.set(record.id, record)
      send(res, 200, record)
    },

    'PUT /zones/:id/dns_records/:record_id': (req, res, body, p) => {
      if (!perm(req, 'dns_records:edit')) return send(res, 403, null, 'Authentication error')
      const zone = state.zones.get(p.id)
      if (!zone) return send(res, 404, null, 'Zone not found')
      const record = zone.dns_records.get(p.record_id)
      if (!record) return send(res, 404, null, 'Record not found')
      Object.assign(record, body)
      send(res, 200, record)
    },

    'DELETE /zones/:id/dns_records/:record_id': (req, res, _body, p) => {
      if (!perm(req, 'dns_records:edit')) return send(res, 403, null, 'Authentication error')
      const zone = state.zones.get(p.id)
      if (!zone) return send(res, 404, null, 'Zone not found')
      if (!zone.dns_records.delete(p.record_id)) return send(res, 404, null, 'Record not found')
      send(res, 200, { id: p.record_id })
    },
  }

  const publicZone = (z) => ({
    id: z.id, name: z.name, status: z.status, name_servers: z.name_servers, created_at: z.created_at,
  })

  // ─── Router ───────────────────────────────────────────────────────────────

  function matchRoute(method, path) {
    const exact = handlers[`${method} ${path}`]
    if (exact) return { handler: exact, params: {} }
    for (const [pattern, handler] of Object.entries(handlers)) {
      const [pMethod, pPath] = pattern.split(' ')
      if (pMethod !== method) continue
      const pParts = pPath.split('/')
      const parts = path.split('/')
      if (pParts.length !== parts.length) continue
      const params = {}
      let ok = true
      for (let i = 0; i < pParts.length; i++) {
        if (pParts[i].startsWith(':')) params[pParts[i].slice(1)] = parts[i]
        else if (pParts[i] !== parts[i]) { ok = false; break }
      }
      if (ok) return { handler, params }
    }
    return null
  }

  // ─── Failure injection ────────────────────────────────────────────────────

  // A pattern is 'METHOD /path/with/*/wildcards'. The value is either a status
  // code, or { status, failAfter } - failAfter: 3 lets three matching calls
  // through and refuses the fourth, which is the partial-write case.
  function injected(method, path) {
    for (const [pattern, spec] of Object.entries(config.injectFailures)) {
      const [m, p] = pattern.split(' ')
      if (m !== '*' && m !== method) continue
      if (!new RegExp('^' + p.replace(/\*/g, '[^/]+') + '$').test(path)) continue
      const status = typeof spec === 'object' ? spec.status : spec
      const after = typeof spec === 'object' ? (spec.failAfter || 0) : 0
      const seen = (injectCounts.get(pattern) || 0) + 1
      injectCounts.set(pattern, seen)
      if (seen > after) return status
    }
    return null
  }

  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString()
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { return send(res, 400, null, 'Bad JSON') }

    const url = new URL(req.url, 'http://localhost')
    // The tool sets CF_API_BASE to this server's origin and appends
    // /client/v4 itself, exactly as it does against the real API. Routes are
    // written without that prefix, so it comes off here.
    const path = url.pathname.replace(/^\/client\/v4/, '') || '/'
    state.calls.push({ method: req.method, path, query: url.search, body, at: state.calls.length })

    const fail = injected(req.method, path)
    if (fail) return send(res, fail, null, `Injected ${fail}`)

    for (const [pattern, ms] of Object.entries(config.slowEndpoints)) {
      const [m, p] = pattern.split(' ')
      if ((m === '*' || m === req.method) && path.includes(p)) {
        await new Promise((r) => setTimeout(r, ms))
      }
    }

    const route = matchRoute(req.method, path)
    if (!route) return send(res, 404, null, 'Not found')
    try {
      await route.handler(req, res, body, route.params, url)
    } catch (e) {
      send(res, 500, null, e.message)
    }
  })

  await new Promise((resolve) => server.listen(config.port, '127.0.0.1', resolve))
  const port = server.address().port

  // ─── What a test can ask the server ───────────────────────────────────────

  const api = {
    get calls() { return [...state.calls] },
    get mutations() { return state.calls.filter((c) => MUTATING.includes(c.method)) },
    // What the server did, not what it was asked to do. A refused DELETE is
    // not a deletion, and the invariants turn on that difference.
    get createdZones() { return [...state.createdZoneIds] },
    get deletedZones() { return [...state.deletedZoneIds] },
    get zoneIds() { return [...state.zones.keys()] },
    get zones() { return new Map(state.zones) },
    get tokens() { return new Map(state.tokens) },
    recordsIn(zoneId) { return [...(state.zones.get(zoneId)?.dns_records.values() || [])] },
    inject(patterns) { Object.assign(config.injectFailures, patterns) },
    setAccounts(list) { state.accounts = list },

    addZone(name, records = [], { status = 'active' } = {}) {
      const id = randomUUID().replace(/-/g, '')
      const zone = { id, name, status, name_servers: NS, dns_records: new Map(), created_at: '2026-08-01T00:00:00.000Z' }
      for (const r of records) {
        const rid = randomUUID().replace(/-/g, '')
        zone.dns_records.set(rid, { id: rid, ttl: 300, proxied: false, ...r })
      }
      state.zones.set(id, zone)
      return zone
    },

    reset() {
      state.zones.clear()
      state.calls.length = 0
      state.createdZoneIds.length = 0
      state.deletedZoneIds.length = 0
      injectCounts.clear()
      config.injectFailures = {}
    },

    // A mutation before any read is the shape of the incident this whole file
    // is about: a zone created by a credential nobody had checked.
    assertNoMutationBeforeARead() {
      const firstMutation = state.calls.findIndex((c) => MUTATING.includes(c.method))
      if (firstMutation === -1) return
      const readsBefore = state.calls.slice(0, firstMutation).filter((c) => c.method === 'GET')
      if (!readsBefore.length) throw new Error('a mutation ran before anything was read')
    },

    assertCallOrder(expected) {
      const actual = state.calls.map((c) => `${c.method} ${c.path}`)
      let from = 0
      for (const want of expected) {
        const at = actual.indexOf(want, from)
        if (at === -1) throw new Error(`expected ${want} after position ${from}, got: ${actual.join(' -> ')}`)
        from = at + 1
      }
    },
  }

  return { server, api, url: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => server.close(r)) }
}

// ─── Standalone ─────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const { api, url } = await createMockServer()
  console.log(`Mock Cloudflare API running at ${url}`)
  console.log('Pre-seeded tokens:')
  for (const [t, v] of api.tokens) console.log(`  ${t} -> ${v.permissions.join(', ') || '(none)'}`)
  console.log('')
  console.log(`  CF_API_BASE=${url} CF_API_TOKEN=test-token-good node scripts/migrate-domain.mjs <domain>`)
  console.log('\nCtrl+C to stop')
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

// The failure matrix, as data. Mutation counts are deliberately absent: the
// probe is a GET, not a POST/DELETE pair, so counting them pins an
// implementation detail rather than a guarantee. What each scenario asserts is
// where it stopped and what it left behind.
export const scenarios = {
  invalidToken: {
    token: 'test-token-invalid',
    zonePreExists: false,
    expect: { stops: /cannot list zones|credential/i, mutations: 0 },
  },
  noZoneRead: {
    token: 'test-token-no-zone-read',
    zonePreExists: true,
    expect: { stops: /cannot list zones/i, need: /Zone → Zone → Read/, mutations: 0 },
  },
  noDnsEditExistingZone: {
    token: 'test-token-no-dns-edit',
    zonePreExists: true,
    expect: { stops: /cannot write DNS/i, need: /DNS/, mutations: 0, zonesDeleted: 0 },
  },
  noDnsEditMissingZone: {
    token: 'test-token-no-dns-edit',
    zonePreExists: false,
    expect: { stops: /cannot write DNS/i, need: /DNS/, createdThenDeleted: true },
  },
  noZoneEdit: {
    token: 'test-token-no-zone-edit',
    zonePreExists: false,
    expect: { stops: /cannot create a zone/i, need: /Zone → Zone → Edit/, zonesCreated: 0 },
  },
  happyCreate: {
    token: 'test-token-good',
    zonePreExists: false,
    expect: { ok: true, zonesCreated: 1 },
  },
  happyExisting: {
    token: 'test-token-good',
    zonePreExists: true,
    expect: { ok: true, zonesCreated: 0 },
  },
  partialFailure: {
    token: 'test-token-good',
    zonePreExists: false,
    injectFailures: { 'POST /zones/*/dns_records': { status: 500, failAfter: 3 } },
    expect: { stops: /records were refused/i, rolledBack: true, recordsLeft: 0, zonesDeleted: 1 },
  },
  partialFailureTheirZone: {
    token: 'test-token-good',
    zonePreExists: true,
    injectFailures: { 'POST /zones/*/dns_records': { status: 500, failAfter: 3 } },
    expect: { stops: /records were refused/i, rolledBack: true, recordsLeft: 1, zonesDeleted: 0 },
  },
}
