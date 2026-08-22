import { requestWithBackoff } from './index.js'

const API = 'https://api.hetzner.cloud/v1'

export const hetzner = {
  name: 'hetzner',
  regions: () => ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'],
  defaults: () => ({ region: 'fsn1', size: 'cx22' }),

  async provision({ name, region, size, userData, env }) {
    const res = await requestWithBackoff(`${API}/servers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.HETZNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name,
        server_type: size,
        image: 'ubuntu-24.04',
        location: region,
        user_data: userData,
        ssh_keys: env.SSH_KEY_NAME ? [env.SSH_KEY_NAME] : [],
        public_net: { enable_ipv4: true, enable_ipv6: true },
        labels: { managed_by: 'survival-stack' },
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`hetzner ${res.status}: ${JSON.stringify(json.error ?? json)}`)
    return { id: String(json.server.id), ip: json.server.public_net?.ipv4?.ip ?? null }
  },

  async destroy(id, env) {
    const res = await fetch(`${API}/servers/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${env.HETZNER_TOKEN}` },
    })
    if (!res.ok && res.status !== 404) throw new Error(`hetzner destroy ${res.status}`)
  },
}
