import { requestWithBackoff, b64 } from './index.js'

const API = 'https://api.vultr.com/v2'
const UBUNTU_2404 = 2284 // os_id

export const vultr = {
  name: 'vultr',
  regions: () => ['ams', 'lhr', 'fra', 'ewr', 'lax'],
  defaults: () => ({ region: 'lhr', size: 'vc2-1c-1gb' }),

  async provision({ name, region, size, userData, env }) {
    const res = await requestWithBackoff(`${API}/instances`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.VULTR_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        region,
        plan: size,
        os_id: UBUNTU_2404,
        label: name,
        hostname: name,
        user_data: b64(userData), // Vultr is the one that wants this base64-encoded
        tags: ['survival-stack'],
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`vultr ${res.status}: ${JSON.stringify(json)}`)
    const ip = json.instance.main_ip
    return { id: String(json.instance.id), ip: ip && ip !== '0.0.0.0' ? ip : null }
  },

  async destroy(id, env) {
    const res = await fetch(`${API}/instances/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${env.VULTR_TOKEN}` },
    })
    if (!res.ok && res.status !== 404) throw new Error(`vultr destroy ${res.status}`)
  },
}
