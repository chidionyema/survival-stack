// Incident, found on 2026-08-22 while writing the lab test for /deploy: the
// command computed `image = engine:<version>`, wrote it to the audit log, told
// the founder "New box building <version>", and then called startColdStart
// without it. The new box rendered cloud-init from env.ENGINE_IMAGE and ran the
// OLD code. Every deploy reported success and shipped nothing.
//
// The rule under test is not "the argument is forwarded". It is: whatever the
// deploy names is what the machine is told to run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderCloudInit } from '../src/cloudinit.js'
import { startColdStart } from '../src/coldstart.js'
import { baseEnv } from './helpers/fakes.js'

const engineImage = (doc) => doc.match(/engine:\n\s+image: (\S+)/)?.[1]

test('cloud-init runs the image the deploy named, not the configured one', () => {
  const env = baseEnv()
  const doc = renderCloudInit(env, {
    role: 'primary', nonce: 'n'.repeat(64), callbackUrl: 'https://c.test/im-alive',
    originHost: 'p1.example.test', image: 'ghcr.io/acme/engine:v2.1.0',
  })
  assert.equal(engineImage(doc), 'ghcr.io/acme/engine:v2.1.0')
  assert.ok(!doc.includes('engine:latest'), 'the configured image must not survive a deploy')
})

test('without a deploy the configured image is what runs', () => {
  const env = baseEnv()
  const doc = renderCloudInit(env, {
    role: 'primary', nonce: 'n'.repeat(64), callbackUrl: 'https://c.test/im-alive',
    originHost: 'p1.example.test',
  })
  assert.equal(engineImage(doc), env.ENGINE_IMAGE)
})

test('the provisioned VM receives the named image, and the job records it', async () => {
  const env = baseEnv()
  let seen = null
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.hetzner.cloud')) {
      seen = JSON.parse(init.body).user_data
      return new Response(JSON.stringify({ server: { id: 7, public_net: { ipv4: { ip: '10.0.0.7' } } } }),
        { headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  }
  const job = await startColdStart(env, { provider: 'hetzner', role: 'primary', image: 'ghcr.io/acme/engine:v9' })
  assert.equal(engineImage(seen), 'ghcr.io/acme/engine:v9', 'the VM was handed the wrong image')
  assert.equal(job.image, 'ghcr.io/acme/engine:v9', 'the job must record what it shipped, for the audit')
})
