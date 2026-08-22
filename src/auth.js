import { verifyTotp } from './totp.js'
import { burnCounter } from './state.js'
import { audit } from './audit.js'

// Every action that spends money or moves traffic passes through here.
// A missing secret refuses; it never falls open.
export async function requireTotp(env, code, action) {
  if (!env.TOTP_SECRET) {
    await audit(env, 'auth.misconfigured', { action })
    return { ok: false, reason: 'TOTP is not configured. Refusing.' }
  }
  const counter = await verifyTotp(env.TOTP_SECRET, code)
  if (counter === null) {
    await audit(env, 'auth.rejected', { action })
    return { ok: false, reason: 'Bad or missing TOTP code.' }
  }
  if (!(await burnCounter(env, counter))) {
    await audit(env, 'auth.replay', { action, counter })
    return { ok: false, reason: 'That code was already used. Wait for the next one.' }
  }
  await audit(env, 'auth.accepted', { action, counter })
  return { ok: true, counter }
}

export function newNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The callback carries a nonce, so compare it in constant time too.
export function nonceEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
