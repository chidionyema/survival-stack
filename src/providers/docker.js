// The lab provider. Same four functions as Hetzner, DigitalOcean and Vultr, so
// the control plane cannot tell it apart from a real one — which is the whole
// point of the dry run. Talks to lab/shim.js, which runs docker on the host.
import { requestWithBackoff } from './index.js'

const base = (env) => env.DOCKER_SHIM_URL || 'http://127.0.0.1:2456/docker'

export const docker = {
  name: 'docker',
  regions: () => ['local'],
  defaults: () => ({ region: 'local', size: 'container' }),

  async provision({ name, region, size, userData, env }) {
    const res = await requestWithBackoff(`${base(env)}/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, region, size, user_data: userData }),
    })
    if (!res.ok) throw new Error(`docker shim ${res.status}: ${await res.text()}`)
    const json = await res.json()
    return { id: String(json.id), ip: json.ip ?? null }
  },

  async destroy(id, env) {
    const res = await requestWithBackoff(`${base(env)}/servers/${id}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`docker shim destroy ${res.status}`)
  },
}
