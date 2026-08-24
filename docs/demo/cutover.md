# Demo — the cutover

`scripts/cutover.mjs` moves a domain onto a box you name by IP, and moves it back.

Everything else in this estate could be moved between providers except the four seconds that
actually decide who serves the customer. `src/dns.js` does it from inside the Worker, which is
right for automatic failover and useless for a planned migration you are standing over.
`scripts/dns-diff.sh` reads. Nothing wrote, so every migration plan ended with the sentence "then
repoint DNS" and no way to do it.

Run on 2026-08-24 against the live zone.

## What is serving mumchimp.com today

```
$ node scripts/cutover.mjs --show
credential: your login keychain

== mumchimp.com: 8 records, 4 of them decide who serves

   api.mumchimp.com         CNAME  ttl=300   prospector-store-api.fly.dev
   mumchimp.com             A      ttl=300   66.241.124.37
   mumchimp.com             AAAA   ttl=300   2a09:8280:1::130:427c:0
   www.mumchimp.com         CNAME  ttl=300   prospector-store-web.fly.dev
```

Four of the zone's eight records decide who serves. The other four are mail — MX, SPF, DKIM,
DMARC — and nothing here touches them.

## It refuses to point the domain at a box that is not there

```
$ node scripts/cutover.mjs --to 198.51.100.7 --dry-run
credential: your login keychain

== what is serving mumchimp.com today
   api.mumchimp.com         CNAME  prospector-store-api.fly.dev
   mumchimp.com             A      66.241.124.37
   mumchimp.com             AAAA   2a09:8280:1::130:427c:0
   www.mumchimp.com         CNAME  prospector-store-web.fly.dev

== is 198.51.100.7 serving?
   !!  mumchimp.com             HTTP 0  The operation was aborted due to timeout
   !!  www.mumchimp.com         HTTP 0  The operation was aborted due to timeout
   !!  api.mumchimp.com         HTTP 0  The operation was aborted due to timeout

!! 198.51.100.7 did not answer for mumchimp.com, www.mumchimp.com, api.mumchimp.com.
   Pointing the domain at it would take the shop down for as long as it takes to notice.
   Ship the stack to the box first, then run this again.
   If the box is genuinely fine and the probe is wrong, say so on purpose: --force
exit=1
```

It asks the box with the exact Host header the box will receive, before touching anything.

```
$ node scripts/cutover.mjs --to not-an-ip
!! --to needs an IPv4 address, got: not-an-ip
exit=2
```

## And it says yes

The half a fence usually ships without. Six rules, asserted against a stand-in Cloudflare API and
a box that genuinely answers:

```
$ node --test test/cutover.test.js

✔ it points every serving name at the new box (1202ms)
✔ it destroys the apex AAAA, because a v6 client would otherwise stay on the old host (766ms)
✔ it never touches mail (764ms)
✔ rollback puts back exactly what was there (2498ms)
✔ it refuses a box that is not answering, and names it (10829ms)
✔ --dry-run changes nothing (636ms)

ℹ tests 6
ℹ pass 6
ℹ fail 0
```

The whole suite, to show nothing else moved:

```
$ node --test test/*.test.js
ℹ tests 127
ℹ pass 123
ℹ fail 0
ℹ skipped 4
```

## The AAAA record is the one that bites

A cutover that updates the apex A record and leaves the AAAA alone has half-happened. Every
v6-capable client prefers the AAAA, so those customers keep reaching the old host — and from the
laptop that ran the cutover, everything looks correct. A v4 address cannot go in an AAAA record,
so the honest move is to delete it and let the A record answer everybody. That is one of the six
tests, and it is the one worth reading the code for.
