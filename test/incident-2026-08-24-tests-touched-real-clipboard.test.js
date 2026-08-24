// Incident 2026-08-24: npm test wrote "a password, copied by mistake" and fake
// tokens to the founder's real macOS pasteboard while he was working. Rule:
// no test may name the system clipboard binaries; every clipboard access goes
// through cf-auth's reader/writer, which honour CF_CLIPBOARD_FILE.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as auth from '../scripts/lib/cf-auth.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const banned = /pbcopy|pbpaste|xclip|xsel|wl-copy|wl-paste|clip\.exe/

test('no test file names a system clipboard binary', () => {
  const offenders = readdirSync(here)
    .filter((f) => f.endsWith('.test.js') && !f.startsWith('incident-2026-08-24-tests-touched'))
    .filter((f) => banned.test(readFileSync(join(here, f), 'utf8')))
  assert.deepEqual(offenders, [])
})

test('CF_CLIPBOARD_FILE redirects both reader and writer to the file', async () => {
  const saved = process.env.CF_CLIPBOARD_FILE
  process.env.CF_CLIPBOARD_FILE = '/nonexistent/clip'
  try {
    const r = await auth.clipboardReader()
    const w = await auth.clipboardWriter()
    assert.equal(r.cmd, '/bin/cat')
    assert.deepEqual(r.args, ['/nonexistent/clip'])
    assert.equal(w.cmd, '/bin/sh')
    assert.ok(w.args.includes('/nonexistent/clip'))
  } finally {
    process.env.CF_CLIPBOARD_FILE = saved
  }
})

test('without CF_CLIPBOARD_FILE the platform clipboard is used (the seam is opt-in)', async () => {
  const saved = process.env.CF_CLIPBOARD_FILE
  delete process.env.CF_CLIPBOARD_FILE
  try {
    const r = await auth.clipboardReader()
    assert.notEqual(r.cmd, '/bin/cat')
  } finally {
    process.env.CF_CLIPBOARD_FILE = saved
  }
})
