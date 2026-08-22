# DNS Migration Runbook

Provider-agnostic, machine-agnostic domain cutover.

- **Current mission:** mumchimp.com
- **Started:** 2026-08-22
- **Status:** Zone created, empty. Registrar locked. Token rotated.

This file is the single source of truth. If it conflicts with chat, this file wins.

---

## What exists in the code today

The phases below are the target design. Some of the commands they name are not
written yet. This table is measured against the tree at the time of writing, not
remembered, so that nobody runs a command from this file and gets
`usage:` back and assumes they typed it wrong.

| Command in this runbook | In the code today |
|---|---|
| `node scripts/migrate-domain.mjs <domain> [--watch] [--dry-run]` | **yes** — this is the whole tool |
| `./scripts/cf-bootstrap.sh [--full] [--forget] [--force] [--check]` | **yes** |
| `whois <domain>` lock check | **yes**, as `registrarLock()` inside the migration |
| `--phase=discover\|validate\|prepare\|verify\|cutover\|lockdown` | **yes**, in `scripts/console/phases.mjs`. With no `--phase` a run does discover → validate → prepare → verify and stops before cutover |
| `--rollback` | **yes** — it undoes exactly what the run wrote, and refuses to delete a zone it did not create or that has anything else in it |
| `./scripts/dns-baseline.sh` | **not written, and will not be** — `--phase=discover` writes the baseline into `.migration/<domain>.json`, so a separate script would be a second implementation of it |
| `./scripts/cf-bootstrap.sh --validate-only` | **not written** — the flag that answers this is `--check` |
| Section 5 mock API server and failure matrix | **yes** — `test/helpers/mock-cf-api.mjs` is an HTTP server the real tool talks to through `CF_API_BASE`, and `test/migration-phases.test.js` runs 17 scenarios through it |

**`CF_TOKEN=` is not the variable.** The code reads `CF_API_TOKEN`. And a token
on a command line is readable by every process on the box through `ps` and lands
in shell history, so prefer the keychain (`./scripts/cf-bootstrap.sh`) and use the
environment variable only where there is no store, as in CI.

---

## 0. Philosophy

- **Provider-agnostic:** Cloudflare, Route53, Bunny, whatever. The phases are the
  same. Only the API calls change.
- **Machine-agnostic:** works on macOS, Linux, CI, or a Docker container. No
  `pbpaste` assumptions. No hardcoded paths.
- **Zero side effects on failure:** if any gate fails, the system must be in the
  same state as before the run.
- **Human-verified cutover:** the tool prepares everything. A human confirms the
  last mile.

---

## 1. Pre-flight checklist (do this first, every time)

```bash
# 1.1 Baseline the current live state
./scripts/dns-baseline.sh mumchimp.com > /tmp/mumchimp-baseline-$(date +%s).json

# 1.2 Verify registrar lock status
whois mumchimp.com | grep 'Domain Status'
# EXPECTED: clientUpdateProhibited present = LOCKED (safe)
#           absent = UNLOCKED (dangerous if not ready)

# 1.3 Verify current resolution
for r in A MX TXT NS SOA; do
  dig +short $r mumchimp.com @1.1.1.1
done

# 1.4 Verify the credential (explicit or env — never clipboard in CI)
./scripts/cf-bootstrap.sh --check
```

**STOP if any of these fail. Do not proceed to phase 2.**

---

## 2. The six phases

### Phase 1: DISCOVER

**Goal:** know exactly what exists today without changing anything.

```bash
node scripts/migrate-domain.mjs mumchimp.com --phase=discover
```

Outputs:

- `discovered-zone.json` — current records at the existing nameservers
- `discovered-registrar.json` — lock status, expiry, current nameservers

**Gate:** discovery must return the expected record count. If it returns 0, check
the domain name.

### Phase 2: VALIDATE

**Goal:** prove we have permission to do everything before touching state.

```bash
node scripts/migrate-domain.mjs mumchimp.com --phase=validate
```

Checks, in order:

1. Token can read zones.
2. Token can edit DNS records.
3. If the target zone exists, the token can write a probe record to it.
4. If the target zone does not exist, the token can create zones.

**Gate:** all four must pass. If the zone exists but we cannot write DNS, STOP.
If the zone does not exist but we cannot create zones, STOP.

**Zero-side-effect rule:** if we create a zone to probe it, we delete it on any
validation failure.

### Phase 3: PREPARE

**Goal:** create or update the target zone with all records. Live traffic still
goes to the old nameservers.

