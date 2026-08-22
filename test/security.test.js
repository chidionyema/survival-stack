// LAW 21 as executable checks: a secret must never reach a place it can be read
// again, and a webhook without its secret must not reach the command parser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { audit } from '../src/audit.js'
import { webhookAuthentic, parseCommand } from '../src/telegram.js'
import { requireTotp, nonceEqual } from '../src/auth.js'
import { totp } from '../src/totp.js'
import { baseEnv, rng } from './helpers/fakes.js'

test('property: no value under a secret-shaped key is ever written to the audit log', async () => {
  const next = rng(31)
  const names = ['token', 'api_token', 'TOTP_SECRET', 'nonce', 'r2Key', 'authorization', 'password']
  for (let i = 0; i < 100; i++) {
    const env = baseEnv()
    const value = `leak-${Math.floor(next() * 1e12)}`
    const key = names[Math.floor(next() * names.length)]
    await audit(env, 'test.event', { safe: 'visible', [key]: value, nested: { [key]: value } })
    const written = [...env.AUDIT.map.values()].join('\n')
    assert.equal(written.includes(value), false, `${key} leaked into the audit log`)
    assert.equal(written.includes('visible'), true, 'non-secret fields still recorded')
  }
})

test('a webhook without the registered secret is not authentic', () => {
  const env = baseEnv()
  const req = (v) => new Request('https://x/telegram', {
    headers: v === null ? {} : { 'x-telegram-bot-api-secret-token': v },
  })
  assert.equal(webhookAuthentic(req(env.TELEGRAM_WEBHOOK_SECRET), env), true)
  assert.equal(webhookAuthentic(req(null), env), false)
  assert.equal(webhookAuthentic(req(''), env), false)
  assert.equal(webhookAuthentic(req('hookhookhookhooX'), env), false)
  assert.equal(webhookAuthentic(req(env.TELEGRAM_WEBHOOK_SECRET), baseEnv({ TELEGRAM_WEBHOOK_SECRET: '' })), false)
})

test('a control plane with no TOTP secret refuses instead of falling open', async () => {
  const env = baseEnv({ TOTP_SECRET: '' })
  const res = await requireTotp(env, '123456', 'cold-start')
  assert.equal(res.ok, false)
  assert.match(res.reason, /not configured/)
})

test('a TOTP code cannot be used twice', async () => {
  const env = baseEnv()
  const code = await totp(env.TOTP_SECRET)
  assert.equal((await requireTotp(env, code, 'promote')).ok, true)
  const second = await requireTotp(env, code, 'promote')
  assert.equal(second.ok, false)
  assert.match(second.reason, /already used/)
})

test('nonce comparison rejects prefixes and length games', () => {
  assert.equal(nonceEqual('abc', 'abc'), true)
  assert.equal(nonceEqual('abc', 'abcd'), false)
  assert.equal(nonceEqual('abc', 'ab'), false)
  assert.equal(nonceEqual('abc', null), false)
  assert.equal(nonceEqual(undefined, undefined), false)
})

test('command parsing pulls the code off the end and never mistakes an argument for one', () => {
  assert.deepEqual(parseCommand('/cold-start vultr 123456'), { cmd: 'cold-start', args: ['vultr'], code: '123456' })
  assert.deepEqual(parseCommand('/promote 000111'), { cmd: 'promote', args: [], code: '000111' })
  assert.deepEqual(parseCommand('/status'), { cmd: 'status', args: [], code: null })
  assert.deepEqual(parseCommand('/deploy v1.2.3 999999'), { cmd: 'deploy', args: ['v1.2.3'], code: '999999' })
  assert.deepEqual(parseCommand('/cold-start@survivalbot do 424242'),
    { cmd: 'cold-start', args: ['do'], code: '424242' })
  assert.equal(parseCommand('hello'), null)
  assert.equal(parseCommand(''), null)
  assert.equal(parseCommand(undefined), null)
})
