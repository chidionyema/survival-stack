// RFC 4648 base32, RFC 4226 HOTP, RFC 6238 TOTP. WebCrypto only, so this runs
// unchanged in a Worker, in Node and in a browser.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')
  if (clean.length === 0) throw new Error('empty base32 secret')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error('bad base32 character: ' + ch)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

export function base32Encode(bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

async function hmacSha1(keyBytes, msgBytes) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes))
}

export async function hotp(secretBytes, counter, digits = 6) {
  const buf = new Uint8Array(8)
  let c = BigInt(counter)
  for (let i = 7; i >= 0; i--) {
    buf[i] = Number(c & 0xffn)
    c >>= 8n
  }
  const mac = await hmacSha1(secretBytes, buf)
  const offset = mac[mac.length - 1] & 0x0f
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff)
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export function counterFor(nowMs, step = 30) {
  return Math.floor(nowMs / 1000 / step)
}

export async function totp(secretB32, { now = Date.now(), step = 30, digits = 6 } = {}) {
  return hotp(base32Decode(secretB32), counterFor(now, step), digits)
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Returns the matched counter (so the caller can burn it against replay), or null.
export async function verifyTotp(secretB32, code, opts = {}) {
  const { now = Date.now(), step = 30, window = 1, digits = 6 } = opts
  const presented = String(code ?? '').trim()
  if (!/^[0-9]+$/.test(presented) || presented.length !== digits) return null
  const secret = base32Decode(secretB32)
  const base = counterFor(now, step)
  let matched = null
  // Every candidate is evaluated: no early return, so timing does not leak which
  // step matched.
  for (let drift = -window; drift <= window; drift++) {
    const candidate = await hotp(secret, base + drift, digits)
    if (constantTimeEqual(candidate, presented) && matched === null) {
      matched = base + drift
    }
  }
  return matched
}
