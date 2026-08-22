# Moving mumchimp.com to Cloudflare

You do one thing. Paste two nameservers into one form at 123-reg. Everything
else is a command.

```
CF_API_TOKEN=... node scripts/migrate-domain.mjs mumchimp.com --watch
```

Or, if you would rather see it than type it, the setup console has the same
thing as a box and a button:

```
open "Set up Survival Stack.command"
```

---

## 1. What the command does, in order

1. **Reads the zone from the nameservers answering for it right now.** Not from
   a cache, not from a resolver — from `ns03` and `ns04.domaincontrol.com`
   themselves. It sweeps 41 names against 8 record types, and the name list
   includes every DKIM selector the common mail providers use.
2. **Creates the zone on Cloudflare** through the API. No dashboard.
3. **Waits 20 seconds for Cloudflare's own scan** and compares its findings to
   the sweep. Neither method can list a zone it cannot transfer — both are
   guessing names — so two guessers that agree is the closest thing to a real
   listing you can get. Anything only one of them found is printed and kept.
4. **Writes every record in, grey-clouded.** Nothing is proxied. Today nothing
   is proxied, and turning proxying on during a migration changes how traffic
   reaches the origin and how TLS terminates on the same day, leaving two
   changes to untangle if anything breaks.
5. **Asks both sets of nameservers the same questions** and compares the
   answers. If one record differs it prints `NOT READY` and stops.
6. **Prints the two Cloudflare nameservers** — only then.
7. With `--watch`, **waits for the registrar change to land** and says so.

Step 5 is the whole point. A migration that goes wrong does not crash. The site
loads, the dashboard is green, and an MX or a DKIM record never came across.
Nothing tells you. You find out from a customer a week later asking why nobody
replied.

`test/domain-migration.test.js` holds that rule as a property: remove any single
record from the copy and `ready` must go false. All 6 of the zone's records,
one at a time.

---

## 2. What is live today

Captured 2026-08-22 from `ns03.domaincontrol.com`, the authoritative server.

```
mumchimp.com.                     600  A      66.241.124.37
mumchimp.com.                     600  AAAA   2a09:8280:1::130:427c:0
mumchimp.com.                    1800  MX     5 smtp.google.com.
mumchimp.com.                     600  TXT    "v=spf1 include:_spf.google.com include:spf.mailjet.com ~all"
www.mumchimp.com.                3600  CNAME  prospector-store-web.fly.dev.
api.mumchimp.com.                3600  CNAME  prospector-store-api.fly.dev.
_dmarc.mumchimp.com.             3600  TXT    "v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:support@mumchimp.com;"
mailjet._domainkey.mumchimp.com.  600  TXT    "k=rsa; p=MIIBIjANBgkq…"
```

No CAA. No SRV. **No DS record and no RRSIG — DNSSEC is off**, which is the one
thing that would have blocked a nameserver change outright.

Two angles on the subdomain list, and they agree: a 41-name dig sweep and
certificate transparency (crt.sh) both say `www` and `api`, nothing else.

---

## 3. Who holds what

| | |
|---|---|
| Registrar | **123-Reg Limited**, expiry 2027-06-16 |
| DNS host | GoDaddy (`ns03`/`ns04.domaincontrol.com`) |
| Where nameservers change | **123-reg only** |

123-reg and GoDaddy are the same company now, which is why the nameservers say
GoDaddy while the registration says 123-reg. It changes nothing: the nameserver
field lives at 123-reg.

**123-reg has no public API for a retail account.** Their own DNS management
guide documents the control panel and nothing else. So that one paste is the
floor, and no amount of scripting removes it. The alternative is transferring
the domain to Cloudflare Registrar, which costs money and is a transfer rather
than a setting — your call, not mine, and not part of this.

---

## 4. The one manual step

`https://www.123-reg.co.uk/secure/cpanel/domain/mumchimp.com/manage-nameservers`

Replace the two nameservers with the two the command printed. Nothing else on
that page.

The command prints them only after both sides answer identically, so at the
moment you paste, Cloudflare is already serving the same answers GoDaddy is.
Traffic does not go dark while it propagates — resolvers switch from one correct
answer to an identical correct answer.

---

## 5. Going back

Put `ns03.domaincontrol.com` and `ns04.domaincontrol.com` back at 123-reg. That
is the whole rollback. The GoDaddy zone is untouched by any of this — nothing in
the command deletes or edits a record on the old side. Propagation is minutes
to an hour.

---

## 6. The risks, and what holds each one down

| Risk | What holds it down |
|---|---|
| The shop goes down mid-move | Cloudflare is DNS only. The A, AAAA and CNAME records still point at Fly. Nothing about where the site runs changes. |
| A record does not come across | Step 5 refuses to print the nameservers unless every record matches. The property test proves it refuses. |
| Mail breaks | MX, SPF, DMARC and the Mailjet DKIM selector are in the sweep by name, compared like everything else, and the test asserts each one individually. |
| Cannot roll back | The GoDaddy zone is never written to. Rollback is two strings, five minutes. |
| The stack takes the shop over | The survival stack rewrites the apex A record on cold start — `src/dns.js:27`. It only does that for the domain in `wrangler.jsonc`. Do not put mumchimp.com there until the shop is meant to move, and that is a separate decision with its own change. |

---

## 7. When you do want the stack to run mumchimp

Not yet, and not by accident. `src/dns.js:27` PATCHes the apex to the box it
just started, proxied. Pointing the stack at mumchimp.com means the shop moves
off Fly onto the survival stack the first time anything cold-starts. That is a
migration of the business, not of a DNS zone, and it needs its own plan.
