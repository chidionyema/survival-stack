# Dry run evidence

Run on 2026-08-22 on the founder's laptop. Total spend: nothing.
The Worker under test is the production one, running in `workerd` under
`wrangler dev`. Only the world around it is faked.

```
TEST A — failover: the standby takes over
  cold-starting primary from Telegram
  PASS  primary registered by the control plane
  cold-starting standby from the phone console
  PASS  standby registered
  PASS  the apex serves the primary
  killing the primary box
  PASS  the edge fell through to the standby with no human involved
  promoting the standby
  PASS  the apex record now points at the standby

TEST B — cold start from a park bench, with the data
  making sure there is a primary to lose
  writing an order to it so there is something to lose
  waiting for litestream to push the write to object storage
  destroying every box
  /cold-start docker, from Telegram, with a TOTP code
  PASS  a new box came up and reported in
  PASS  the restored database carried 1 order(s) across

TEST C — every box gone, the shop stays open
  PASS  the catalog still renders from R2
  PASS  an order was still taken: {"ok":true,"id":"d1cef967-322c-4fbd-904e-f0a4bf7e0912","message":"Order received
  PASS  the queued order is in the audit log

TEST D — swap the database, the stack does not notice
  PASS  postgres is up
  PASS  the postgres sidecar image builds
  PASS  restore on an empty bucket is a first boot, not a crash
  PASS  the sidecar refuses a mode it does not know
  PASS  the same engine image serves on postgres

15 passed, 0 failed
```

## What the first run found

The first run scored 8 passed, 7 failed. Three of those were real defects,
not test noise:

1. **Degraded mode lost the order it existed to save.** A POST to a dead
   origin consumed the request body, so by the time the code fell through to
   queueing it, there was nothing left to read: `{"ok":false,"error":"bad json"}`.
   Fixed in `src/degraded.js`; `test/incident-degraded-order.test.js` holds the case.
2. **The degraded catalog's own order form was refused.** The page posts an HTML
   form; the queue parsed JSON only. Same file, same test.
3. **The sidecars complained about credentials when given a bad mode.** The verb
   is now checked first, so the message names what the caller got wrong.

Two were faults in the test rig, worth recording because both looked like
product bugs at first: port 8787 is already the founder board on this machine,
and the tests were replaying one TOTP code across two actions, which the
control plane refused — correctly.
