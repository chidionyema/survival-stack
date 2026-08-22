# Dry run evidence

Run on 2026-08-22 on the founder's laptop. Total spend: nothing.
The Worker under test is the production one, running in `workerd` under
`wrangler dev`. Only the world around it is faked.

Reproduce with `scripts/dry-run.sh`, then `scripts/dry-run.sh down`. The run
below is one uninterrupted pass, exit code 0. Eight scenarios, 41 assertions.
The unit suite is separate and stands at 39 of 39 (`npm test`).

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
  PASS  the order was written before the disaster (4 -> 5)
  waiting for litestream to push the write to object storage
  destroying every box
  /cold-start docker, from Telegram, with a TOTP code
  PASS  a new box came up and reported in
  PASS  the restored database carried 5 order(s) across, none lost (had 5)

TEST C — every box gone, the shop stays open
  PASS  the catalog still renders from R2
  PASS  an order was still taken: {"ok":true,"id":"849d02d8-cd53-492c-b051-bf419c236205","message":"Order received
  PASS  the queued order is in the audit log

TEST D — swap the database, the stack does not notice
  PASS  postgres is up
  PASS  the postgres sidecar image builds
  PASS  restore on an empty bucket is a first boot, not a crash
  PASS  the sidecar refuses a mode it does not know
  PASS  the same engine image serves on postgres

TEST E — deploy: a new version, and a bad one that never reaches the customer
  making sure something is serving before the deploy
  /deploy v2 from Telegram
  PASS  the box now runs the image the deploy named: survival-lab-engine:v2
  PASS  the deploy is in the audit log
  PASS  the audit log names the exact image that shipped
  deploying a version that boots but never becomes healthy
  PASS  the control plane called the bad version unhealthy
  PASS  the registered primary did not move to the unhealthy box
  PASS  the unhealthy boot is in the audit log

TEST F — the Sunday shadow test proves a provider and destroys the evidence
  firing the Sunday cron trigger, not a hand-rolled call
  PASS  the shadow test came up healthy and said so
  PASS  the last shadow result is recorded for the console
  PASS  the control plane says it destroyed the test box
  PASS  the provider is left with no extra box (7 before, 7 after)
  PASS  no shadow container left running

TEST G — a box that never reports in is swept, not left billing
  cold-starting a box that will never call home
  PASS  the job is open and waiting for a callback
  running the sweep while the job is still young — it must leave it alone
  PASS  the sweep did not kill a box that is still booting
  waiting for the job to pass the stale window (STALE_MS=30000ms in the lab, 15m in production)
  PASS  the stale job is gone
  PASS  the timeout is in the audit log
  PASS  the founder was told, without asking
  PASS  the sweep says it destroyed the box at the provider
  PASS  the provider holds no more boxes than before the dead one (7)

TEST H — the refusals: no fingerprint, no action
  a wrong code
  PASS  a wrong code is refused, and the founder is told
  a replayed code
  PASS  the same code cannot be spent twice: {"ok":false,"error":"That code was already used. Wait for th
  no code at all
  PASS  an action with no code is refused
  a forged Telegram webhook
  PASS  a forged webhook gets 401
  PASS  the forgery is in the audit log
  a callback with a nonce nobody issued
  PASS  an unknown nonce cannot register a box
  the destroy path, with a real code
  PASS  a destroy with a valid code is carried out

41 passed, 0 failed
```

## What this does not prove

Real VM boot time, provider API quirks, real DNS propagation, Let's Encrypt
issuance and live Stripe. Those need money and a real Monday. `TASK.md` is that
week, with the command that proves each purchase.

Two more gaps worth naming, because a green run hides them.

**Postgres is proved in pieces, not end to end.** Test D builds the sidecar,
proves both its modes, and proves the same engine image serves on postgres. It
does not boot a postgres box from the generated cloud-init. That document now
renders a `postgres:16-alpine` service with the restore ordered ahead of it
(`test/incident-db-selection.test.js`), which is a unit-level proof, not a
running one.

**The degraded-mode queue is written and never drained.** Test C proves an
order is taken while every box is gone. Nothing yet picks those objects back up
— that is requirement 8 in `docs/ENGINE_CONTRACT.md` and it belongs to the real
engine, which does not exist. Until it does, degraded mode takes the order and
nobody fulfils it.
