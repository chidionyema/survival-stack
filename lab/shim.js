#!/usr/bin/env node
// One process standing in for three paid services, so the real control plane
// can run against something. No dependencies, no cloud account, no money.
//
//   /docker/*  a provider API whose backend is `docker run`
//   /cf/*      the Cloudflare DNS API; a change rewrites the edge Caddyfile
//   /tg/*      the Telegram bot API; every message is kept for the tests to read
//
// Nothing here is used in production. It exists so the dry run exercises the
// same Worker code path a real provider would.

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PORT = Number(process.env.SHIM_PORT || 2456)
const NETWORK = process.env.LAB_NETWORK || 'lab_default'
const ENGINE_IMAGE = process.env.LAB_ENGINE_IMAGE || 'survival-lab-engine'
const SIDECAR_IMAGE = process.env.LAB_SIDECAR_IMAGE || 'survival-lab-sqlite'
const STATE = new URL('./state/', import.meta.url).pathname
mkdirSync(STATE, { recursive: true })

const log = (...a) => console.log(new Date().toISOString(), ...a)
const readState = (f, fallback) => {
  try { return JSON.parse(readFileSync(STATE + f, 'utf8')) } catch { return fallback }
}
const writeState = (f, v) => writeFileSync(STATE + f, JSON.stringify(v, null, 2))

// ---------------------------------------------------------------- DNS records
// Seeded so the apex exists before the first cold start, exactly as a real zone
// would have it.
let records = readState('dns.json', {
  apex: { id: 'apex', type: 'A', name: 'lab.test', content: '0.0.0.0', proxied: true },
})
const saveDns = () => writeState('dns.json', records)

async function applyEdge() {
  const ip = records.apex.content
  writeFileSync(`${STATE}Caddyfile`, `:80 {\n\treverse_proxy ${ip}:3000\n}\n`)
  try {
    await run('docker', ['exec', 'lab-edge-1', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile'])
    log('edge reloaded ->', ip)
  } catch (err) {
    log('edge reload failed:', String(err).slice(0, 200))
  }
}

// ------------------------------------------------------------ docker provider
const servers = new Map()

// Two failure modes a real provider produces and a happy fake never does: a box
// that boots but never becomes healthy, and a box that never reports in at all.
// One boot each, set through /docker/_next, cleared as soon as it is used.
let nextBoot = {}

function parseUserData(userData) {
  const nonce = userData.match(/[0-9a-f]{64}/)?.[0] ?? null
  const callback = userData.match(/-X POST "([^"]+)"/)?.[1] ?? null
  const role = /ROLE=standby|"role":\\"standby/.test(userData) ? 'standby' : 'primary'
  // The engine service in the compose document decides what runs. A deploy
  // changes that line and nothing else, so the fake must read it rather than
  // fall back to its own default -- otherwise a broken deploy still looks green.
  const image = userData.match(/engine:\n\s+image: (\S+)/)?.[1] ?? ENGINE_IMAGE
  return { nonce, callback, role, image }
}

async function bootBox(id, name, userData) {
  const { nonce, callback, role, image } = parseUserData(userData)
  const vol = `${name}-data`
  try {
    await run('docker', ['volume', 'create', vol])

    // The restore sidecar runs first and must exit 0, same as init-restore in
    // the real compose file. A box that cannot restore never serves.
    await run('docker', ['run', '--rm', '--network', NETWORK, '-v', `${vol}:/data`,
      '-e', 'R2_BUCKET=prospector', '-e', 'R2_ENDPOINT=http://minio:9000',
      '-e', 'R2_ACCESS_KEY=admin', '-e', 'R2_SECRET_KEY=password123',
      SIDECAR_IMAGE, 'restore'])
    log(name, 'restore finished')

    // One box per role in the lab, because they share a host port. A real
    // provider has no such limit; this is a property of the fake, not the code.
    const hostPort = role === 'primary' ? 3001 : 3002
    const { stdout: olds } = await run('docker', ['ps', '-aq', '--filter', `label=survival.role=${role}`])
    for (const c of olds.split('\n').filter(Boolean)) {
      await run('docker', ['rm', '-f', c]).catch(() => {})
      log('removed the previous', role, 'box', c)
    }
    await run('docker', ['run', '-d', '--name', name, '--network', NETWORK,
      '--label', `survival.role=${role}`,
      '-p', `${hostPort}:3000`,
      '-v', `${vol}:/data`, '-e', `ROLE=${role}`, '-e', 'DATABASE_URL=sqlite:///data/app.db',
      image])

    // The backup sidecar rides with the engine, as it does in cloud-init, and
    // only on the primary — the real compose file puts it behind the "primary"
    // profile for the same reason.
    if (role === 'primary') await run('docker', ['run', '-d', '--name', `${name}-backup`, '--network', NETWORK,
      '-v', `${vol}:/data`,
      '-e', 'R2_BUCKET=prospector', '-e', 'R2_ENDPOINT=http://minio:9000',
      '-e', 'R2_ACCESS_KEY=admin', '-e', 'R2_SECRET_KEY=password123',
      SIDECAR_IMAGE, 'backup']).catch((e) => log(name, 'backup sidecar:', String(e).slice(0, 120)))

    const { stdout } = await run('docker', ['inspect', '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name])
    const ip = stdout.trim()
    servers.get(id).ip = ip

    let health = 'unhealthy'
    const plan = nextBoot; nextBoot = {}
    for (let i = 0; i < (plan.health === 'bad' ? 0 : 60); i++) {
      try {
        await run('docker', ['exec', name, 'curl', '-fsS', 'http://localhost:3000/health'])
        health = 'ok'
        break
      } catch { await new Promise((r) => setTimeout(r, 2000)) }
    }
    log(name, 'health', health, ip, 'image', image)

    if (plan.deaf) {
      log(name, 'deaf boot: not reporting in, the sweep should clean this up')
    } else if (callback && nonce) {
      const res = await fetch(callback, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, ip, health, role, shadow: false }),
      })
      log(name, 'reported in ->', res.status)
    } else {
      log(name, 'no nonce or callback found in user-data — cannot report in')
    }
  } catch (err) {
    log(name, 'boot failed:', String(err).slice(0, 300))
  }
}

