// Fakes for the three things the control plane talks to: KV, R2 and the network.
// No mocks of our own modules — those would test the mock.

export class FakeKV {
  constructor() { this.map = new Map() }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null }
  async put(k, v) { this.map.set(k, v) }
  async delete(k) { this.map.delete(k) }
  async list({ prefix = '' } = {}) {
    return { keys: [...this.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }
  }
}

export class FakeR2 {
  constructor() { this.map = new Map() }
  async put(k, v) { this.map.set(k, v) }
  async get(k) {
    if (!this.map.has(k)) return null
    const v = this.map.get(k)
    return { text: async () => v, json: async () => JSON.parse(v) }
  }
  async head(k) { return this.map.has(k) ? { key: k } : null }
  async list({ prefix = '', limit = 1000 } = {}) {
    return { objects: [...this.map.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((key) => ({ key })) }
  }
}

// A deterministic PRNG, so a failing property run is reproducible from its seed.
export function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 0x100000000
  }
}

export function baseEnv(overrides = {}) {
  return {
    STATE: new FakeKV(),
    AUDIT: new FakeR2(),
    DATA: new FakeR2(),
    DOMAIN: 'example.test',
    CONTROL_URL: 'https://control.example.workers.dev',
    ENGINE_IMAGE: 'ghcr.io/acme/engine:latest',
    ENGINE_PORT: '8080',
    DB_BACKUP_IMAGE: 'ghcr.io/acme/sidecar-sqlite:latest',
    DB_DATA_PATH: '/data',
    R2_BUCKET: 'survival-data',
    R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    R2_ACCESS_KEY: 'r2-access',
    R2_SECRET_KEY: 'r2-secret',
    STRIPE_SECRET_KEY: 'sk_live_test',
    JWT_SECRET: 'jwt-secret',
    TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
    TELEGRAM_BOT_TOKEN: '1:tok',
    TELEGRAM_CHAT_ID: '42',
    TELEGRAM_WEBHOOK_SECRET: 'hookhookhookhook',
    CF_API_TOKEN: 'cf-token',
    CF_ZONE_ID: 'zone1',
    CF_DNS_RECORD_ID: 'rec1',
    HETZNER_TOKEN: 'hz', DIGITALOCEAN_TOKEN: 'do', VULTR_TOKEN: 'vu',
    SSH_KEY_NAME: 'survival',
    SHADOW_PROVIDERS: 'hetzner,digitalocean,vultr',
    ...overrides,
  }
}

// Routes every outbound call by hostname and records it, so a test can assert
// what the control plane did to the world.
export function installFetch({ providerId = '900', dnsFails = false } = {}) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const method = init.method ?? (typeof input === 'object' ? input.method : 'GET') ?? 'GET'
    calls.push({ url, method, body: init.body ? String(init.body) : null })

    if (url.includes('api.telegram.org')) {
      return jsonRes({ ok: true, result: { message_id: 7 } })
    }
    if (url.includes('api.cloudflare.com')) {
      if (dnsFails) return jsonRes({ success: false, errors: [{ message: 'nope' }] }, 403)
      const body = init.body ? JSON.parse(init.body) : {}
      if (method === 'GET' && url.includes('dns_records?')) return jsonRes({ success: true, result: [] })
      return jsonRes({ success: true, result: { id: 'rec1', content: body.content ?? '1.2.3.4', proxied: true, name: 'example.test' } })
    }
    if (url.includes('api.hetzner.cloud')) {
      return jsonRes({ server: { id: providerId, public_net: { ipv4: { ip: null } } } })
    }
    if (url.includes('api.digitalocean.com')) {
      return jsonRes({ droplet: { id: providerId, networks: { v4: [] } } })
    }
    if (url.includes('api.vultr.com')) {
      return jsonRes({ instance: { id: providerId, main_ip: '0.0.0.0' } })
    }
    return jsonRes({ ok: true })
  }
  return {
    calls,
    restore() { globalThis.fetch = real },
    to(fragment) { return calls.filter((c) => c.url.includes(fragment)) },
  }
}

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}
