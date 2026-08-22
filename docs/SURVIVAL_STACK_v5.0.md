# THE SURVIVAL STACK
## Complete Infrastructure Resilience System
### v5.0 | 2026-08-22 | AC: Monday Test + Edge Cases

---

## 1. DESIGN PHILOSOPHY

**For:** One person who runs a business and refuses to lose sleep over infrastructure.

**Principles:**
- One weekend to build. One minute to operate.
- If you can use a phone and a banking app, you can recover from a disaster.
- No bash scripts. No black boxes. No platform lock-in.
- Every action that costs money requires your fingerprint (TOTP).
- The system fails gracefully — revenue never stops.
- Stack-agnostic. Provider-agnostic. Database-agnostic.

---

## 2. ARCHITECTURE

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLOUDFLARE (Edge)                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐ │
│  │     DNS     │  │Health Check │  │      DEGRADED MODE          │ │
│  │  A Record   │──│  (30s ping) │──│  (Worker: static catalog +  │ │
│  │  → Primary  │  │  2 fails →  │  │   Stripe checkout, queue    │ │
│  │  → Standby  │  │  flip to    │  │   orders in R2)             │ │
│  │  → New box  │  │  standby    │  └─────────────────────────────┘ │
│  └─────────────┘  └─────────────┘                                  │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │  LIGHTHOUSE (Cloudflare Pages) — Status, TOTP, Cold Start     │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
         │                │                │
    PRIMARY          STANDBY          COLD START
    Hetzner CX21     DigitalOcean     (Any provider)
    (Frankfurt)      $6 droplet       Hetzner/DO/Vultr/AWS/GCP
    ┌───────────┐    ┌───────────┐    ┌───────────┐
    │  Caddy    │    │  Caddy    │    │  Caddy    │
    │  Engine   │    │  Engine   │    │  Engine   │
    │  YOUR DB  │───►│  YOUR DB  │    │  YOUR DB  │
    │  Sidecar  │    │  (restore)│    │  (restore)│
    │  (backup) │    │           │    │           │
    └───────────┘    └───────────┘    └───────────┘
         │                │                │
         └────────────────┴────────────────┘
                          │
                    ┌─────┴─────┐
                    │    R2     │
                    │  Data +   │
                    │  Replica  │
                    └───────────┘
                          ▲
                          │
              ┌───────────┴───────────┐
              │      VAULT BOX        │
              │   (Hetzner CX11)      │
              │  ┌─────────────────┐  │
              │  │  Hermes (TOTP)  │  │
              │  │  Telegram Bot   │  │
              │  └─────────────────┘  │
              │  ┌─────────────────┐  │
              │  │  Ops Console    │  │
              │  │  (port 8611)    │  │
              │  └─────────────────┘  │
              │  ┌─────────────────┐  │
              │  │  surge binary   │  │
              │  │  (drivers for   │  │
              │  │   all providers)│  │
              │  └─────────────────┘  │
              │  ┌─────────────────┐  │
              │  │  .env (0600)    │  │
              │  │  Runtime secrets│  │
              │  └─────────────────┘  │
              │  ┌─────────────────┐  │
              │  │  shadow-test    │  │
              │  │  (weekly cron)  │  │
              │  └─────────────────┘  │
              └───────────────────────┘
                          ▲
                          │
              ┌───────────┴───────────┐
              │        GITHUB         │
              │  Your code → Image    │
              │  Sidecars → Images    │
              │  ghcr.io/you/...      │
              └───────────────────────┘
