# DNS Migration Runbook

Move a domain onto Cloudflare without dropping a record, and prove it before
the registrar is touched.

- **Last run:** mumchimp.com, 2026-08-22 — complete, locked, serving
- **Tests:** `npm test`
- **Rule:** if this file disagrees with the code, the code is right and this
  file is a bug. Every command below was run.

---

## What the tool does, and the one thing it does not

It reads the zone off whatever nameservers answer today, proves the credential
can do the whole job before doing any of it, writes every record in, and
refuses to print the go-ahead until both sides answer identically.

**It never changes the registrar.** 123-reg has no public API for a retail
account, so the nameserver switch is two strings pasted into one form by a
person, and both lock toggles are yours. `--phase=cutover` *prints* those
strings and gates them. It does not switch anything. Any document saying
otherwise is wrong, and reading it that way is how a domain goes dark.

---

## Quick start

```bash
./scripts/cf-bootstrap.sh                              # once per machine
node scripts/migrate-domain.mjs example.com            # discover → validate → prepare → verify
#   ... you switch the nameservers at the registrar ...
node scripts/migrate-domain.mjs example.com --phase=lockdown
```

That is the whole thing. The first command stops at `Identical.` and prints
your registrar step; the second confirms the world agrees and the lock is back
on.

`--watch` after the first command makes it sit and wait for your registrar
change instead of exiting.

---

## Prerequisites

### 1. A Cloudflare token

`./scripts/cf-bootstrap.sh` opens the page and watches the clipboard. Two
permission rows, and the second is the one that gets missed:

| Scope | Resource | Level |
|---|---|---|
| Zone | Zone | Edit |
| Zone | DNS | Edit |

Zone Resources: **Include · Specific zone · your domain**.

The page's URL carries `permissionGroupKeys` and **the dashboard ignores it** —
the form opens blank with nothing ticked. A run has already come back with
`Zone:Edit` and no `DNS:Edit` and stopped at the first record. The tool prints
the rows for that reason.

Copy either the token or the `curl` example beside it; both work, the tool
reads the token out of the `Authorization: Bearer` header. The value goes
straight into the login keychain (`security` is fed on **stdin**, never argv —
`-w SECRET` as an argument is readable in `ps`). It is never printed.

Optional third row, `User · API Tokens · Edit`, via `--full`: it lets each run
mint a one-hour token and delete it at the end. It also makes the stored
credential able to do anything the account can do. mumchimp.com was migrated
**without** it — two rows, one zone of blast radius, ephemeral tokens off.

```bash
./scripts/cf-bootstrap.sh --check     # is this machine set up? opens nothing
./scripts/cf-bootstrap.sh --force     # replace the stored credential
./scripts/cf-bootstrap.sh --forget    # remove it
./scripts/cf-bootstrap.sh --stdin     # type or pipe it, never the clipboard
```

The clipboard watcher is the seamless path and it has a cost: between the copy
and this tool reading it, the token is on the pasteboard, where every process
running as you can read it. So the clipboard is overwritten the moment the
token is taken, and it says whether that worked.

`--stdin` skips the pasteboard entirely. Piped, the value never lands anywhere
readable — not a clipboard, not a shell history, not this process's argv:

```bash
op read 'op://Private/Cloudflare/token' | ./scripts/cf-bootstrap.sh --stdin
```

### 2. Registrar access

You need to be able to toggle Domain Lock. Nothing else.

---

## Pre-flight

```bash
# What is live right now, from outside the tool
dig +short example.com A; dig +short example.com MX; dig +short example.com NS
whois example.com | grep -i 'domain status'
#   clientUpdateProhibited present = LOCKED (safe, and blocks the switch)
#   absent = UNLOCKED

./scripts/cf-bootstrap.sh --check
```

---

## The six phases

State lives in `.migration/<domain>.json`. Each phase refuses to run before the
one it depends on. Override the directory with `MIGRATION_STATE_DIR`.

### 1. DISCOVER — read the current zone

```bash
node scripts/migrate-domain.mjs example.com --phase=discover
```

