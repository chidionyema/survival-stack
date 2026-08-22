import { driverFor } from './providers/index.js'
import { renderCloudInit } from './cloudinit.js'
import { newNonce, nonceEqual } from './auth.js'
import { audit } from './audit.js'
import { pointAt, upsertRecord, originHost } from './dns.js'
import * as tg from './telegram.js'
import {
  putJob, getJob, dropJob, openJobs, setBox, getBoxes, recordFailover, setLastShadow,
} from './state.js'

export const STALE_MS = 15 * 60 * 1000

// The default is the only value production uses. The lab shortens it so the
// sweep can be tested against a real provider in a minute instead of fifteen.
const staleMs = (env) => {
  const n = Number(env?.STALE_MS)
  return Number.isFinite(n) && n > 0 ? n : STALE_MS
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
export const isIpv4 = (s) => typeof s === 'string' && IPV4.test(s)

function mins(ms) {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export async function startColdStart(env, opts) {
  const { provider, role = 'primary', shadow = false, messageId = null, image = null, now = Date.now() } = opts
  const driver = driverFor(provider)
  const d = driver.defaults()
  const region = opts.region ?? d.region
  const size = opts.size ?? d.size

  const nonce = newNonce()
  const name = `survival-${shadow ? 'shadow' : role}-${nonce.slice(0, 8)}`
  const userData = renderCloudInit(env, {
    role: shadow ? 'standby' : role, // a shadow box never runs the backup sidecar
    nonce,
    callbackUrl: `${env.CONTROL_URL}/im-alive`,
    originHost: shadow ? `shadow.${env.DOMAIN}` : originHost(env, role),
    shadow,
    image,
  })

  const { id, ip } = await driver.provision({ name, region, size, userData, env })
  const job = await putJob(env, {
    nonce, provider: driver.name, providerId: id, role, shadow, name, image,
    region, size, startedAt: now, messageId, state: 'provisioning', bootIp: ip,
  })
  await audit(env, 'coldstart.started', { provider: driver.name, role, region, size, name, shadow, image })
  return job
}

export async function handleCallback(env, body, now = Date.now()) {
  const job = await getJob(env, String(body?.nonce ?? ''))
  // An unknown or spent nonce gets the same answer as a wrong one.
  if (!job || job.state !== 'provisioning' || !nonceEqual(job.nonce, body.nonce)) {
    await audit(env, 'callback.rejected', { ip: body?.ip })
    return { status: 404, body: { ok: false } }
  }
  if (!isIpv4(body.ip)) {
    await audit(env, 'callback.bad_ip', { nonce: job.nonce })
    return { status: 400, body: { ok: false, error: 'bad ip' } }
  }

  await dropJob(env, job.nonce) // single use, burned before any side effect
  const elapsed = now - job.startedAt
  const healthy = body.health === 'ok'

  if (job.shadow) {
    let destroyed = true
    try {
      await driverFor(job.provider).destroy(job.providerId, env)
    } catch (err) {
      destroyed = false
      await audit(env, 'shadow.destroy_failed', { provider: job.provider, error: String(err) })
    }
    const result = {
      at: new Date(now).toISOString(), provider: job.provider, ok: healthy,
      rtoMs: elapsed, destroyed,
    }
    await setLastShadow(env, result)
    await audit(env, 'shadow.finished', result)
    await tg.send(
      env,
      healthy
        ? `✅ Shadow test on ${job.provider} passed. RTO: ${mins(elapsed)}.` +
          (destroyed ? '' : '\n⚠️ The test box did NOT destroy. Check the console.')
        : `❌ Shadow test on ${job.provider} failed to come up healthy after ${mins(elapsed)}.`,
    )
    return { status: 200, body: { ok: true, shadow: true } }
  }

  if (!healthy) {
    await audit(env, 'coldstart.unhealthy', { provider: job.provider, role: job.role })
    await tg.edit(env, job.messageId,
      `❌ ${job.role} on ${job.provider} booted but is not healthy after ${mins(elapsed)}.\n` +
      `Box left running for inspection: ${body.ip}`)
    return { status: 200, body: { ok: true, healthy: false } }
  }

  const box = {
    ip: body.ip, provider: job.provider, providerId: job.providerId,
    region: job.region, since: new Date(now).toISOString(),
  }
  await setBox(env, job.role, box)
  await upsertRecord(env, originHost(env, job.role), body.ip, false)
  let dns = null
  if (job.role === 'primary') dns = await pointAt(env, body.ip)

  await audit(env, 'coldstart.complete', {
    provider: job.provider, role: job.role, ip: body.ip, elapsedMs: elapsed, dns,
  })
  await tg.edit(env, job.messageId,
    `✅ Cold start complete.\n` +
    `<b>${job.role}</b> on ${job.provider}/${job.region}\n` +
    `IP: <code>${body.ip}</code>\n` +
    `Time: ${mins(elapsed)}${dns ? `\nDNS → ${dns}` : ''}`)
  return { status: 200, body: { ok: true } }
}

// A box that never reports in is the only failure mode the callback cannot see.
export async function sweepStale(env, now = Date.now()) {
  const swept = []
  for (const job of await openJobs(env)) {
    if (now - job.startedAt < staleMs(env)) continue
    await dropJob(env, job.nonce)
    let destroyed = false
    try {
      await driverFor(job.provider).destroy(job.providerId, env)
      destroyed = true
    } catch (err) {
      await audit(env, 'sweep.destroy_failed', { provider: job.provider, error: String(err) })
    }
    await audit(env, 'coldstart.timeout', { provider: job.provider, role: job.role, destroyed })
    await tg.edit(env, job.messageId,
      `❌ ${job.shadow ? 'Shadow test' : `Cold start (${job.role})`} on ${job.provider} ` +
      `never reported in after ${mins(staleMs(env))}.\n${destroyed ? 'Box destroyed.' : '⚠️ Box could NOT be destroyed — check the provider console.'}\n` +
      `Retry: <code>/cold-start ${job.provider}</code>`)
    swept.push(job.nonce)
  }
  return swept
}

export async function promote(env, now = Date.now()) {
  const boxes = await getBoxes(env)
  if (!boxes.standby) throw new Error('no standby recorded — nothing to promote')
  const from = boxes.primary?.ip ?? null
  await pointAt(env, boxes.standby.ip)
  await setBox(env, 'primary', { ...boxes.standby, since: new Date(now).toISOString() })
  await setBox(env, 'standby', null)
  await upsertRecord(env, originHost(env, 'primary'), boxes.standby.ip, false)
  await recordFailover(env, new Date(now).toISOString(), from, boxes.standby.ip)
  await audit(env, 'promote', { from, to: boxes.standby.ip })
  return { from, to: boxes.standby.ip }
}

export async function destroyBox(env, ip) {
  const boxes = await getBoxes(env)
  const role = Object.keys(boxes).find((r) => boxes[r]?.ip === ip)
  if (!role) throw new Error(`no box on record with ip ${ip}`)
  await driverFor(boxes[role].provider).destroy(boxes[role].providerId, env)
  await setBox(env, role, null)
  await audit(env, 'destroy', { role, ip, provider: boxes[role].provider })
  return { role, ip }
}

export function pickShadowProvider(env, seed) {
  const list = String(env.SHADOW_PROVIDERS ?? 'hetzner').split(',').map((s) => s.trim()).filter(Boolean)
  return list[seed % list.length]
}
