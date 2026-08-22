# Ops webhook

Migration events as signed JSON, to anything that takes an HTTP POST.

Set two variables and it starts. There is no flag.

```bash
export OPS_WEBHOOK_URL=https://ops.example.com/hooks/migration
export OPS_WEBHOOK_SECRET=…      # signs the request. Never transmitted
node scripts/lib/notify.mjs --test
```

The secret is optional. Without it the request still goes, unsigned — an
endpoint on a private network is a legitimate reason not to have one. With it,
every request carries a signature you can check.

---

## The request

```
POST /hooks/migration
content-type: application/json
x-migration-timestamp: 1755859200
x-migration-signature: sha256=8f2a…
```

```json
{
  "event": "migration.cutover_ready",
  "domain": "mumchimp.com",
  "phase": "verify",
  "status": "identical",
  "records": 8,
  "seconds": 45,
  "timestamp": "2026-08-22T14:00:00.000Z",
  "source": "survival-stack/migrate-domain"
}
```

| Field | Always | What it is |
|---|---|---|
| `event` | yes | One of the events below |
| `domain` | yes | The domain being migrated |
| `timestamp` | yes | ISO 8601, when the notification was built |
| `source` | yes | `survival-stack/migrate-domain` |
| `phase` | no | `discover` · `validate` · `prepare` · `verify` · `cutover` · `lockdown` |
| `status` | no | Short outcome word |
| `records` | no | Record count |
| `seconds` | no | How long the phase took |
| `error` | no | Why it stopped. Redacted before it is sent |

## Events

| Event | Meaning | Page someone? |
|---|---|---|
| `migration.phase_start` | A phase began | No |
| `migration.phase_complete` | A phase passed | No |
| `migration.phase_failed` | The run stopped | Yes — it is stuck |
| `migration.cutover_ready` | Staged and verified, waiting on a human at the registrar | **Yes** |
| `migration.cutover_done` | The new nameservers are answering | No |
| `migration.lockdown_done` | All three resolvers agree, registrar re-locked | No |
| `migration.rollback` | A rollback ran | Yes |

Two are worth waking someone: `migration.phase_failed`, because nothing else
will happen until a person looks, and `migration.cutover_ready`, because a
person *is* the next step.

---

## Verifying the signature

The signature is HMAC-SHA256 over `<timestamp>.<raw body>`, hex, prefixed
`sha256=`. Three things have to hold, and skipping any of them makes the
signature decorative:

1. **Sign the raw bytes you received**, not a re-serialised object. `JSON.parse`
   then `JSON.stringify` reorders keys and changes whitespace, and the
   signature is over the exact bytes.
2. **Compare in constant time.** A `===` on a hex string leaks how much of it
   was right, one byte at a time.
3. **Check the timestamp.** Without it a captured request replays forever. Five
   minutes is the tolerance this repo uses.

The verifier is exported so nothing in this estate has to write its own and get
one of the three wrong:

```js
import { verify } from './scripts/lib/notify.mjs'

app.post('/hooks/migration', express.raw({ type: 'application/json' }), (req, res) => {
  const ok = verify(
    req.body.toString('utf8'),                                  // raw bytes
    process.env.OPS_WEBHOOK_SECRET,
    req.get('x-migration-timestamp'),
    req.get('x-migration-signature').replace('sha256=', ''),
  )
  if (!ok) return res.sendStatus(401)
  handle(JSON.parse(req.body))
  res.sendStatus(200)
})
```

In any other language, same three rules:

```python
import hmac, hashlib, time
def verify(raw: bytes, secret: str, ts: str, sig: str) -> bool:
    if abs(time.time() - int(ts)) > 300: return False
    want = hmac.new(secret.encode(), f"{ts}.".encode() + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, sig)
```

### What this deliberately does not do

It does not send `X-Migration-Secret: <the secret>` for the endpoint to compare.
That pattern reads like verification and is not: it hands the shared secret to
whoever receives one request — a misconfigured URL, a proxy that logs headers,
a stale endpoint that changed hands. A signature proves the sender knew the key
without ever showing it. There is an incident test named for that header.

---

## Receiving it

**PagerDuty** — Events API v2, only for the two that matter:

```js
const PAGE = new Set(['migration.phase_failed', 'migration.cutover_ready'])
if (!PAGE.has(body.event)) return res.sendStatus(200)

await fetch('https://events.pagerduty.com/v2/enqueue', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    routing_key: process.env.PD_ROUTING_KEY,
    event_action: 'trigger',
    dedup_key: `migration-${body.domain}`,
    payload: {
      summary: `${body.domain}: ${body.event}`,
      severity: body.event === 'migration.phase_failed' ? 'error' : 'warning',
      source: body.domain, component: 'dns-migration',
      custom_details: body,
    },
  }),
})
```

`dedup_key` keyed on the domain means a migration that fails three times is one
incident, not three.

**Grafana / Loki** — push the event as a line and the fields as labels. Keep
`domain` and `event` as labels and everything else in the line: a label per
record count is a new stream per value.

**A file** — an ops portal is a nice-to-have and a log is not:

```bash
node scripts/lib/notify.mjs --test   # after pointing OPS_WEBHOOK_URL at anything
```

---

## When it fails

Nothing here can fail the migration. A connection refused, a 500, a 401, a
response that is not a response, and a host that never answers all end the same
way: one line on stderr and the run carries on. There is an incident test that
drives all five.

```
  ops webhook answered 500
  ops webhook notify failed: no answer in 5000ms
```

The remote host's response body is never printed. It is written by whoever is
on the other end of the wire, and an endpoint echoing a request header back
into its own error body is exactly how a secret ends up in a log.
