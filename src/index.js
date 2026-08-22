// The control plane. Telegram, Lighthouse, cold starts, DNS, shadow tests and
// the audit trail — all of it, on the edge, on no machine you own.

import * as tg from './telegram.js'
import { requireTotp } from './auth.js'
import { audit, recentAudit } from './audit.js'
import { json, serve as serveDegraded } from './degraded.js'
import { getBoxes, lastShadow, openJobs } from './state.js'
import { originHost, currentTarget } from './dns.js'
import { DRIVERS, driverFor } from './providers/index.js'
import {
  startColdStart, handleCallback, sweepStale, promote, destroyBox, pickShadowProvider,
} from './coldstart.js'

const HELP = `<b>Survival Stack</b>
/status — health of both boxes
/verify — full JSON report
/cold-start &lt;provider&gt; [primary|standby] &lt;code&gt;
/promote &lt;code&gt; — standby becomes primary
/deploy &lt;version&gt; &lt;code&gt; — blue/green onto a fresh box
/destroy &lt;ip&gt; &lt;code&gt;
/shadow-test &lt;code&gt;
/help

Providers: ${Object.keys(DRIVERS).join(', ')}
A 6-digit code at the end of the line is your TOTP.`

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    try {
      switch (url.pathname) {
        case '/telegram':
          return await telegramWebhook(request, env, ctx)
        case '/im-alive':
          return await imAlive(request, env)
        case '/api/status':
          return cors(env, json(await status(env)))
        case '/api/verify':
          return cors(env, json(await verify(env)))
        case '/api/audit':
          return cors(env, json({ events: await recentAudit(env, 50) }))
        case '/api/action':
          return cors(env, await apiAction(request, env))
        case '/health':
          return json({ ok: true, service: 'survival-control-plane' })
        default:
          if (request.method === 'OPTIONS') return cors(env, new Response(null, { status: 204 }))
          // Anything else on a customer-facing route is the degraded path.
          return await serveDegraded(env, request, ctx)
      }
    } catch (err) {
      console.error('unhandled', String(err), err?.stack)
      ctx.waitUntil(audit(env, 'error.unhandled', { path: url.pathname, error: String(err) }))
      return json({ ok: false, error: 'internal error' }, 500)
    }
  },

  async scheduled(event, env, ctx) {
    // "0 3 * * SUN" is the shadow test. Everything else is the stale sweep.
    if (event.cron === '0 3 * * SUN') {
      ctx.waitUntil(runShadowTest(env, event.scheduledTime))
    } else {
      ctx.waitUntil(sweepStale(env, event.scheduledTime))
    }
  },
}

// ------------------------------------------------------------------ surfaces

async function telegramWebhook(request, env, ctx) {
  if (!tg.webhookAuthentic(request, env)) {
    await audit(env, 'telegram.forged_webhook', {})
    return new Response('no', { status: 401 })
  }
  const update = await request.json().catch(() => null)
  const msg = update?.message ?? update?.edited_message
  const text = msg?.text
  const chatId = String(msg?.chat?.id ?? '')
  if (!text) return json({ ok: true })

  // One chat owns this bot. Anyone else gets nothing.
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
    await audit(env, 'telegram.wrong_chat', { chatId })
    return json({ ok: true })
  }

  const parsed = tg.parseCommand(text)
  if (!parsed) return json({ ok: true })
  ctx.waitUntil(runCommand(env, parsed))
  return json({ ok: true })
}

