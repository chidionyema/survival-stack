// All control-plane state lives in KV. Nothing lives on a machine that can die.

const JOB_TTL = 3600 // seconds; the sweep declares failure long before this

export async function getBoxes(env) {
  const raw = await env.STATE.get('boxes')
  return raw ? JSON.parse(raw) : { primary: null, standby: null, lastFailover: null }
}

export async function setBox(env, role, box) {
  const boxes = await getBoxes(env)
  boxes[role] = box
  await env.STATE.put('boxes', JSON.stringify(boxes))
  return boxes
}

export async function recordFailover(env, at, from, to) {
  const boxes = await getBoxes(env)
  boxes.lastFailover = { at, from, to }
  await env.STATE.put('boxes', JSON.stringify(boxes))
}

export async function putJob(env, job) {
  await env.STATE.put(`job:${job.nonce}`, JSON.stringify(job), { expirationTtl: JOB_TTL })
  return job
}

export async function getJob(env, nonce) {
  const raw = await env.STATE.get(`job:${nonce}`)
  return raw ? JSON.parse(raw) : null
}

export async function dropJob(env, nonce) {
  await env.STATE.delete(`job:${nonce}`)
}

export async function openJobs(env) {
  const listed = await env.STATE.list({ prefix: 'job:' })
  const out = []
  for (const k of listed.keys) {
    const job = await getJob(env, k.name.slice(4))
    if (job && job.state === 'provisioning') out.push(job)
  }
  return out
}

// A TOTP code is single-use. Burning the matched counter means a code read over
// someone's shoulder is already spent.
export async function burnCounter(env, counter) {
  const key = `totp:${counter}`
  if (await env.STATE.get(key)) return false
  await env.STATE.put(key, '1', { expirationTtl: 180 })
  return true
}

export async function lastShadow(env) {
  const raw = await env.STATE.get('shadow:last')
  return raw ? JSON.parse(raw) : null
}

export async function setLastShadow(env, result) {
  await env.STATE.put('shadow:last', JSON.stringify(result))
}
