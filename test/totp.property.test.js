// Rung 2: properties. Seven of these replace several hundred example cases and
// survive any rewrite of the implementation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { base32Encode, base32Decode, totp, verifyTotp, counterFor } from '../src/totp.js'
import { rng } from './helpers/fakes.js'

const SEED = 20260822
const CASES = 200

function randomSecret(next, len = 20) {
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = Math.floor(next() * 256)
  return base32Encode(bytes)
}

test('property: base32 round-trips any byte string', () => {
  const next = rng(SEED)
  for (let i = 0; i < CASES; i++) {
    const len = 1 + Math.floor(next() * 40)
    const bytes = new Uint8Array(len)
    for (let j = 0; j < len; j++) bytes[j] = Math.floor(next() * 256)
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes, `len=${len}`)
  }
})

test('property: a code generated now verifies now', async () => {
  const next = rng(SEED + 1)
  for (let i = 0; i < CASES; i++) {
    const secret = randomSecret(next)
    const now = Math.floor(next() * 4e12)
    const code = await totp(secret, { now })
    assert.equal(await verifyTotp(secret, code, { now }), counterFor(now))
  }
})

test('property: a code from one secret does not verify against another', async () => {
  const next = rng(SEED + 2)
  for (let i = 0; i < CASES; i++) {
    const a = randomSecret(next)
    const b = randomSecret(next)
    const now = Math.floor(next() * 4e12)
    const code = await totp(a, { now })
    assert.equal(await verifyTotp(b, code, { now }), null)
  }
})

test('property: drift inside the window passes, one step outside fails', async () => {
  const next = rng(SEED + 3)
  for (let i = 0; i < 60; i++) {
    const secret = randomSecret(next)
    const now = Math.floor(next() * 4e12)
    const code = await totp(secret, { now })
    for (const drift of [-1, 0, 1]) {
      assert.notEqual(await verifyTotp(secret, code, { now: now + drift * 30_000 }), null,
        `drift ${drift} should be accepted`)
    }
    for (const drift of [-2, 2, 5, -9]) {
      assert.equal(await verifyTotp(secret, code, { now: now + drift * 30_000 }), null,
        `drift ${drift} must be rejected`)
    }
  }
})

test('property: malformed input is always rejected, never thrown', async () => {
  const secret = 'JBSWY3DPEHPK3PXP'
  const junk = ['', '     ', '12345', '1234567', 'abcdef', '12 34 56', null, undefined,
    '000000\n', '٠١٢٣٤٥', '<script>', '1e5', '-12345', {}, []]
  for (const bad of junk) {
    assert.equal(await verifyTotp(secret, bad, { now: 1e12 }), null, `rejected: ${String(bad)}`)
  }
})

test('property: verification never depends on wall-clock reading twice', async () => {
  // A code minted at the boundary of a step must still verify one tick later.
  const next = rng(SEED + 4)
  for (let i = 0; i < 60; i++) {
    const secret = randomSecret(next)
    const boundary = Math.floor(next() * 1e11) * 30_000
    const code = await totp(secret, { now: boundary + 29_999 })
    assert.notEqual(await verifyTotp(secret, code, { now: boundary + 30_001 }), null)
  }
})

test('incident: a bad base32 secret refuses rather than authenticating', async () => {
  await assert.rejects(() => totp('not-base32!!', { now: 1e12 }))
})