async function runCommand(env, { cmd, args, code }) {
  const gate = async (action) => {
    const res = await requireTotp(env, code, action)
    if (!res.ok) await tg.send(env, `🔒 ${res.reason}`)
    return res.ok
  }

  switch (cmd) {
    case 'start':
    case 'help':
      return tg.send(env, HELP)

    case 'status': {
      const s = await status(env)
      return tg.send(env, renderStatus(s))
    }

    case 'verify': {
      const v = await verify(env)
      return tg.send(env, `<pre>${JSON.stringify(v, null, 2)}</pre>`)
    }

    case 'cold-start': {
      const provider = args[0]
      const role = args[1] === 'standby' ? 'standby' : 'primary'
      if (!provider) return tg.send(env, 'Usage: /cold-start &lt;provider&gt; [primary|standby] &lt;code&gt;')
      if (!(await gate(`cold-start:${provider}`))) return
      const messageId = await tg.send(env, `⏳ Cold start: ${provider} (${role}). Creating VM…`)
      try {
        const job = await startColdStart(env, { provider, role, messageId })
        return tg.edit(env, messageId,
          `⏳ VM created on ${job.provider}/${job.region} (${job.size}).\n` +
          `Booting, restoring the database, then it reports in. Typically 5–7 minutes.`)
      } catch (err) {
        await audit(env, 'coldstart.provision_failed', { provider, error: String(err) })
        return tg.edit(env, messageId, `❌ ${provider} refused the request.\n<code>${escapeHtml(String(err))}</code>`)
      }
    }

    case 'deploy': {
      const version = args[0]
      if (!version) return tg.send(env, 'Usage: /deploy &lt;version&gt; &lt;code&gt;')
      if (!(await gate(`deploy:${version}`))) return
      const image = `${String(env.ENGINE_IMAGE).split(':')[0]}:${version}`
      const messageId = await tg.send(env, `⏳ Deploying <code>${escapeHtml(image)}</code> onto a fresh box…`)
      try {
        // Blue/green: a new box runs the new image and DNS moves only when it
        // reports healthy. A bad version never touches the box serving traffic.
        const job = await startColdStart(env, {
          provider: (await getBoxes(env)).primary?.provider ?? 'hetzner',
          role: 'primary',
          messageId,
          image,
        })
        await audit(env, 'deploy.started', { image, provider: job.provider })
        return tg.edit(env, messageId, `⏳ New box on ${job.provider} building ${escapeHtml(version)}. DNS moves only if it comes up healthy.`)
      } catch (err) {
        return tg.edit(env, messageId, `❌ Deploy could not start.\n<code>${escapeHtml(String(err))}</code>`)
      }
    }

    case 'promote': {
      if (!(await gate('promote'))) return
      try {
        const r = await promote(env)
        return tg.send(env, `✅ Promoted. DNS ${r.from ?? '(none)'} → <code>${r.to}</code>.`)
      } catch (err) {
        return tg.send(env, `❌ Promote failed: <code>${escapeHtml(String(err))}</code>`)
      }
    }

    case 'destroy': {
      const ip = args[0]
      if (!ip) return tg.send(env, 'Usage: /destroy &lt;ip&gt; &lt;code&gt;')
      if (!(await gate(`destroy:${ip}`))) return
      try {
        const r = await destroyBox(env, ip)
        return tg.send(env, `✅ Destroyed ${r.role} <code>${r.ip}</code>.`)
      } catch (err) {
        return tg.send(env, `❌ Destroy failed: <code>${escapeHtml(String(err))}</code>`)
      }
    }

    case 'shadow-test': {
      if (!(await gate('shadow-test'))) return
      return runShadowTest(env, Date.now())
    }

    default:
      return tg.send(env, `Unknown command: /${escapeHtml(cmd)}\n\n${HELP}`)
  }
}

async function imAlive(request, env) {
  if (request.method !== 'POST') return json({ ok: false }, 405)
  const body = await request.json().catch(() => ({}))
  const res = await handleCallback(env, body)
  return json(res.body, res.status)
}

// ------------------------------------------------------------------- reports

async function status(env) {
  const [boxes, shadow, jobs] = await Promise.all([getBoxes(env), lastShadow(env), openJobs(env)])
  let dns = null
  try {
    dns = await currentTarget(env)
  } catch (err) {
    dns = { error: String(err) }
  }
  return {
    at: new Date(Date.now()).toISOString(),
    domain: env.DOMAIN,
    dns,
    boxes,
    inFlight: jobs.map((j) => ({ provider: j.provider, role: j.role, startedAt: j.startedAt })),
    lastShadow: shadow,
    providers: Object.keys(DRIVERS),
  }
}

