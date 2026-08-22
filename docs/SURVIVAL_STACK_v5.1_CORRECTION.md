# THE SURVIVAL STACK — v5.1 CORRECTION
## The vault box is deleted. The control plane moves to Cloudflare's edge.
### 2026-08-22 | Supersedes v5.0 sections 3, 5, 8, 9, 11, 13, 16

---

## 0. WHAT CHANGED AND WHY

v5.0 kept one pet: the vault box. It held Hermes, the secrets, the `surge` binary
and the shadow-test cron. If it died at 3am, the recovery tooling died with it —
the one machine you need most is the one you cannot recover from itself.

v5.1 deletes that machine. Every function it held moves into a Cloudflare Worker.

| Was (Vault Box) | Now (Cloudflare Worker) | Maintenance |
|---|---|---|
| Hermes (Telegram bot) | Worker webhook handler | $0, never dies |
| `surge` binary (Go) | Worker logic (JavaScript) | $0, globally distributed |
| `.env` secrets (0600, root) | Worker Secrets (encrypted by Cloudflare) | $0, no SSH, no filesystem |
| Shadow test cron | Worker Cron Trigger (Sunday 3am) | $0, no cron daemon |
| Ops console (port 8611) | Static console in Lighthouse + Worker APIs | $0, static + edge |

Saved: €3.79/mo, 100% of vault patching, and the "what if my vault dies at 3am" question.

---

## 0b. WHAT THE EDGE DOES NOT REPLACE

Cloudflare Edge replaces the vault box. It does NOT replace the primary and the standby.

The engine cannot run on Cloudflare Edge. Workers are JavaScript and WebAssembly only.
There is no Python, no Postgres, no long-lived process and no filesystem, so the two
engine boxes stay real VMs.

| Layer | Runs on | VM needed? |
|---|---|---|
| Control plane (Hermes, TOTP, provisioning) | Cloudflare Worker | No |
| Lighthouse (status console) | Cloudflare Pages | No |
| Health checks and auto-failover | Cloudflare DNS | No |
| **Primary engine** | **Hetzner CX21** | **Yes** |
| **Standby engine** | **DigitalOcean $6** | **Yes** |

Eliminated by v5.1: the Hetzner CX11 vault box, EUR 3.79/mo. Nothing else.

## 1. ARCHITECTURE (v5.1)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE (The New Vault)                       │
│                                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐ │
│  │     DNS     │  │Health Check │  │      DEGRADED MODE          │ │
│  │  A Record   │──│  (30s ping) │──│  (Worker: static catalog +  │ │
│  │  → Primary  │  │  2 fails →  │  │   Stripe checkout, queue    │ │
│  │  → Standby  │  │  flip to    │  │   orders in R2)             │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────────┘ │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  LIGHTHOUSE (Pages) — Status, TOTP, Cold Start, Console     │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  WORKER (Hermes + Surge + Secrets + Shadow Tests)           │   │
│  │                                                             │   │
│  │  • Receives Telegram webhooks                               │   │
│  │  • Validates TOTP                                           │   │
│  │  • Calls Hetzner/DO/Vultr APIs directly                     │   │
│  │  • Updates DNS                                              │   │
│  │  • Runs shadow tests (Cron Trigger, Sunday 3am)             │   │
│  │  • Holds all secrets (encrypted by Cloudflare)              │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
         │                │                │
    PRIMARY          STANDBY          COLD START
    Hetzner CX21     DigitalOcean     (Any provider)
    ┌───────────┐    ┌───────────┐    ┌───────────┐
    │  Caddy    │    │  Caddy    │    │  Caddy    │
    │  Engine   │    │  Engine   │    │  Engine   │
    │  YOUR DB  │───►│  YOUR DB  │    │  YOUR DB  │
    │  Sidecar  │    │  (restore)│    │  (restore)│
    └───────────┘    └───────────┘    └───────────┘
