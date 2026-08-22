# Corrections

Rules that came from being wrong, in the founder's words where they exist. Each
one names the assumption, what it cost, and the guard that stops it repeating.
A rule here is not advice. It is a thing that already went wrong once.

## Never assume a vendor's token format is static

**2026-08-22.** Founder: *"Token validation failed silently — the `cfut_`
53-char prefix sat there ignored until you noticed. That is a brittle check.
Fix: remove the hardcoded 40-char assumption. Accept any non-empty string from
clipboard, validate it against the API, and fail loud if the API rejects it. Do
not assume vendor token formats are static."*

**The rule: never assume vendor format. Always let the API be the validator.**

The check was `/^[A-Za-z0-9_-]{40}$/`. Cloudflare issues a newer `cfut_` form,
53 characters on the token measured. The clipboard watcher saw a live, active
credential, decided it was the wrong shape, and said nothing at all. It read as
a broken clipboard, and half an hour of a copy window went by.

Two failures in one, and the silence is the worse of them. A wrong guess about a
format is a bug. A wrong guess that produces no output is a bug wearing the
costume of a working tool.

What the validator is allowed to check now, and nothing else:

- a length **floor**, never an equality, and no upper bound
- no whitespace and no `://`, because that is prose or a URL
- a known other-vendor prefix, because checking a candidate means **sending**
  it, and another company's key must never be handed to Cloudflare to be graded

Everything else goes to Cloudflare and Cloudflare answers. Every rejection
carries a sentence saying which thing to fix, the copy or the token.

Guard: `test/cf-auth.test.js`, *incident: a real token was ignored because it
was not 40 characters*. It asserts the `cfut_` form passes, and greps the
validator's source for a length equality or a `{40}` — so putting the
assumption back fails the suite rather than a migration.

## A Cloudflare 200 with an empty list is not a permission error

**2026-08-22.** `GET /accounts` returned `200 []` for a zone-scoped token. The
run read the missing account id as a missing permission and stopped with *"the
token cannot read an account — it needs Account:Read as well"*. It does not.
`POST /zones` with no `account` attaches the zone to the only account the
credential belongs to. Measured live: 200, zone created, nameservers returned.

Guard: `test/incident-cf-permissions.test.js`.

## "Valid" is not "can do the job"

**2026-08-22.** A token with Zone:Edit and no DNS permission created the zone,
listed it, and was graded *"valid, 1 zone in scope"*. It then refused all eight
DNS writes with eight identical lines reading `Authentication error` — a message
about the token, naming nothing about the permission it lacked.

Grade a credential by the call the work actually makes, not by
`/user/tokens/verify`. The run now probes DNS on the zone once, up front, and
says which permission is missing and where to add it.

Guard: `test/incident-cf-permissions.test.js`.

## "Invalid nameservers" at the registrar was the registrar lock

**2026-08-22.** The founder pasted Cloudflare's two nameservers into 123-reg and
got **Invalid nameservers**. Nothing was wrong with them. Both resolve with A
and AAAA records, and both already answer authoritatively for `mumchimp.com` —
`dig SOA mumchimp.com @danica.ns.cloudflare.com` returns NOERROR with the SOA.

The cause was `clientUpdateProhibited` on the domain, which is what 123-reg's
"domain lock" toggle sets. It blocks updates to the domain object, nameservers
included, and the form renders that as a complaint about what was typed.

```
$ whois mumchimp.com | grep 'Domain Status'
   Domain Status: clientDeleteProhibited
   Domain Status: clientRenewProhibited
   Domain Status: clientTransferProhibited
   Domain Status: clientUpdateProhibited
```

`clientTransferProhibited` on its own is the normal, fine case — most domains
carry it and it does not block a nameserver change. Only the update one does.

Guard: `scripts/console/zone.mjs` `registrarLock()`, called at the registrar
step, printing the toggle to turn off. It degrades quietly: no whois binary
means no claim either way, never a claim that the domain is unlocked.
`test/incident-cf-permissions.test.js` pins all three cases.

**The defect underneath it was mine, not the tool's.** The tool only prints the
nameservers after the record comparison passes, which is the whole point of it.
I put them in a chat message while the Cloudflare zone was still empty, and the
founder acted on the message. Nameservers do not get handed over early.
