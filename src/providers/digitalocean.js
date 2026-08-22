import { requestWithBackoff } from './index.js'

const API = 'https://api.digitalocean.com/v2'

export const digitalocean = {
  name: 'digitalocean',
  regions: () => ['ams3', 'fra1', 'lon1', 'nyc3', 'sfo3'],
  defaults: () => ({ region: 'ams3', size: 's-1vcpu-1gb' }),

  async provision({ name, region, size, userData, env }) {
    const res = await requestWithBackoff(`${API}/droplets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.DIGITALOCEAN_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name,
        region,
        size,
        image: 'ubuntu-24-04-x64',
        user_data: userData,
        ssh_keys: env.SSH_KEY_NAME ? [env.SSH_KEY_NAME] : [],
        tags: ['survival-stack'],
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`digitalocean ${res.status}: ${JSON.stringify(json)}`)
    // A fresh droplet has no address yet. It reports its own IP on callback.
    const v4 = json.droplet.networks?.v4?.find((n) => n.type === 'public')
    return { id: String(json.droplet.id), ip: v4?.ip_address ?? null }
  },

  async destroy(id, env) {
    const res = await fetch(`${API}/droplets/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${env.DIGITALOCEAN_TOKEN}` },
    })
    if (!res.ok && res.status !== 404) throw new Error(`digitalocean destroy ${res.status}`)
  },
}
