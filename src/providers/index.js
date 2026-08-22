// A provider is four functions. Adding AWS or GCP means adding one file here
// and one line in DRIVERS — nothing else in the control plane changes.
//
//   provision({ name, region, size, userData, env }) -> { id, ip|null }
//   destroy(id, env)                                 -> void
//   regions()                                        -> string[]
//   defaults()                                       -> { region, size }

import { hetzner } from './hetzner.js'
import { digitalocean } from './digitalocean.js'
import { vultr } from './vultr.js'
import { docker } from './docker.js'

export const DRIVERS = { hetzner, digitalocean, vultr, docker }

export function driverFor(name) {
  const key = String(name ?? '').toLowerCase()
  const alias = { do: 'digitalocean', hz: 'hetzner', vult: 'vultr' }[key] ?? key
  const d = DRIVERS[alias]
  if (!d) throw new Error(`unknown provider: ${name}. known: ${Object.keys(DRIVERS).join(', ')}`)
  return d
}

export function b64(str) {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// A 429 is a wait, not a failure. Anything else fails fast so the caller can
// move to the next provider instead of burning the cold-start window.
export async function requestWithBackoff(url, init, { attempts = 4 } = {}) {
  const delays = [5000, 10000, 20000, 40000]
  let last
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, init)
    if (res.status !== 429 && res.status < 500) return res
    last = res
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delays[i]))
  }
  return last
}
