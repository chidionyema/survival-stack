// Append-only audit trail in R2. One object per event, keyed by time, so a
// prefix list is a chronological read and nothing can be overwritten.

export async function audit(env, event, detail = {}) {
  const at = new Date(Date.now()).toISOString()
  const key = `audit/${at.slice(0, 10)}/${at}-${crypto.randomUUID()}.json`
  const body = JSON.stringify({ at, event, ...redact(detail) })
  try {
    await env.AUDIT.put(key, body, { httpMetadata: { contentType: 'application/json' } })
  } catch (err) {
    // The audit log must never take the control plane down with it.
    console.error('audit write failed', event, String(err))
  }
  return key
}

// A secret must never reach a place it can be read again — a log line included.
const SECRET_KEYS = /token|secret|key|password|nonce|authorization/i
function redact(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(k)) out[k] = '[redacted]'
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = redact(v)
    else out[k] = v
  }
  return out
}

export async function recentAudit(env, limit = 50) {
  const listed = await env.AUDIT.list({ prefix: 'audit/', limit })
  const objs = listed.objects.sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, limit)
  const out = []
  for (const o of objs) {
    const got = await env.AUDIT.get(o.key)
    if (got) out.push(JSON.parse(await got.text()))
  }
  return out
}
