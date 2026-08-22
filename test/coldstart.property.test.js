// The nonce is the whole security of the callback and the whole correctness of
// the cold start. These are properties of that lifecycle, not of the functions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startColdStart, handleCallback, sweepStale, promote, STALE_MS, isIpv4 } from '../src/coldstart.js'
import { getBoxes, setBox, getJob } from '../src/state.js'
import { baseEnv, installFetch, rng } from './helpers/fakes.js'

test('property: any well-formed IPv4 passes, anything else does not', () => {
  const next = rng(7)
  for (let i = 0; i < 300; i++) {
    const o = () => Math.floor(next() * 256)
    assert.ok(isIpv4(`${o()}.${o()}.${o()}.${o()}`))
  }
  for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.-1', 'a.b.c.d',
    '1.2.3.4 ', ' 1.2.3.4', '01.2.3.4\n', '::1', '1.2.3.04x', null, undefined, 12]) {
    assert.equal(isIpv4(bad), false, `must reject ${String(bad)}`)
  }
})

test('property: a nonce works exactly once', async () => {
  const net = installFetch()
  try {
    for (const provider of ['hetzner', 'digitalocean', 'vultr']) {
      const env = baseEnv()
      const job = await startColdStart(env, { provider, role: 'primary', now: 1000 })
      const body = { nonce: job.nonce, ip: '203.0.113.7', health: 'ok' }

      const first = await handleCallback(env, body, 1000 + 400_000)
      assert.equal(first.status, 200, `${provider} first callback`)

      const replay = await handleCallback(env, body, 1000 + 401_000)
      assert.equal(replay.status, 404, `${provider} replay must be refused`)
    }
  } finally { net.restore() }
})

test('property: an unknown or tampered nonce changes nothing', async () => {
  const net = installFetch()
  try {
    const next = rng(11)
    for (let i = 0; i < 25; i++) {
      const env = baseEnv()
      const job = await startColdStart(env, { provider: 'hetzner', now: 0 })
      const dnsBefore = net.to('dns_records').length

      const forged = job.nonce.slice(0, -1) + (job.nonce.endsWith('a') ? 'b' : 'a')
      const res = await handleCallback(env, { nonce: forged, ip: '198.51.100.5', health: 'ok' }, 1000)

      assert.equal(res.status, 404)
      assert.equal(net.to('dns_records').length, dnsBefore, 'DNS must not move for a forged nonce')
      assert.notEqual(await getJob(env, job.nonce), null, 'the real job must survive a forgery')
    }
  } finally { net.restore() }
})

test('a healthy primary callback moves DNS; a standby callback does not', async () => {
  const net = installFetch()
  try {
    const envP = baseEnv()
    const jobP = await startColdStart(envP, { provider: 'hetzner', role: 'primary', now: 0 })
    await handleCallback(envP, { nonce: jobP.nonce, ip: '203.0.113.9', health: 'ok' }, 300_000)
    const apex = net.calls.filter((c) => c.url.endsWith('/dns_records/rec1') && c.method === 'PATCH')
    assert.ok(apex.length >= 1, 'apex record patched for primary')
    assert.equal((await getBoxes(envP)).primary.ip, '203.0.113.9')

    const before = net.calls.filter((c) => c.url.endsWith('/dns_records/rec1') && c.method === 'PATCH').length
    const envS = baseEnv()
    const jobS = await startColdStart(envS, { provider: 'vultr', role: 'standby', now: 0 })
    await handleCallback(envS, { nonce: jobS.nonce, ip: '203.0.113.10', health: 'ok' }, 300_000)
    const after = net.calls.filter((c) => c.url.endsWith('/dns_records/rec1') && c.method === 'PATCH').length
    assert.equal(after, before, 'a standby must never take the apex record')
    assert.equal((await getBoxes(envS)).standby.ip, '203.0.113.10')
  } finally { net.restore() }
})

test('an unhealthy callback leaves the box up and DNS alone', async () => {
  const net = installFetch()
  try {
    const env = baseEnv()
    const job = await startColdStart(env, { provider: 'hetzner', role: 'primary', now: 0 })
    const patches = () => net.calls.filter((c) => c.url.endsWith('/dns_records/rec1') && c.method === 'PATCH').length
    const before = patches()
    const res = await handleCallback(env, { nonce: job.nonce, ip: '203.0.113.11', health: 'unhealthy' }, 400_000)
    assert.equal(res.status, 200)
    assert.equal(patches(), before, 'a sick box must not receive traffic')
    assert.equal((await getBoxes(env)).primary, null)
    assert.equal(net.to('/servers/900').filter((c) => c.method === 'DELETE').length, 0,
      'the box stays up so a human can look at it')
  } finally { net.restore() }
})

test('property: the sweep destroys jobs past 15 minutes and only those', async () => {
  const net = installFetch()
  try {
    const next = rng(23)
    for (let i = 0; i < 20; i++) {
      const env = baseEnv()
      const age = Math.floor(next() * 40 * 60 * 1000) // 0–40 minutes
      const job = await startColdStart(env, { provider: 'hetzner', now: 0 })
      const swept = await sweepStale(env, age)
      const shouldSweep = age >= STALE_MS
      assert.equal(swept.length, shouldSweep ? 1 : 0, `age ${age}ms`)
      assert.equal(await getJob(env, job.nonce) === null, shouldSweep)
    }
  } finally { net.restore() }
})

test('a shadow test destroys its box and records the RTO', async () => {
  const net = installFetch()
  try {
    const env = baseEnv()
    const job = await startColdStart(env, { provider: 'vultr', shadow: true, now: 0 })
    await handleCallback(env, { nonce: job.nonce, ip: '203.0.113.12', health: 'ok', shadow: true }, 343_000)
    const deletes = net.calls.filter((c) => c.method === 'DELETE' && c.url.includes('api.vultr.com'))
    assert.equal(deletes.length, 1, 'the shadow box must not be left running')
    const last = JSON.parse(await env.STATE.get('shadow:last'))
    assert.equal(last.ok, true)
    assert.equal(last.rtoMs, 343_000)
    assert.equal((await getBoxes(env)).primary, null, 'a shadow test never becomes a real box')
  } finally { net.restore() }
})

test('promote refuses when there is no standby', async () => {
  const net = installFetch()
  try {
    const env = baseEnv()
    await assert.rejects(() => promote(env), /no standby/)
    await setBox(env, 'standby', { ip: '203.0.113.20', provider: 'digitalocean', providerId: '5', region: 'ams3' })
    const r = await promote(env, 9_000)
    assert.equal(r.to, '203.0.113.20')
    const boxes = await getBoxes(env)
    assert.equal(boxes.primary.ip, '203.0.113.20')
    assert.equal(boxes.standby, null, 'the standby slot is empty until a new one is built')
    assert.equal(boxes.lastFailover.to, '203.0.113.20')
  } finally { net.restore() }
})
