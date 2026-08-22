// Incident: the cloud-init .env carried no DB_TYPE and no DATABASE_URL, so the
// engine on a real box fell back to its own default. On sqlite the default
// happened to match. On postgres the box would have booted, passed its health
// check, and written every order into a local sqlite file that nothing backs up.
// The lab never caught it because the lab passed DB_TYPE on the command line.
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

const envLine = (doc, key) => doc.match(new RegExp(`^\\s+${key}=(.*)$`, 'm'))?.[1]

test('incident: the box is told which database it is running', () => {
  const out = renderCloudInit(baseEnv(), args)
  assert.equal(envLine(out, 'DB_TYPE'), 'sqlite')
  // The sidecar replicates ${DB_DATA_PATH}/app.db. The engine must open the
  // same file, or the backup is of a database nobody writes to.
  assert.equal(envLine(out, 'DATABASE_URL'), 'sqlite:///data/app.db')
})

test('incident: postgres without a password refuses to render', () => {
  const env = baseEnv({ DB_TYPE: 'postgres' })
  delete env.DB_PASSWORD
  delete env.DATABASE_URL
  assert.throws(() => renderCloudInit(env, args), /DB_PASSWORD/)
  assert.throws(() => renderCloudInit(baseEnv({ DB_TYPE: 'mysql' }), args), /unknown DB_TYPE/)
})

test('a postgres box runs a postgres server, restored before it starts', () => {
  const out = renderCloudInit(baseEnv({ DB_TYPE: 'postgres', DB_PASSWORD: 'pw' }), args)
  assert.match(out, /image: postgres:16-alpine/)
  assert.equal(envLine(out, 'DATABASE_URL'), 'postgresql://postgres:pw@db:5432/app')
  // init restores the cluster, db waits for it, the engine waits for db.
  const doc = out.slice(out.indexOf('services:'))
  const dbBlock = doc.slice(doc.indexOf('db:'), doc.indexOf('\n        init:'))
  assert.match(dbBlock, /init:\n\s+condition: service_completed_successfully/)
  const engineBlock = doc.slice(doc.indexOf('engine:'), doc.indexOf('caddy:'))
  assert.match(engineBlock, /db:\n\s+condition: service_healthy/)
})

test('a sqlite box has no database server to wait for', () => {
  const out = renderCloudInit(baseEnv(), args)
  assert.equal(/postgres:16-alpine/.test(out), false)
  const doc = out.slice(out.indexOf('services:'))
  const engineBlock = doc.slice(doc.indexOf('engine:'), doc.indexOf('caddy:'))
  assert.match(engineBlock, /init:\n\s+condition: service_completed_successfully/)
})