```

---

## 3. THE THREE BOXES

| Box | Provider | Cost | Role | Survives Primary Death? | Survives Standby Death? | Survives Vault Death? |
|-----|----------|------|------|------------------------|------------------------|----------------------|
| **Vault** | Hetzner CX11 | €3.79/mo | Hermes, Console, surge, secrets | Yes | Yes | N/A |
| **Primary** | Hetzner CX21 | €5.35/mo | Your app, takes orders, replicates DB | N/A | Yes | Yes |
| **Standby** | DigitalOcean $6 | $6/mo | Your app, restores DB, ready to take over | Yes | N/A | Yes |

---

## 4. THE FOUR MODES

### Mode 1: Normal
- Primary serves traffic.
- Standby restores DB from R2 every 60s.
- Litestream (or sidecar) replicates primary DB to R2 in real-time.
- You sleep.

### Mode 2: Auto-Failover (Primary Dies)
- Cloudflare health check fails twice (60s).
- DNS A record flips to standby IP.
- Standby is already warm (DB restored, engine running).
- Hermes sends Telegram: "⚠️ Auto-failover complete. DNS → standby. 12 orders processed."
- You wake up, see the message, decide when to rebuild primary.

### Mode 3: Cold Start (Deliberate or Total Disaster)
- You send `/cold-start <provider>` from Telegram + TOTP.
- Or you click "Cold Start" in Lighthouse + TOTP.
- New VM provisions, cloud-init runs, pulls your image, restores DB.
- Health passes. DNS updates.
- Telegram: "✅ Cold start complete. IP: x.x.x.x. Time: 6m 12s."

### Mode 4: Degraded (Everything Dead)
- Both primary and standby down.
- Cloudflare Worker serves static catalog + Stripe checkout.
- Orders queue in R2 as JSON files.
- Customer sees: "Order received. Pack delivered within 1 hour."
- You fix things in the morning. Revenue never stopped.

---

## 5. GITHUB'S ROLE (Minimal, Clean)

| Feature | What It Does | What It Does NOT Do |
|---------|-------------|---------------------|
| **ghcr.io** | Hosts your engine Docker image | Host runtime secrets |
| **GitHub Actions** | Builds image on `git push` | Deploy infrastructure |
| **GitHub Secrets** | `GITHUB_TOKEN` for pushing to ghcr.io | Hold Hetzner/R2/Stripe/TOTP secrets |
| **Releases** | `surge` binary attached to version tag | Nothing else |

**Runtime secrets live on the vault box only.** Mode 0600. Root only. Never in GitHub. Never in CI.

---

## 6. DATABASE ABSTRACTION (No Lock-In)

The stack does not care about your database. It cares about **backup and restore**.

### Sidecar Pattern

```
stack/sidecars/
├── sqlite/
│   ├── Dockerfile          # litestream/litestream:0.3
│   └── entrypoint.sh       # replicate OR restore
├── postgres/
│   ├── Dockerfile          # postgres:15-alpine + wal-g
│   └── entrypoint.sh       # pg_basebackup to R2 OR restore from R2
└── mysql/
    ├── Dockerfile
    └── entrypoint.sh
```

### How You Switch Databases

**Today (SQLite):**
```bash
DB_TYPE=sqlite
DB_BACKUP_IMAGE=ghcr.io/you/survival-sidecar-sqlite:latest
DB_DATA_PATH=/data
DB_RESTORE_ON_START=true
```

**Tomorrow (Postgres):**
```bash
DB_TYPE=postgres
DB_BACKUP_IMAGE=ghcr.io/you/survival-sidecar-postgres:latest
DB_DATA_PATH=/var/lib/postgresql/data
DB_RESTORE_ON_START=true
```

You change 4 lines in `.env`. The stack pulls the right sidecar. No code changes. No Hermes changes. No cloud-init changes.

---

## 7. PROVIDER ABSTRACTION (No Lock-In)

The `surge` binary uses a driver interface:

```go
type Provider interface {
    Provision(region, size, userData string) (IP, ID, error)
    Destroy(id string) error
    GetRegions() []string
}
```

Drivers:
- `hetzner.go` — today
- `digitalocean.go` — today
- `vultr.go` — today
- `aws.go` — interface ready
- `gcp.go` — interface ready

You add a provider by adding one driver file. Nothing else changes.

---

## 8. THE SURFACES (Two Only)

### Surface 1: Hermes (Telegram Bot)

Host: Vault box. Auth: TOTP for all spend/move actions.

| Command | What It Does | Auth |
|---------|-------------|------|
| `/status` | Health of primary + standby + DB lag + SSL + orders | None |
| `/cold-start <provider>` | New VM, restore, transact | TOTP |
| `/promote` | Standby becomes primary | TOTP |
| `/destroy <ip>` | Destroy VM, clean DNS | TOTP |
| `/deploy <version>` | Pull new image from ghcr.io, restart | TOTP |
| `/verify` | Full JSON report on all boxes | None |
| `/shadow-test` | Run shadow test now | TOTP |
| `/help` | List all commands | None |

Real-time progress: Message updates every 10s during cold-start.

### Surface 2: Lighthouse (Cloudflare Pages)

Host: Cloudflare Pages (free, immortal). Auth: TOTP via Worker.

```
┌─────────────────────────────────────────┐
│  PROSPECTOR OPS    [Auto-failover: ON]  │
├─────────────────────────────────────────┤
│  PRIMARY  🟢 78.46.x.x (Hetzner)        │
│  STANDBY  🟢 167.x.x.x (DigitalOcean)   │
│  DB Lag:  0s                            │
│  SSL:     89 days                       │
│  Orders:  12 (24h)                      │
├─────────────────────────────────────────┤
│  [PROMOTE STANDBY]  [COLD START ▼]      │
│  [VERIFY]                               │
├─────────────────────────────────────────┤
│  Last failover: Never                   │
│  RTO (cold):    6m 12s                  │
│  Cost:          £15.20/mo               │
│  Next shadow:   Sunday 03:00            │
└─────────────────────────────────────────┘
```

Buttons:
- **Promote Standby** — TOTP modal. Instant DNS flip.
- **Cold Start** — Dropdown (Hetzner / DO / Vultr), TOTP modal, progress bar.
- **Verify** — Health check all boxes.

Offline cache: localStorage shows last known state even if all servers are on fire.

### Surface 3: Ops Console (Day-to-Day Only)

Host: Vault box, port 8611. Not in crisis path.

Your existing 25-screen Python dashboard. If vault dies, you still have Lighthouse and Telegram (via standby or cold-start).

---

## 9. THE BINARY (surge)

Language: Go. Single static binary. <10MB.

Commands:

```
surge cold-start --provider {hetzner|digitalocean|vultr} --region {fsn1|ams3} --role {primary|standby}
  → Provisions VM with cloud-init user-data
  → Polls http://<ip>/health every 5s, timeout 300s
  → If role=primary: updates Cloudflare A record
  → Returns: {"ip": "x.x.x.x", "status": "healthy", "dns_updated": true, "time_ms": 372000}