Asks the nameservers that answer today and writes the baseline. Prints every
record and the count.

**Gate:** it says so loudly if there is no `MX` — a domain that takes mail and
shows no `MX` means the sweep missed records, and continuing loses mail.

### 2. VALIDATE — prove the credential before using it

```bash
node scripts/migrate-domain.mjs example.com --phase=validate
```

Zone read first, because every later check is phrased in terms of a zone and a
token that cannot list zones fails all of them for one reason. Then zone
create, then a DNS write probe.

**Net zero side effects on failure.** Whether a token can write DNS is a
question about a zone, so there has to be a zone to ask about. If one had to be
created to ask, and the answer is no, it is deleted again:

```
this credential cannot write DNS records
  what is missing: Zone → DNS → Edit
  the zone this run created has been removed - nothing was left behind
```

It records `zoneCreatedByUs`. That field is the single reason rollback is safe:
it is how the tool knows whether deleting a zone is undoing its own work or
destroying someone else's.

### 3. PREPARE — write the records in

```bash
node scripts/migrate-domain.mjs example.com --phase=prepare
```

Every record, all grey-clouded. Cloudflare becomes authoritative DNS, not a
proxy, so no traffic path changes. Idempotent: `+` added, `=` already there.

### 4. VERIFY — the gate

```bash
node scripts/migrate-domain.mjs example.com --phase=verify
```

Asks both nameserver sets the same questions and compares the answers. Re-asks
up to 6 times with 8-second waits, because a record written a second ago is not
yet a record the edge answers with:

```
  8 not answered by Cloudflare yet - waiting (1/5)
  Identical. Cloudflare answers exactly as the old nameservers do.
```

Anything else prints `NOT READY. Do not touch the registrar.` and names each
missing record. **A verify pass goes stale after five minutes** — cutover
refuses an older one rather than trusting it.

### 5. CUTOVER — your step, printed and gated

```bash
node scripts/migrate-domain.mjs example.com --phase=cutover
```

Refuses unless verify passed within five minutes **and** the domain is
unlocked. Then it prints the URL and the two nameservers to paste. It changes
nothing itself.

Order matters, and it is the reverse of the obvious one:

1. All records written, verify says `Identical`
2. **Then** unlock at the registrar
3. Paste the nameservers
4. **Re-lock immediately**

A domain unlocked before the records are staged is a domain unlocked for no
reason, for longer.

### 6. LOCKDOWN — did it land, and is the door shut

```bash
node scripts/migrate-domain.mjs example.com --phase=lockdown
```

Asks `1.1.1.1`, `8.8.8.8` and `9.9.9.9` independently, then checks the
registrar lock. It refuses to say complete while the lock is off:

```
propagated, but the registrar lock is still off
  1.1.1.1: danica.ns.cloudflare.com,tony.ns.cloudflare.com
```

Success is one line: `every resolver answers with the new nameservers, and the
lock is back on`.

---

## Rollback

**Before the registrar switch — safe, and the normal case.**

```bash
node scripts/migrate-domain.mjs example.com --rollback
```

Removes the records this run wrote. Deletes the zone **only** if
`zoneCreatedByUs` is true; otherwise it keeps it and says why. Live traffic was
never on Cloudflare, so nothing outside changes.

**After the switch — put the old nameservers back at the registrar.** Unlock,
paste the old pair (the tool prints them and they are in the state file under
`oldNameServers`), re-lock. Records are still live on the old side unless you
deleted them there, which this tool never does.

---

## Notifications

Off unless configured. Nothing to remember, no flag to pass — set the variables
and events start arriving. `--no-notify` suppresses a run.

```bash
export TELEGRAM_BOT_TOKEN=…      # see docs/TELEGRAM.md
export TELEGRAM_CHAT_ID=…
export OPS_WEBHOOK_URL=…         # see docs/OPS_PORTAL.md
export OPS_WEBHOOK_SECRET=…      # signs the request; never sent

node scripts/lib/notify.mjs --test    # exits non-zero if a channel failed
```