```bash
node scripts/migrate-domain.mjs mumchimp.com --phase=prepare
```

What happens:

- Idempotently create the zone if missing.
- Upsert all records from discovery.
- Run an internal diff: discovered vs target.

**Gate:** the internal diff must show 0 differences.

### Phase 4: VERIFY

**Goal:** prove the new nameservers answer identically to the old ones.

```bash
node scripts/migrate-domain.mjs mumchimp.com --phase=verify --watch
```

This queries both nameserver sets, old and new, and compares the answers.

**Gate:** dns-diff reports `Identical` for A, AAAA, MX, TXT, NS, SOA, CNAME.

**CRITICAL:** do not proceed past this gate until it says `Identical`. The zone
is empty until this passes.

### Phase 5: CUTOVER

**Goal:** switch the registrar to the new nameservers.

```bash
node scripts/migrate-domain.mjs mumchimp.com --phase=cutover --dry-run
```

This prints the current nameservers, the proposed nameservers, the lock status
and the rollback command.

**Human gate:** review the output. If it is correct, run it without `--dry-run`.

```bash
node scripts/migrate-domain.mjs mumchimp.com --phase=cutover
```

Prerequisites enforced by the tool:

- `verify` passed within the last 5 minutes.
- The registrar is unlocked, or `--force` with explicit acknowledgment.

### Phase 6: LOCKDOWN

**Goal:** re-lock the domain and verify global propagation.

```bash
node scripts/migrate-domain.mjs mumchimp.com --phase=lockdown
```

Checks:

- Re-enable the registrar lock.
- Query several public resolvers (1.1.1.1, 8.8.8.8, 9.9.9.9) for the new
  nameservers.
- Verify the old nameservers are no longer authoritative.

**Gate:** all resolvers return the new nameservers. The old ones return REFUSED
or answer non-authoritatively.

---

## 3. Rollback procedures

### Rollback before cutover (safe)

```bash
# Delete the Cloudflare zone entirely
node scripts/migrate-domain.mjs mumchimp.com --rollback=prepare
```

Live traffic is unaffected. You are back to phase 0.

### Rollback after cutover (dangerous, time-sensitive)

```bash
# Revert nameservers at the registrar
node scripts/migrate-domain.mjs mumchimp.com --rollback=cutover
```

This requires the registrar to still be unlocked. If you have already locked it,
unlock first.

### Emergency: zone deleted accidentally

If the target zone is deleted after cutover:

1. Re-create the zone immediately.
2. Re-run `prepare` — the records are cached in `discovered-zone.json`.
3. Do **not** re-run `cutover`. The nameservers already point at Cloudflare.

---

## 4. Current state: mumchimp.com (2026-08-22)

| Item | Value | Status |
|---|---|---|
| Live NS | ns03.domaincontrol.com, ns04.domaincontrol.com | ACTIVE |
| Live A | 66.241.124.37 | OK |
| Live MX | 5 smtp.google.com | OK |
| Cloudflare zone | `f52b061676b12e4650d87d3ce57d4896` | EMPTY (0 records) |
| Domain lock | `clientUpdateProhibited` | ON (safe) |
| Token status | Rotated, needs Zone:Read + DNS:Edit | PENDING |

### Exact next steps (manual drill)

1. Create a new Cloudflare token:
   - Zone · DNS · Edit
   - Zone · Zone · Read
   - Resources: Include · Specific zone · mumchimp.com
2. Store it:
   ```bash
   ./scripts/cf-bootstrap.sh
   ```
   It watches the clipboard, so press the copy button on the token page and
   nothing has to be typed or pasted. It refuses to store a token that cannot
   write DNS.
3. Run prepare and verify:
   ```bash
   node scripts/migrate-domain.mjs mumchimp.com --watch
   ```
4. Wait for `Identical`.
5. Unlock the domain at 123-reg.
6. Run cutover, dry run first:
   ```bash
   node scripts/migrate-domain.mjs mumchimp.com --phase=cutover --dry-run
   ```
   If it is correct, run it without `--dry-run`. Until that flag exists, the
   cutover is the two nameservers pasted into the 123-reg form, which the
   migration prints for you.
7. Re-lock the domain.
8. Run the lockdown verification.

---

## 5. Test architecture (future)

### 5.1 Mock API server

A single-file Node mock implementing the Cloudflare surface we touch:

```
GET    /zones?name=:domain
POST   /zones
DELETE /zones/:id
GET    /zones/:id/dns_records
POST   /zones/:id/dns_records
PUT    /zones/:id/dns_records/:record_id
DELETE /zones/:id/dns_records/:record_id
GET    /user/tokens/verify
```

The mock is stateful. It tracks mutations and can be queried for call order.

### 5.2 Failure-injection matrix

| Test | Token | Zone exists | DNS write | Expected |
|---|---|---|---|---|
| `test-invalid-token` | invalid | — | — | Rejects before any mutation. `mutations == []`. |
| `test-no-zone-read` | no Zone:Read | exists | — | "Needs Zone:Read". No zone queries. |
| `test-no-dns-edit` | no DNS:Edit | exists | — | Probes zone, fails, stops. Zone untouched. |
| `test-no-dns-edit-empty` | no DNS:Edit | missing | fails | Creates zone, probes, deletes zone, stops. |
| `test-happy-create` | all perms | missing | ok | Creates zone, writes records, verifies. |
| `test-happy-existing` | all perms | exists | ok | Skips create, writes records, verifies. |
| `test-partial-failure` | all perms | missing | fails on record 4 | Records 1-3 deleted. Zone deleted. |
| `test-foreign-zone` | no DNS:Edit | other zone exists | — | Probes the other zone, fails, stops. Never deletes somebody else's zone. |

### 5.3 State-machine invariants, asserted in every test

```js
// Invariant 1: No mutation before validation
assert.strictEqual(api.mutations.length, 0, 'mutated before validation')

// Invariant 2: If the zone pre-existed, it is never deleted
if (scenario.zonePreExists) {
  assert(api.deletedZones.length === 0, 'deleted a zone we did not create')
}

// Invariant 3: Call order
const callOrder = api.calls.map((c) => c.method + ' ' + c.path)
if (scenario.zoneMissing && !scenario.canWriteDns) {
  const createIndex = callOrder.indexOf('POST /zones')
  const deleteIndex = callOrder.indexOf('DELETE /zones')
  assert(createIndex < deleteIndex, 'zone was not deleted after failed probe')
}
```

### 5.4 Clipboard and I/O layer tests

- Clipboard starts with a 2202-character document, then the token is copied.
- Token with surrounding whitespace.
- Rapid double copy: the wrong thing, then the right thing.
- `pbpaste` / `xclip` / `wl-copy` unavailable, so it falls back to a prompt.
- Non-TTY, so it requires an explicit `--token` or environment variable.

### 5.5 End-to-end drill on a throwaway domain

Monthly, or per release:

1. Buy a $3 domain.
2. Point it at old nameservers, add A and MX.
3. Run the full six-phase migration.
4. Verify resolution.
5. Clean up.

---

## 6. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-22 | Token rotated after transcript exposure | The old token returned 401, confirmed dead |
| 2026-08-22 | Probe before mutate, enforced | Zero side effects on failure |
| 2026-08-22 | The clipboard's current contents are a candidate, not a baseline | The watcher used to snapshot the clipboard at startup and exclude it, so copying the token first — the obvious thing to do — meant waiting out the whole window in silence |
| 2026-08-22 | Cutover blocked until dns-diff says `Identical` | Prevents switching to an empty zone |
| 2026-08-22 | Domain lock treated as a safety net, not an error | `clientUpdateProhibited` is the correct default |

---

## 7. Checklist: starting afresh (the drill)

Use this to rehearse on a new domain, or after resetting state.

- [ ] Domain purchased or controlled
- [ ] Old nameservers have records (A, MX, TXT and so on)
- [ ] Target provider account ready
- [ ] Token created with the correct permissions
- [ ] Token stored securely: keychain, environment, or an explicit argument
- [ ] `./scripts/dns-baseline.sh <domain>` run and the output saved
- [ ] `--phase=discover` run, and the output matches the baseline
- [ ] `--phase=validate` passes all checks
- [ ] `--phase=prepare` completes with 0 diff
- [ ] `--phase=verify --watch` says `Identical`
- [ ] Registrar unlocked, if it was locked
- [ ] `--phase=cutover --dry-run` reviewed and approved
- [ ] `--phase=cutover` executed
- [ ] Registrar re-locked
- [ ] `--phase=lockdown` passes on all public resolvers
- [ ] Old nameservers return non-authoritative or REFUSED
- [ ] Mail flow verified: send and receive
- [ ] Site reachable over HTTPS

---

File version: 1.0
Last updated: 2026-08-22
Next review: after the mumchimp cutover completes