surge verify --host <ip>
  → Full JSON report (health, R2, DB integrity, Stripe, SSL)

surge promote --host <ip>
  → Standby becomes primary. DNS flips.

surge destroy --host <ip> --provider <p> --confirm
  → Destroys VM, removes DNS, logs to R2 audit.

surge shadow-test --provider <p>
  → Cold start, verify, destroy. Reports RTO.
```

What `surge` does NOT do:
- Install Docker (cloud-init does this)
- Configure the app (cloud-init writes configs from templates)
- Handle database specifics (sidecar does this)

---

## 10. cloud-init (The Real "One Button")

One YAML file. All providers. The VM configures itself.

```yaml
#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose

write_files:
  - path: /opt/survival/Caddyfile
    content: |
      {{DOMAIN}} {
        reverse_proxy localhost:{{ENGINE_PORT}}
      }

  - path: /opt/survival/compose.yml
    content: |
      version: "3.8"
      services:
        init:
          image: {{DB_BACKUP_IMAGE}}
          volumes: [{{DB_DATA_PATH}}:/data]
          environment:
            - MODE=restore
            - R2_BUCKET={{R2_BUCKET}}
            - R2_ACCESS_KEY={{R2_ACCESS_KEY}}
            - R2_SECRET_KEY={{R2_SECRET_KEY}}
          command: /entrypoint.sh restore
        engine:
          image: {{ENGINE_IMAGE}}
          restart: unless-stopped
          depends_on: {init: {condition: service_completed_successfully}}
          ports: ["127.0.0.1:{{ENGINE_PORT}}:{{ENGINE_PORT}}"]
          env_file: ./.env
          volumes: [{{DB_DATA_PATH}}:{{DB_DATA_PATH}}]
          healthcheck:
            test: ["CMD", "wget", "-q", "--spider", "http://localhost:{{ENGINE_PORT}}/health"]
            interval: 10s, timeout: 5s, retries: 3, start_period: 30s
        caddy:
          image: caddy:2-alpine
          restart: unless-stopped
          ports: ["80:80", "443:443"]
          volumes: [./Caddyfile:/etc/caddy/Caddyfile:ro]
        {{DB_SIDECAR}}:
          image: {{DB_BACKUP_IMAGE}}
          restart: unless-stopped
          volumes: [{{DB_DATA_PATH}}:/data]
          environment:
            - MODE=backup
            - R2_BUCKET={{R2_BUCKET}}
          profiles: ["primary"]

  - path: /opt/survival/.env
    content: |
      DATABASE_URL={{DATABASE_URL}}
      RESTORE_ON_START={{RESTORE_ON_START}}
      R2_BUCKET={{R2_BUCKET}}
      STRIPE_SECRET_KEY={{STRIPE_SECRET_KEY}}
      JWT_SECRET={{JWT_SECRET}}
      DOMAIN={{DOMAIN}}

runcmd:
  - cd /opt/survival && docker-compose --profile {{ROLE}} up -d
