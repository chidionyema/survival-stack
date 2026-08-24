# Onboarding — the cutover

## What it is for

This is the command that changes who serves your customers.

The estate can now build the shop as an image, ship it to any Linux box with Docker and an SSH
login, and prove it is serving before anybody sees it. What it could not do was the last step:
tell the world to go to the new box instead of the old one. That step was written down in every
migration plan as "then repoint DNS" and existed nowhere as a command, which is the real reason
the old provider stayed load-bearing long after nothing technical needed it.

`scripts/cutover.mjs` is that step, and its undo.

It takes an IP address. It does not know or care which provider the box came from. Hetzner,
DigitalOcean, Vultr, a Mac mini in a cupboard — a box is a box.

## What it costs

Nothing. It makes a handful of Cloudflare API calls and exits.

The records it writes carry a 60 second TTL, down from the zone's usual 300. That is deliberate:
it means a rollback reaches the world in about a minute rather than five, and the minute you need
that is the minute you care most.

## What it watches or changes

It changes exactly the records that decide who serves: the apex, `www` and `api`.

It does not touch mail. MX, SPF, DKIM and DMARC are left alone, and one of the tests asserts that
byte for byte. A cutover that damages a mail record turns a bad hour into a bad week, because
nothing tells you — you find out from a customer asking why nobody replied.

Two things it does that are worth knowing before you run it:

**It deletes the apex AAAA record.** Every v6-capable client prefers AAAA over A, so leaving it
pointing at the old host means the cutover only half-happened: some customers move, some do not,
and from the machine that ran the command everything looks right. A v4 address cannot live in an
AAAA record, so the record has to go. `--rollback` puts it back.

**It replaces CNAMEs with A records.** `www` and `api` are CNAMEs today. A CNAME cannot be edited
into an A record, so the pair is a delete followed by a create. The gap between those two calls is
the only moment where a name resolves to nothing, and it is one API call wide.

Before any of that, it asks the new box whether it is serving — over plain HTTP on port 80, with
the exact Host header the box will receive. If the box does not answer, it refuses. A cutover onto
a box that is not serving is an outage you caused on purpose.

It probes over HTTP rather than HTTPS because the box cannot hold a certificate for these names
until it owns the DNS record, which it cannot do until this command runs. A guard that cannot be
satisfied is a guard everybody skips.

## Where it lives

- `scripts/cutover.mjs` — the whole thing.
- `scripts/lib/cf-auth.mjs` — where the Cloudflare credential comes from. Environment variable
  first, then your login keychain. `./scripts/cf-bootstrap.sh` puts one there once, ever.
- `.migration/<domain>.rollback.json` — written before anything changes, so a run that dies
  halfway through still leaves a way back. It is on disk rather than in the process for exactly
  that reason.
- `test/cutover.test.js` — the six rules.

`CUTOVER_DOMAIN` and `CF_ZONE_ID` override the domain and zone. `CF_API_BASE` and
`CUTOVER_PROBE_BASE` swap the API and the probe target for testing, matching `LAB_ORIGIN_P1` in
`src/dns.js`.

## How to turn it off

There is nothing running to turn off. It is a command that does its work and exits.

To undo what it did:

```
node scripts/cutover.mjs --rollback
```

That restores every serving record exactly as it was — type, content, TTL and proxy setting —
from the rollback point taken before the change. Within about a minute the world follows.

To see where things stand at any time, without changing anything:

```
node scripts/cutover.mjs --show
```

## How to turn it back on

```
node scripts/cutover.mjs --to <ip> --dry-run    # every call, none of them made
node scripts/cutover.mjs --to <ip>              # do it
```

## What goes wrong

**"no Cloudflare credential".** Run `./scripts/cf-bootstrap.sh` once. It opens the token page with
the right boxes already ticked, takes the token off the clipboard and puts it in the keychain. It
never asks again.

**It refuses and the box really is fine.** The probe dials port 80. If the box is behind a
firewall that only you can reach, or is serving on a different port, the probe is measuring
something true — the world cannot reach it either. Fix that first. If you are certain, `--force`
proceeds and says so on screen.

**The cutover worked and the site shows a certificate error.** Expected for a few seconds to a few
minutes. The new box asks for its certificate the first time a request arrives for a name it now
owns, and it cannot ask any earlier than that.

**Some people see the new site and some see the old one.** That is DNS caching, and the old TTL
governs it — 300 seconds here, so five minutes. If it persists much beyond that, check the apex
AAAA is really gone with `--show`.

**Everything moved and orders are missing.** Do not roll back first. The old box is still running
and still holds every order placed on it; rolling back DNS does not merge two databases. Stop
taking orders on the new box, reconcile, then decide. Leave the old host up until a full day of
real orders has gone through the new one.
