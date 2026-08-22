const CF = 'https://api.cloudflare.com/client/v4'

async function cf(env, path, init = {}) {
  const res = await fetch(`${CF}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const json = await res.json().catch(() => ({ success: false }))
  if (!json.success) {
    throw new Error(`cloudflare ${path}: ${JSON.stringify(json.errors ?? json)}`)
  }
  return json.result
}

export async function currentTarget(env) {
  const rec = await cf(env, `/zones/${env.CF_ZONE_ID}/dns_records/${env.CF_DNS_RECORD_ID}`)
  return { ip: rec.content, proxied: rec.proxied, name: rec.name }
}

export async function pointAt(env, ip) {
  const rec = await cf(env, `/zones/${env.CF_ZONE_ID}/dns_records/${env.CF_DNS_RECORD_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ type: 'A', content: ip, proxied: true, ttl: 1 }),
  })
  return rec.content
}

// Grey-cloud origin records. The apex A record is what customers resolve; these
// two give the Worker a name it can reach each box by, with a valid certificate,
// which is what makes degraded mode and health checks possible on a free plan.
export function originHost(env, role) {
  return `${role === 'primary' ? 'p1' : 'p2'}.${env.DOMAIN}`
}

export async function upsertRecord(env, name, ip, proxied = false) {
  const found = await cf(
    env,
    `/zones/${env.CF_ZONE_ID}/dns_records?type=A&name=${encodeURIComponent(name)}`,
  )
  if (found.length > 0) {
    const rec = await cf(env, `/zones/${env.CF_ZONE_ID}/dns_records/${found[0].id}`, {
      method: 'PATCH',
      body: JSON.stringify({ type: 'A', name, content: ip, proxied, ttl: proxied ? 1 : 60 }),
    })
    return rec.content
  }
  const rec = await cf(env, `/zones/${env.CF_ZONE_ID}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type: 'A', name, content: ip, proxied, ttl: proxied ? 1 : 60 }),
  })
  return rec.content
}