```

---

## 2. COLD START — NO POLLING, NO WAITING

The Worker cannot sit and watch a VM boot; a Worker request has a wall-clock limit.
So the VM reports in instead.

1. Telegram: `/cold-start vultr` + TOTP
2. Worker validates TOTP, generates a **nonce** (one-time secret), stores it in KV with a 15-min TTL
3. Worker calls the Vultr API: "create VM with this cloud-init"
4. cloud-init on the new VM carries the nonce and the Worker callback URL
5. VM boots, installs Docker, pulls the image, restores the DB
6. VM calls the Worker: `POST /im-alive {nonce, ip, health}`
7. Worker verifies the nonce, updates Cloudflare DNS, sends Telegram: "✅ Done. 6m 12s."

If it never reports: a Cron Trigger sweeps KV for jobs older than 15 minutes and
sends "❌ Cold start failed. Retry?" — no polling loop anywhere.

---

## 3. AUTO-FAILOVER (YOU SLEEP)

1. Cloudflare health check pings primary every 30s
2. Two failures → DNS flips to the standby IP (instant, because the record is proxied)
3. Worker sends Telegram: "⚠️ Auto-failover. DNS → standby. 12 orders."
4. You sleep.

---

## 4. SHADOW TEST (SUNDAY 3AM)

1. Worker Cron Trigger fires
2. Worker picks a random provider, creates a VM with the shadow flag
3. VM boots, calls back
4. Worker verifies, destroys the VM, sends: "✅ Vultr passed. RTO: 5m 43s."

---

## 5. WHERE SECRETS LIVE NOW

| Secret | Location | Access |
|---|---|---|
| Hetzner token | Cloudflare Worker Secret | Worker only |
| DigitalOcean token | Cloudflare Worker Secret | Worker only |
| Vultr token | Cloudflare Worker Secret | Worker only |
| R2 keys | Cloudflare Worker Secret | Worker only |
| Stripe live key | Cloudflare Worker Secret | Worker only |
| TOTP secret | Cloudflare Worker Secret | Worker validates |
| Cloudflare API token | Cloudflare Worker Secret | Worker updates DNS |

**Zero secrets on any server.** If primary is compromised the attacker gets your app.
They do not get your provider tokens. They cannot spin up boxes. They cannot move DNS.

---

## 6. THE SURFACES (STILL TWO)

**Surface 1 — Telegram.** Webhook points at the Worker URL. `/status`,
`/cold-start <provider>`, `/promote`, `/verify`, `/deploy <version>`, `/destroy <ip>`.
TOTP required for everything that costs money. Progress arrives as message edits:
"Starting…" → "VM created…" → "Done."

**Surface 2 — Lighthouse (Cloudflare Pages).** Static HTML. Loads even if every
server is ash. Shows primary IP, standby IP, health, last failover, RTO, cost.
Buttons: Cold Start (dropdown), Promote Standby, Verify — each behind a TOTP modal.
The ops console becomes a page here, backed by Worker APIs.

---

## 7. THE OLD PYTHON CONSOLE

The 25-screen Python console reads a filesystem and runs Python. That cannot run
in a Worker.

**A) Simplify it (recommended).** Logs come from the R2 audit bucket via a Worker
API. Metrics come from the health endpoints via the Worker. R2 is the filesystem.
The console becomes a static app in Lighthouse.

**B) Run it on standby (only if you must).** Keep it as a container on the standby
box, bound to localhost, reached over a Cloudflare Tunnel. If standby dies you lose
the console until you rebuild — Telegram and Lighthouse still run the crisis.

---

## 8. COST (v5.1)

| Item | Cost |
|---|---|
| Primary (Hetzner CX21) | €5.35/mo |
| Standby (DigitalOcean 1GB) | $6/mo |
| R2 | ~$2/mo |
| Cloudflare (Workers + Pages + DNS) | $0 |
| GitHub (public repo) | $0 |
| **Total** | **~£12/mo** |

---

## 9. IS THIS LOCK-IN?

No, and the exit is a command, not a support ticket:

- Data is in R2, which is S3-compatible — `rclone sync` moves it anywhere.
- The app is a Docker image — it runs anywhere.
- The control plane is ~300 lines of standard JavaScript — it ports to AWS Lambda,
  Deno Deploy, or a $6 box.

The trade made: a €3.79 VPS that needs patching and can die, for a $0 function that
does neither. **The exit drill runs on a schedule and goes red when it stops working** —
the moment it goes red, moving off is the job.

---

## 10. WHAT ENGINEERING BUILDS

1. **Cloudflare Worker** (~300 lines JS): Telegram webhook handler, TOTP validation,
   provider API clients (Hetzner / DO / Vultr), VM creation with nonce + callback,
   DNS update, shadow-test cron, audit logging to R2.
2. **Lighthouse** (static HTML + JS on Pages): status dashboard, TOTP modal, cold-start
   button, log viewer, metrics.
3. **cloud-init YAML**: as v5.0, plus the callback to the Worker with the nonce.
4. **Primary + Standby**: as v5.0 — engine + Caddy + DB sidecar.

**Out of scope:** vault box, `surge` binary (replaced by the Worker), the Python console.

---

## 11. THE MONDAY TEST (VAULT-LESS)

- **A.** Kill primary. Cloudflare flips to standby in <60s. Worker sends Telegram. You sleep. **Pass.**
- **B.** `/cold-start vultr` from the phone. TOTP. Worker creates the VM. VM calls back. DNS updates. "Done." **Pass.**
- **C.** Kill both. Worker queues orders (degraded mode). Cold start from Telegram or Lighthouse. Revenue never stopped. **Pass.**
- **D.** Sunday 3am. Shadow test on a random provider passes. **Pass.**
- **E.** There is no vault to die, to patch, or to worry about. **Pass.**