async function destroyBox(id) {
  const s = servers.get(id)
  const name = s?.name ?? id
  await run('docker', ['rm', '-f', name]).catch(() => {})
  await run('docker', ['rm', '-f', `${name}-backup`]).catch(() => {})
  await run('docker', ['volume', 'rm', '-f', `${name}-data`]).catch(() => {})
  servers.delete(id)
  log('destroyed', name)
}

// ------------------------------------------------------------------ telegram
let sent = readState('telegram.json', [])

// -------------------------------------------------------------------- router
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://shim')
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  const body = raw ? JSON.parse(raw) : {}
  const p = url.pathname

  try {
    // ---- provider
    if (p === '/docker/servers' && req.method === 'POST') {
      const id = `srv-${servers.size + 1}-${Number(process.hrtime.bigint() % 100000n)}`
      const name = body.name || id
      servers.set(id, { id, name, ip: null })
      bootBox(id, name, body.user_data || '') // fire and forget, like a real API
      return json(res, 201, { id, ip: null })
    }
    if (p.startsWith('/docker/servers/') && req.method === 'DELETE') {
      await destroyBox(p.split('/').pop())
      return json(res, 204, {})
    }
    if (p === '/docker/_servers') return json(res, 200, [...servers.values()])
    if (p === '/docker/_next' && req.method === 'POST') { nextBoot = body; return json(res, 200, { next: nextBoot }) }

    // ---- cloudflare dns
    if (p.startsWith('/cf/zones/')) {
      const parts = p.split('/').filter(Boolean) // cf zones <zone> dns_records [id]
      const recId = parts[4]
      if (recId && req.method === 'GET') {
        return json(res, 200, { success: true, result: records[recId] ?? null })
      }
      if (recId && req.method === 'PATCH') {
        records[recId] = { ...records[recId], ...body, id: recId }
        saveDns()
        if (recId === 'apex') await applyEdge()
        return json(res, 200, { success: true, result: records[recId] })
      }
      if (!recId && req.method === 'GET') {
        const name = url.searchParams.get('name')
        return json(res, 200, {
          success: true,
          result: Object.values(records).filter((r) => !name || r.name === name),
        })
      }
      if (!recId && req.method === 'POST') {
        const id = body.name.replace(/[^a-z0-9]/gi, '-')
        records[id] = { ...body, id }
        saveDns()
        return json(res, 200, { success: true, result: records[id] })
      }
    }

    // ---- telegram
    if (p.includes('/tg/bot')) {
      const method = p.split('/').pop()
      sent.push({ at: new Date().toISOString(), method, ...body })
      writeState('telegram.json', sent)
      return json(res, 200, { ok: true, result: { message_id: sent.length } })
    }
    if (p === '/tg/_sent') return json(res, 200, sent)
    if (p === '/tg/_clear') { sent = []; writeState('telegram.json', sent); return json(res, 200, {}) }

    json(res, 404, { error: 'no route', path: p })
  } catch (err) {
    log('shim error', p, String(err))
    json(res, 500, { error: String(err) })
  }
}).listen(PORT, '127.0.0.1', () => log(`shim on http://127.0.0.1:${PORT}`))
