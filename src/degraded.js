// Mode 4. Both boxes are gone; the edge keeps selling.
// The catalog is a cached copy in R2. Orders become objects in R2 and are
// replayed by the engine when it comes back.

import { audit } from './audit.js'
import * as tg from './telegram.js'
import { getBoxes } from './state.js'
import { originHost } from './dns.js'

const ORIGIN_TIMEOUT_MS = 8000

async function tryOrigin(env, request, role) {
  const boxes = await getBoxes(env)
  if (!boxes[role]) return null
  const url = new URL(request.url)
  url.hostname = originHost(env, role)
  try {
    const res = await fetch(new Request(url, request), {
      signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
    })
    return res.status >= 500 ? null : res
  } catch {
    return null
  }
}

export async function serve(env, request, ctx) {
  const live = (await tryOrigin(env, request, 'primary')) ?? (await tryOrigin(env, request, 'standby'))
  if (live) return live

  ctx.waitUntil(announceDegraded(env))
  const url = new URL(request.url)

  if (request.method === 'POST' && url.pathname === '/order') {
    return queueOrder(env, request)
  }
  return catalogPage(env)
}

let announcedAt = 0
async function announceDegraded(env) {
  const now = Date.now()
  if (now - announcedAt < 15 * 60 * 1000) return // one alert per 15 min, not per request
  announcedAt = now
  const queued = await env.DATA.list({ prefix: 'orders/queued/' })
  await audit(env, 'degraded.active', { queued: queued.objects.length })
  await tg.send(env, `⚠️ Degraded mode active. Both boxes unreachable. ${queued.objects.length} orders queued.`)
}

async function queueOrder(env, request) {
  let order
  try {
    order = await request.json()
  } catch {
    return json({ ok: false, error: 'bad json' }, 400)
  }
  const id = crypto.randomUUID()
  const at = new Date(Date.now()).toISOString()
  await env.DATA.put(
    `orders/queued/${at.slice(0, 10)}/${at}-${id}.json`,
    JSON.stringify({ id, at, order, source: 'degraded' }),
    { httpMetadata: { contentType: 'application/json' } },
  )
  await audit(env, 'degraded.order_queued', { id })
  return json({ ok: true, id, message: 'Order received. Delivered within 1 hour.' })
}

async function catalogPage(env) {
  const cached = await env.DATA.get('catalog/packs.json')
  const packs = cached ? await cached.json() : []
  const rows = packs
    .map(
      (p) =>
        `<li><strong>${escapeHtml(p.name)}</strong> — ${escapeHtml(String(p.price))}
         <form method="POST" action="/order"><input type="hidden" name="sku" value="${escapeHtml(p.sku)}">
         <button>Order</button></form></li>`,
    )
    .join('\n')
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(env.DOMAIN)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.5 system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem}
li{margin:1rem 0;list-style:none}button{padding:.5rem 1rem}</style>
<h1>${escapeHtml(env.DOMAIN)}</h1>
<p>We are taking orders normally. Delivery within 1 hour of purchase.</p>
<ul>${rows || '<li>Catalog loading.</li>'}</ul>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })
}
