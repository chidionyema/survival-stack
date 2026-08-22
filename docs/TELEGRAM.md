# Telegram notifications

Migration progress to your phone. Optional — the tool works with nothing set.

Sending is `src/telegram.js`, the same module the control-plane Worker uses.
There is one Telegram sender in this repo and there will not be a second.

---

## Setup

### 1. A bot

Message [@BotFather](https://t.me/BotFather), send `/newbot`, answer two
questions. It replies with a token shaped `123456789:AA…`.

That token is a credential. It goes in your shell profile or a password
manager, never in a commit, a screenshot or a message. If it has ever been
pasted somewhere readable, `/revoke` in BotFather and take the new one.

### 2. Your chat id

Message your new bot once — a bot cannot open a conversation with you — then:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" \
  | grep -o '"chat":{"id":[-0-9]*'
```

A negative number is a group. For a group, add the bot to it and send one
message there instead.

### 3. Two variables

```bash
export TELEGRAM_BOT_TOKEN=…
export TELEGRAM_CHAT_ID=…
```

### 4. Prove it

```bash
node scripts/lib/notify.mjs --test
```

```
telegram: sent
ops webhook: not configured
```

It exits non-zero if a configured channel failed, so it is usable in a
pre-flight script. A message arriving on the phone is the proof; the word
`sent` is only the second angle.

---

## What arrives

One message per phase boundary. Nothing to enable, no flag to pass — the
variables being set is the switch. `--no-notify` on a run suppresses it.

| Event | Icon | When |
|---|---|---|
| `migration.phase_start` | ▶️ | A phase begins |
| `migration.phase_complete` | ✅ | A phase passed |
| `migration.phase_failed` | ❌ | A phase stopped the run |
| `migration.cutover_ready` | 🔓 | Records staged, verify identical — **your registrar step** |
| `migration.cutover_done` | 🚀 | The new nameservers are answering |
| `migration.lockdown_done` | 🔒 | Every resolver agrees and the lock is back on |
| `migration.rollback` | ↩️ | A rollback ran |

`migration.cutover_ready` is the one worth a notification sound. Everything
else is a log line you can read afterwards; that one is a person being waited
on.

Format is HTML, and every field is escaped — a domain or an error message
carrying `<` cannot break the message or inject markup:

```
🔓 mumchimp.com — verify
Status: identical
Records: 8
Took: 45s
```

---

## What is never sent, and never printed

- **The bot token.** It lives in the URL Telegram is called on. Every string
  this module prints goes through `redact()` first, which strips each
  configured secret and any `/bot<id>:<token>` shaped text that came from
  somewhere else. There is a property test that feeds it error messages
  containing each secret and asserts none of them reach the output.
- **The Cloudflare token.** It is never in a payload, and it is redacted too in
  case an error message picks it up.
- **Record values.** The count goes out, the contents do not. A zone's `TXT`
  records include DKIM keys, and a chat history is not where those belong.

---

## When it fails

It does not take the migration with it. A revoked token, a chat the bot was
removed from, a network with no route and a hung `api.telegram.org` all end the
same way: one redacted line on stderr, and the migration carries on.

```
  telegram notify failed: 401
```

The send has a 5-second timeout. This is not decoration — before it was
added, the module's own tests reached the real `api.telegram.org`, which meant
production had no timeout on the Telegram path either. There is an incident
test named for it.

| What you see | Why |
|---|---|
| `not configured` | One of the two variables is missing. Both are needed |
| `401` | The token is wrong or revoked |
| `403` | You have not messaged the bot, or it was removed from the group |
| `400 chat not found` | Wrong chat id, or a group id without its `-` |
| `no answer in 5000ms` | Telegram or the network is not reachable |

---

## Reading it in code

```js
import { notify } from './scripts/lib/notify.mjs'

const out = await notify({
  event: 'migration.cutover_ready',
  domain: 'example.com', phase: 'verify', status: 'identical', records: 8,
})
// { telegram: 'sent' | 'failed' | 'not configured', webhook: … }
```

`notify()` never throws. Both channels go out at once and neither can block the
other. Everything is injectable — `env`, `fetchImpl`, `timeoutMs`, `log` — which
is why the tests do not touch the network.