async function probe(env, role) {
  const boxes = await getBoxes(env)
  if (!boxes[role]) return { role, present: false }
  const started = Date.now()
  try {
    const res = await fetch(`https://${originHost(env, role)}/health`, {
      signal: AbortSignal.timeout(8000),
    })
    return {
      role, present: true, ip: boxes[role].ip, provider: boxes[role].provider,
      status: res.status, healthy: res.ok, ms: Date.now() - started,
    }
  } catch (err) {
    return { role, present: true, ip: boxes[role].ip, healthy: false, error: String(err) }
  }
}

async function verify(env) {
  const [primary, standby, s] = await Promise.all([probe(env, 'primary'), probe(env, 'standby'), status(env)])
  const catalog = await env.DATA.head('catalog/packs.json').catch(() => null)
  const queued = await env.DATA.list({ prefix: 'orders/queued/' }).catch(() => ({ objects: [] }))
  return {
    ...s,
    checks: {
      primary, standby,
      degradedCatalogCached: Boolean(catalog),
      queuedOrders: queued.objects.length,
      totpConfigured: Boolean(env.TOTP_SECRET),
      dnsWritable: Boolean(env.CF_API_TOKEN && env.CF_ZONE_ID && env.CF_DNS_RECORD_ID),
    },
  }
}

function renderStatus(s) {
  const line = (role) => {
    const b = s.boxes[role]
    if (!b) return `${role.toUpperCase()}: —`
    return `${role.toUpperCase()}: <code>${b.ip}</code> (${b.provider}/${b.region})`
  }
  return [
    `<b>${s.domain}</b>`,
    line('primary'),
    line('standby'),
    `DNS → <code>${s.dns?.ip ?? s.dns?.error ?? '?'}</code>`,
    s.inFlight.length ? `In flight: ${s.inFlight.length}` : null,
    s.lastShadow
      ? `Last shadow: ${s.lastShadow.ok ? '✅' : '❌'} ${s.lastShadow.provider} (${Math.round(s.lastShadow.rtoMs / 1000)}s) ${s.lastShadow.at.slice(0, 10)}`
      : 'Last shadow: never',
    s.boxes.lastFailover ? `Last failover: ${s.boxes.lastFailover.at}` : 'Last failover: never',
  ].filter(Boolean).join('\n')
}

// -------------------------------------------------------------- shadow tests

async function runShadowTest(env, nowMs) {
  const provider = pickShadowProvider(env, Math.floor(nowMs / 1000))
  const messageId = await tg.send(env, `🧪 Shadow test starting on ${provider}…`)
  try {
    await startColdStart(env, { provider, role: 'standby', shadow: true, messageId, now: nowMs })
  } catch (err) {
    await audit(env, 'shadow.provision_failed', { provider, error: String(err) })
    await tg.edit(env, messageId, `❌ Shadow test could not start on ${provider}.\n<code>${escapeHtml(String(err))}</code>`)
  }
}

// ----------------------------------------------------------- lighthouse api

async function apiAction(request, env) {
  if (request.method !== 'POST') return json({ ok: false }, 405)
  const { action, code, provider, role, ip } = await request.json().catch(() => ({}))
  const gate = await requireTotp(env, code, `api:${action}`)
  if (!gate.ok) return json({ ok: false, error: gate.reason }, 401)

  try {
    switch (action) {
      case 'cold-start': {
        const job = await startColdStart(env, { provider, role: role === 'standby' ? 'standby' : 'primary' })
        return json({ ok: true, job: { provider: job.provider, region: job.region, startedAt: job.startedAt } })
      }
      case 'promote':
        return json({ ok: true, result: await promote(env) })
      case 'destroy':
        return json({ ok: true, result: await destroyBox(env, ip) })
      case 'shadow-test':
        await runShadowTest(env, Date.now())
        return json({ ok: true })
      default:
        return json({ ok: false, error: 'unknown action' }, 400)
    }
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500)
  }
}

function cors(env, res) {
  const h = new Headers(res.headers)
  h.set('access-control-allow-origin', env.LIGHTHOUSE_ORIGIN ?? '*')
  h.set('access-control-allow-headers', 'content-type')
  h.set('access-control-allow-methods', 'GET,POST,OPTIONS')
  return new Response(res.body, { status: res.status, headers: h })
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}
