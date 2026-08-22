# Moving mumchimp.com to Cloudflare

Read section 1 before doing anything. There is one thing in it that would take
the live shop down, and it is not obvious.

---

## 1. The thing to know first

**The survival stack rewrites the apex A record.** When you cold-start a box,
`src/dns.js:27` sends Cloudflare a PATCH that replaces whatever
`mumchimp.com` points at with the new box's IP address.

Right now `mumchimp.com` points at `66.241.124.37`, which is the live shop
running on Fly. So:

**Moving the DNS to Cloudflare is safe.** Nothing changes for anyone. Cloudflare
serves exactly the same answers GoDaddy is serving today.

**Pointing the survival stack at mumchimp.com is not a test.** The first
`/cold-start` takes the live shop off Fly and puts it on a brand new empty box.

Those are two separate decisions. Do the first one now if you want. Do not do
the second one until the stack is what you actually want serving mumchimp.

If you only want to try the setup console end to end, use a domain that is not
serving anything. A spare domain costs about ten pounds, and the survival stack
can then break it as much as it likes.

---

## 2. What is live today

Captured 2026-08-22 from `ns03.domaincontrol.com`, the nameserver actually
answering for the domain.

```
mumchimp.com.                     600  A      66.241.124.37
mumchimp.com.                     600  AAAA   2a09:8280:1::130:427c:0
mumchimp.com.                    1800  MX     5 smtp.google.com.
mumchimp.com.                     600  TXT    "v=spf1 include:_spf.google.com include:spf.mailjet.com ~all"
www.mumchimp.com.                3600  CNAME  prospector-store-web.fly.dev.
api.mumchimp.com.                3600  CNAME  prospector-store-api.fly.dev.
_dmarc.mumchimp.com.             3600  TXT    "v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:support@mumchimp.com;"
mailjet._domainkey.mumchimp.com.  600  TXT    "k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6EOsGczeC659SLmqU453GygowbikI3aEKtZ6NkB2i2oiv7Az23uvKpIHpyQC2OVmVhjZ1tvB/1BpJUgat61upWUPINJU43Sd+FL4cMp9cqXotvKGcy9+IYQ5fwZPsBCss+HNnviH1WyP2R4t8EXHdof9/HxXMB5+zWAv7HIwpGITuKb/dAg2iM/nU5pVPUbCijOokygZMcSZelKlDkG1p0BxDYOqL1xgMmhE3Wg8kX7W+gIJq3BmhQOqHMDMMJZXKjhwAZG4SpuO5UaETF41NILl/0ipT/sf4E8TjGNtdS3OMTRlWZsh0uHLQY7oPYQf/jaKFdnR4WU8S18mVNC3+QIDAQAB"
```

No CAA records. No SRV records. **No DNSSEC** — checked, and that matters,
because a signed domain cannot change nameservers without removing the DS
record at the registrar first and waiting. This one has no such step.

Four of those eight records are mail. Three of them — SPF, DMARC and the
Mailjet DKIM key — are the ones that break silently. The website going down is
loud. Mail deliverability quietly degrading over a week is not.

**Two ways of looking say the same thing.** A sweep of thirty-five likely
subdomain names found exactly `www` and `api`. Certificate transparency logs —
every hostname that has ever been given an HTTPS certificate — list exactly
`mumchimp.com`, `www` and `api`. The two agree.

**One gap, and it is worth closing.** Both methods only find records I thought
to ask about or that were used publicly. The complete list lives in the GoDaddy
account that holds the zone. Export it before you move, and compare. It is one
button in their DNS panel.

---

## 3. Who holds what

This is confusing and has caught us before, so it is written down.

**The domain is registered at 123-reg.** Not GoDaddy. `whois` says
`Registrar: 123-Reg Limited`, renewal `2027-06-16`.

**The DNS is hosted at GoDaddy.** The nameservers are `ns03.domaincontrol.com`
and `ns04.domaincontrol.com`, which are GoDaddy's.

So the records live in a GoDaddy account, but **the nameservers can only be
changed at 123-reg**. Looking at the NS records and going to GoDaddy to change
them is the wrong move and it will not work.

---

## 4. The move

### Step 1 — add the zone to Cloudflare

Log in to Cloudflare, Add a site, type `mumchimp.com`, pick the Free plan.

Cloudflare scans the existing DNS and imports what it can find. It is good but
not complete, which is what step 2 is for.

### Step 2 — check every record came across

Compare the list Cloudflare shows against section 2 above. Add anything
missing by hand.

**Set every record to DNS only — the grey cloud, not the orange one.** A
proxied record changes how traffic reaches Fly and how TLS is terminated. Today
nothing is proxied, so import it that way and change nothing else at the same
time. Turning the orange cloud on is a separate decision for a separate day.

### Step 3 — prove it, before you move anything

Cloudflare will have given you two nameservers, something like
`kate.ns.cloudflare.com`. They are already answering for your zone even though
nobody is asking them yet. So ask them:

```bash
scripts/dns-diff.sh mumchimp.com ns03.domaincontrol.com kate.ns.cloudflare.com
```

It asks both nameservers the same eighty-odd questions and prints every
difference. You want:

```
Identical. All 20 record(s) on ns03.domaincontrol.com are served the same by kate.ns.cloudflare.com.
Safe to change the nameservers at the registrar.
```

If it lists anything as MISSING, that record is being served today and would
stop being served the moment you switch. Add it in Cloudflare and run the check
again. Do not move on until it says identical.

### Step 4 — change the nameservers at 123-reg

Log in to **123-reg**, not GoDaddy. Find mumchimp.com, then Manage
Nameservers. Replace both GoDaddy entries with the two Cloudflare gave you.

Save.

### Step 5 — watch it land

It usually takes minutes. Up to a few hours is normal.

```bash
dig +short NS mumchimp.com                  # should become the Cloudflare pair
dig +short MX mumchimp.com                  # should stay: 5 smtp.google.com.
dig +short TXT mumchimp.com                 # should stay: v=spf1 ...
curl -sI https://mumchimp.com | head -1     # should stay: HTTP/2 200
```

Then send yourself an email at your mumchimp address, and send one out from it.
Mail is the thing that breaks, so mail is the thing to test.

---

## 5. Going back

Log in to 123-reg and put the two GoDaddy nameservers back:

```
ns03.domaincontrol.com
ns04.domaincontrol.com
```

The zone is still sitting in the GoDaddy account, untouched. Nothing about this
migration deletes it. Rollback is the same one field you changed, changed back,
and it takes the same few minutes.

This is why the migration itself is low risk. The part that is not reversible in
one field is pointing the survival stack at the apex record, which is section 1.

---

## 6. When you do want the stack to run mumchimp

Not on day one. The order that does not break anything:

1. Move the DNS to Cloudflare and leave it alone for a week. Confirm mail is
   fine.
2. Run the setup console against a spare domain. Cold-start a box, kill it,
   watch the failover, restore the database. Break it on purpose.
3. Get the real shop running on a survival-stack box, reachable at its own
   address, serving properly.
4. Only then repoint `mumchimp.com` at it, and let the stack own the record.

Step 4 is the moment the shop stops being on Fly. Everything before it is
reversible in minutes.
