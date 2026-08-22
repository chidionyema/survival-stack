// Mode 4. Both boxes are gone; the edge keeps selling.
// The catalog is a cached copy in R2. Orders become objects in R2 and are
// replayed by the engine when it comes back.

import { audit } from './audit.js'
import * as tg from './telegram.js'
import { getBoxes } from './state.js'
import { originBase } from './dns.js'

const ORIGIN_TIMEOUT_MS = 8000

async function tryOrigin(env, request, role, body) {
  const boxes = await getBoxes(env)
  if (!boxes[role]) return null
  const here = new URL(request.url)
  const url = new URL(here.pathname + here.search, originBase(env, role))
  try {
    // The body is passed in already read. A Request body is a stream and can
    // only be consumed once; forwarding the original would leave nothing to
    // queue when the origin turns out to be dead, which loses the order.
    const res = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: body ?? undefined,
      signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
    })
    return res.status >= 500 ? null : res
  } catch {
    return null
  }
}

export async function serve(env, request, ctx) {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const body = hasBody ? await request.arrayBuffer() : null

  const live =
    (await tryOrigin(env, request, 'primary', body)) ??
    (await tryOrigin(env, request, 'standby', body))
  if (live) return live

  ctx.waitUntil(announceDegraded(env))
  const url = new URL(request.url)

  if (request.method === 'POST' && url.pathname === '/order') {
    return queueOrder(env, request, body)
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

// The catalog page posts a plain HTML form, and an app posts JSON. Both are
// orders and both must be kept; refusing either loses a sale in the one mode
// where there is nothing else to fall back on.
function parseOrder(body, contentType) {
  const text = new TextDecoder().decode(body ?? new ArrayBuffer(0))
  if (!text) return null
  if ((contentType || '').includes('application/json')) {
    try { return JSON.parse(text) } catch { return null }
  }
  try { return Object.fromEntries(new URLSearchParams(text)) } catch { return null }
}

async function queueOrder(env, request, body) {
  const order = parseOrder(body, request.headers.get('content-type'))
  if (!order || Object.keys(order).length === 0) {
    return json({ ok: false, error: 'empty order' }, 400)
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
