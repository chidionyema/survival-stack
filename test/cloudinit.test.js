// The cloud-init document is the one artefact no test can run and every cold
// start depends on. These are the invariants that make a silent bad boot
// impossible: no missing value, no unexpanded placeholder, one nonce.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderCloudInit } from '../src/cloudinit.js'
import { baseEnv } from './helpers/fakes.js'

const args = {
  role: 'primary',
  nonce: 'a'.repeat(64),
  callbackUrl: 'https://control.example.workers.dev/im-alive',
  originHost: 'p1.example.test',
}

test('a missing value refuses to render rather than booting a broken box', () => {
  for (const key of ['ENGINE_IMAGE', 'DOMAIN', 'R2_ACCESS_KEY', 'DB_DATA_PATH', 'STRIPE_SECRET_KEY']) {
    const env = baseEnv({ [key]: '' })
    assert.throws(() => renderCloudInit(env, args), new RegExp(key), `${key} must be required`)
  }
  assert.throws(() => renderCloudInit(baseEnv(), { ...args, nonce: '' }), /NONCE/)
})

test('the rendered document has no unresolved placeholders', () => {
  const out = renderCloudInit(baseEnv(), args)
  assert.equal(out.startsWith('#cloud-config\n'), true)
  assert.equal(/\{\{[A-Z_]+\}\}/.test(out), false, 'no {{VAR}} left')
  assert.equal(/\$\{v\./.test(out), false, 'no template literal left')
  assert.equal(/undefined|\[object Object\]/.test(out), false)
})

test('the nonce and callback appear exactly where the box reports in', () => {
  const out = renderCloudInit(baseEnv(), args)
  assert.equal(out.split(args.nonce).length - 1, 2, 'nonce appears in both report-in calls')
  assert.equal(out.split(args.callbackUrl).length - 1, 2)
  assert.match(out, /report-in\.sh/)
  assert.match(out, /docker compose --profile primary up -d/)
})

test('a standby renders without the backup sidecar profile', () => {
  const primary = renderCloudInit(baseEnv(), args)
  const standby = renderCloudInit(baseEnv(), { ...args, role: 'standby', originHost: 'p2.example.test' })
  assert.match(primary, /--profile primary/)
  assert.match(standby, /--profile standby/)
  // The profile is what gates replication, so only the primary writes to R2.
  assert.match(primary, /profiles: \["primary"\]/)
  assert.match(standby, /profiles: \["primary"\]/) // declared, but not activated by --profile standby
})

test('secrets land only in the 0600 env file', () => {
  const out = renderCloudInit(baseEnv(), args)
  const envBlock = out.slice(out.indexOf('/opt/survival/.env'), out.indexOf('/opt/survival/compose.yml'))
  for (const secret of ['sk_live_test', 'jwt-secret', 'r2-secret']) {
    assert.equal(out.split(secret).length - 1, 1, `${secret} appears once`)
    assert.ok(envBlock.includes(secret), `${secret} is inside the 0600 file`)
  }
  assert.match(envBlock, /permissions: '0600'/)
})

test('the origin host is served by Caddy so the health check has a valid certificate', () => {
  const out = renderCloudInit(baseEnv(), args)
  assert.match(out, /example\.test, p1\.example\.test \{/)
})