**A notification can never fail the migration.** A dead endpoint, a revoked bot
token, a hung host and an unset variable all end the same way: the run carries
on and the reason is on stderr, with every secret stripped out of it.

The one worth a phone alert is `migration.cutover_ready` — everything is staged
and the registrar is the only thing left.

---

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| `Token valid, but it cannot write DNS` | The second permission row was missed | Add `Zone · DNS · Edit`, then `./scripts/cf-bootstrap.sh --force` |
| `this credential cannot list zones` | No `Zone · Zone · Read` | Same page, add it |
| `NOT READY` right after prepare | Edge has not caught up | It now re-asks for ~40s on its own. If it still fails, the records really are missing |
| `Invalid nameservers` at 123-reg | The domain is locked | `clientUpdateProhibited`. Domain Lock off, switch, back on |
| `the last verify was N minutes ago` | The pass went stale | Run verify again. This is the gate working |
| `propagated, but the registrar lock is still off` | Everything landed, lock not restored | Domain Lock on, re-run lockdown |
| `the domain is locked at the registrar` on cutover | Lock still on | Turn it off, then re-run |
| `nothing arrived` from the bootstrap | Nothing was copied, or it was not a token | Copy the token or the curl example. It says why it refused |
| Keychain prompts or `SecKeychainSearchCopyNext` | Keychain locked or Terminal not permitted | `security unlock-keychain`, then re-run |

---

## State

| File | What it is | Safe to delete? |
|---|---|---|
| `.migration/<domain>.json` | Baseline records, zone id, nameservers, `zoneCreatedByUs`, timestamps | Not while a migration is in flight — rollback and every gate read it |

One file per domain, not two. `MIGRATION_STATE_DIR` moves it.

---

## Tests

```bash
npm test               # everything, no network
npm run matrix         # the migration failure matrix alone
npm run mock-cf        # the mock Cloudflare API on its own
```

The matrix drives the real phases over real HTTP against
`test/helpers/mock-cf-api.mjs`. That matters: a stubbed fetch agrees with
whatever the caller does to it, and the two failures that actually bit — `GET
/accounts` answering 200 with an empty list, and one DNS permission covering
both read and write — are facts about the wire, not about the code.

---

## Decisions, and what was rejected

| Decision | Why | Rejected |
|---|---|---|
| API first, browser last | Only the registrar has no API | "Log in and tell me what you see" |
| Zone-scoped two-row token | One domain of blast radius if it leaks | Account token with `API Tokens · Edit`, which buys ephemeral tokens for account-root reach |
| Probe before mutate, net zero on failure | A failed run must leave nothing behind | Create first, apologise later |
| Verify re-asks before failing | A gate that cries wolf on its own writes teaches you to re-run it until it agrees | Instant single check |
| Signature over the body, never the key | A header carrying the shared secret hands it to whoever receives one request | `X-Migration-Secret: <the secret>` |
| Notifications cannot fail the run | A status message is not worth a dead migration | Throw on webhook error |
| `security` fed on stdin | `-w SECRET` in argv is readable in `ps` — measured, three lines | Passing the token as an argument |
| The clipboard is cleared after the token is read | Read is not taken. It sits there until something else is copied | Leaving it for the next thing that reads the clipboard |

---

## Starting afresh — the checklist

- [ ] Domain resolves, and you know what it serves (site, api, **mail**)
- [ ] `./scripts/cf-bootstrap.sh --check` passes
- [ ] `--phase=discover` — record count matches what you expect, `MX` present if it takes mail
- [ ] `--phase=validate` passes
- [ ] `--phase=prepare` — every line `+` or `=`
- [ ] `--phase=verify` says `Identical`
- [ ] Registrar unlocked
- [ ] Nameservers pasted
- [ ] Registrar **re-locked**
- [ ] `--phase=lockdown` passes on all three resolvers
- [ ] `whois` shows `clientUpdateProhibited` back
- [ ] `dig` from two resolvers: A, MX and any `CNAME` answer as before
- [ ] SPF and DKIM intact — check the `TXT` records by eye, both includes if you use two senders
- [ ] Send **and receive** a real mail
- [ ] Site loads over HTTPS