```

---

## 11. SECURITY (Fort Knox Model)

### What Lives on the Vault Box (and nowhere else)

| Secret | Why It Stays Vault-Only |
|--------|------------------------|
| Provider API tokens | Can spin up $500/month boxes |
| R2 secrets | Can read customer data |
| Stripe live keys | Can refund/charge customers |
| Cloudflare token | Can hijack DNS |
| TOTP secret | The root of all auth |
| GitHub PAT (read-only) | Can pull images, nothing else |

### Token Storage

- **Vault box:** `.env` file, mode 0600, root only
- **Your phone:** SSH key in password manager (1Password, Bitwarden)
- **TOTP secret:** In your authenticator app (Aegis, Google Authenticator)
- **Cloudflare Worker:** Secrets via `wrangler secret put`
- **Never:** GitHub, Fly, CI/CD, or any third party

### Threat Matrix

| Threat | Mitigation |
|--------|-----------|
| SIM swap | TOTP required for all actions. No SMS 2FA. |
| Telegram bot stolen | TOTP still required. Bot alone = useless. |
| Vault compromised | SSH key only. UFW. Minimal services. No passwords. |
| GitHub account hacked | Attacker sees code. Cannot touch runtime secrets. |
| Provider token leaked | Scoped to single project/droplet. |
| R2 keys leaked | Scoped to single bucket. Read-only for data. |
| Man-in-the-middle | TLS 1.3. HSTS. Cloudflare edge TLS. |

---

## 12. VERIFICATION (Nothing Manual)

Every action auto-verified:

| Action | Verification | Failure Mode |
|--------|-------------|--------------|
| Provision | SSH reachable within 120s | Destroy + alert |
| Cloud-init | Docker >= 24.0, compose exists | Log error + alert |
| Deploy | `/health` 200 for 30s consecutive | Auto-rollback to previous image |
| Restore | DB integrity check passes | Halt. Alert. Manual required. |
| DNS | `dig` returns new IP within 300s | Alert. Manual check. |
| Failover | Standby `/health` 200 before flip | Alert. Do not flip. |
| Shadow test | Full verify on random provider | Report pass/fail. Log RTO. |

---

## 13. THE SHADOW TEST (Sleep Insurance)

Every Sunday at 3am, cron on vault runs:

```bash
PROVIDER=$(shuf -n1 -e hetzner digitalocean vultr)
surge shadow-test --provider $PROVIDER
```

What happens:
1. New VM on random provider
2. cloud-init boots, pulls image, restores DB
3. `surge verify` runs full check
4. VM destroyed
5. Telegram: "✅ Shadow test on Vultr passed. RTO: 5m 43s."

If it fails: Telegram: "❌ Shadow test on AWS failed. Check logs." You fix it Sunday morning, not at 3am during a real outage.

---

## 14. DEGRADED MODE (Revenue Never Stops)

**Trigger:** Both primary and standby health checks fail for >60s.

**Behavior:**
- Cloudflare Worker serves `packs.json` from R2 cache
- Stripe checkout via Worker (creates PaymentIntent, redirects)
- Orders stored in R2 as JSON: `orders/queued/2026-08-22-uuid.json`
- Customer sees: "Order received. Delivered within 1 hour."
- You get Telegram: "Degraded mode active. 3 orders queued."

**Recovery:** When engine returns, it processes queued orders from R2.

---

## 15. EDGE CASES & FAILURE MODES

### Edge Case 1: Partial Restore (DB Corrupt)
- **Detection:** `PRAGMA integrity_check` (SQLite) or `pg_dump` test (Postgres) fails.
- **Response:** Cold-start halts. Telegram: "❌ DB restore failed. Manual required."
- **Fix:** You inspect R2 replica. Choose snapshot. Force restore from specific timestamp.

### Edge Case 2: Provider API Rate Limit
- **Detection:** `surge provision` returns 429.
- **Response:** Auto-retry with exponential backoff (5s, 10s, 20s, 40s). If still failing, try next provider in list.
- Telegram: "⚠️ Hetzner rate limited. Retrying DigitalOcean..."

### Edge Case 3: cloud-init Hangs
- **Detection:** VM boots but SSH not ready in 120s.
- **Response:** `surge` destroys VM, alerts: "cloud-init timeout. Check provider status page."
- **Fix:** You try different region or provider.

### Edge Case 4: DNS Propagation Delay
- **Detection:** `dig` returns old IP after 300s.
- **Response:** Lighthouse shows "DNS pending..." with countdown.
- Telegram: "DNS updated. Propagation may take 5 minutes."

### Edge Case 5: SSL Certificate Issue
- **Detection:** Caddy fails to get Let's Encrypt cert (rate limit or domain mismatch).
- **Response:** Caddy falls back to self-signed. Lighthouse shows "⚠️ SSL: self-signed."
- **Fix:** Self-signed allows you to keep transacting. You fix domain config later.

### Edge Case 6: SIM Swap + TOTP Compromise
- **Mitigation:** TOTP is on your physical device (Aegis, Google Authenticator). Attacker needs your unlocked phone + your auth app.
- **Extra:** Optional YubiKey NFC gate for `/destroy` and `/promote`.

### Edge Case 7: Vault Box Dies
- **Impact:** You lose Hermes and console. Primary and standby still run.
- **Recovery:** SSH to primary directly. Or use Lighthouse emergency cold-start.
- **Prevention:** Vault is €3.79. Keep a snapshot. Restore in 2 minutes.

### Edge Case 8: Both Providers Have Simultaneous Outage
- **Impact:** Primary and standby down.
- **Response:** Degraded mode (Worker) takes over. Revenue continues.
- **Recovery:** Lighthouse cold-start to third provider.

### Edge Case 9: R2 Bucket Deleted
- **Mitigation:** R2 has 30-day retention + versioning enabled.
- **Response:** If bucket missing, all cold-starts fail. Telegram: "❌ R2 unreachable. Check Cloudflare status."
- **Fix:** R2 is Cloudflare's infrastructure. It does not go down.

### Edge Case 10: Stripe Webhook Failure
- **Detection:** Verify check fails on Stripe webhook endpoint.
- **Response:** Orders still created. Webhooks retried by Stripe for 3 days.
- Telegram: "⚠️ Stripe webhook failing. Check endpoint."

---

## 16. COST TRANSPARENCY

| Item | Cost |
|------|------|
| Vault (CX11) | €3.79/mo |
| Primary (CX21) | €5.35/mo |
| Standby (DO 1GB) | $6/mo |
| R2 | ~$2/mo |
| Cloudflare | $0 |
| GitHub (public) | $0 |
| **Total** | **~£15/mo** |

Per-action costs (surfaced on dashboard):
- Cold-start practice: ~£0.40
- Promote: ~£0.01
- Shadow test: ~£0.40

---

## 17. THE MONDAY TEST

### Scenario A: 3am Outage
1. Kill primary.
2. Cloudflare flips to standby in <60s.
3. Telegram: "Auto-failover complete. 12 orders."
4. **Pass:** You slept.

### Scenario B: Park Bench Migration
1. Close laptop. Phone only.
2. `/cold-start vultr` + TOTP.
3. 6 min: "✅ Transacting."
4. Place order. Stripe succeeds.
5. **Pass:** One command. New provider.

### Scenario C: Total Disaster
1. Kill primary + standby.
2. Worker queues orders.
3. Lighthouse cold start + TOTP.
4. New box. Orders process.
5. **Pass:** Revenue never stopped.

### Scenario D: Database Swap
1. Change `DB_TYPE=postgres` in `.env`.
2. `/deploy` from Telegram.
3. Stack absorbs it.
4. **Pass:** No code changes.

### Scenario E: Shadow Test
1. Sunday 3am. Vultr test runs.
2. Telegram: "✅ Passed. RTO: 5m 43s."
3. **Pass:** Confidence. Sleep.

---

## 18. NON-TECH PERSON EXPERIENCE

### Onboarding (One Time)
1. Buy Hetzner CX11. SSH in once.
2. Run one command: `curl -fsSL setup.sh | bash` (this is the ONLY curl-pipe, and it just installs Docker and git-clones the repo).
3. Fill `.env` from template.
4. Send `/start` to Hermes.
5. Done.

### Day-to-Day
- **Check health:** Open Telegram, type `/status`.
- **Deploy new version:** Type `/deploy v1.2.3`.
- **Migrate provider:** Type `/cold-start do`.
- **Sleep:** Do nothing. Auto-failover handles it.

### Crisis
- **3am:** You sleep. System handles it.
- **Morning:** You see Telegram summary. Decide to rebuild or promote.
- **Park bench:** Open Telegram. One command. Fixed.

---

## 19. ASSIGNMENT

- **Role:** `~/.claude/agents/roles/engineering`
- **Task:** Build the Survival Stack v5.0.
- **AC:** Monday Test A-E all pass. All edge cases handled.
- **Deadline:** Sunday night.
- **Out of scope:** Engine code, sales, commercialization.

*End of spec. Go build. Then go sell.*
