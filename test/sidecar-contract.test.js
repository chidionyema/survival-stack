// Cross-file invariant. cloud-init and the sidecars agree on exactly two words.
// Rename either and a cold start restores nothing, with no error anywhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { renderCloudInit } from '../src/cloudinit.js'
import { baseEnv } from './helpers/fakes.js'

const doc = renderCloudInit(baseEnv(), {
  role: 'primary', nonce: 'n'.repeat(64),
  callbackUrl: 'https://c.test/im-alive', originHost: 'p1.example.test',
})

test('cloud-init asks for the two modes the sidecars implement', () => {
  assert.match(doc, /MODE: restore/)
  assert.match(doc, /MODE: backup/)
  assert.match(doc, /command: \["\/entrypoint\.sh", "restore"\]/)

  for (const db of readdirSync('sidecars')) {
    const sh = readFileSync(`sidecars/${db}/entrypoint.sh`, 'utf8')
    assert.match(sh, /^\s+restore\)/m, `${db} handles restore`)
    assert.match(sh, /^\s+backup\)/m, `${db} handles backup`)
    assert.match(sh, /unknown mode/, `${db} refuses anything else`)
    // Every variable the sidecar demands must be in the env file cloud-init writes.
    for (const req of sh.match(/\$\{([A-Z0-9_]+):\?/g) ?? []) {
      const name = req.slice(2, -2)
      assert.ok(doc.includes(`${name}=`), `${db} requires ${name}, cloud-init must write it`)
    }
  }
})

test('the restore path refuses to hand a corrupt database to the engine', () => {
  const sqlite = readFileSync('sidecars/sqlite/entrypoint.sh', 'utf8')
  assert.match(sqlite, /PRAGMA integrity_check/)
  assert.match(sqlite, /exit 1/)
})
