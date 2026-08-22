#!/usr/bin/env bash
# Ask two sets of nameservers the same questions and print where they disagree.
#
# Run this before moving a domain. The danger in a DNS migration is never the
# records you copied — it is the one you did not know about. Mail is where it
# bites: an SPF or DKIM record that quietly did not come across does not break
# the website, so nothing looks wrong until deliverability drops a week later.
#
#   scripts/dns-diff.sh mumchimp.com ns03.domaincontrol.com kate.ns.cloudflare.com
#
# Exits 0 when the two answer identically, 1 when they do not.
set -uo pipefail

DOMAIN=${1:?usage: dns-diff.sh <domain> <old-nameserver> <new-nameserver>}
OLD=${2:?}
NEW=${3:?}

# Names worth asking about. Anything a small business is likely to have, plus
# every DKIM selector the common mail providers use. Add more as arguments.
NAMES=(@ www mail smtp imap pop webmail autodiscover autoconfig ftp blog shop
  app api dev staging m cdn static assets calendar docs drive sites status
  _dmarc _domainkey google._domainkey mailjet._domainkey default._domainkey
  selector1._domainkey selector2._domainkey k1._domainkey k2._domainkey
  s1._domainkey s2._domainkey mandrill._domainkey sendgrid._domainkey
  em._domainkey dkim._domainkey smtp._domainkey pm._domainkey
  "${@:4}")

TYPES=(A AAAA CNAME MX TXT CAA SRV)

snapshot() {
  local ns=$1 name type fqdn
  for name in "${NAMES[@]}"; do
    if [ "$name" = "@" ]; then fqdn=$DOMAIN; else fqdn=$name.$DOMAIN; fi
    for type in "${TYPES[@]}"; do
      # +norecurse because these are authoritative servers, not resolvers, and a
      # recursive answer would be somebody else's cache rather than this zone.
      dig +short +norecurse +time=3 +tries=2 "@$ns" "$fqdn" "$type" 2>/dev/null \
        | sed "s|^|$fqdn $type |"
    done
  done | LC_ALL=C sort -u
}

echo "Reading $DOMAIN from $OLD ..." >&2
snapshot "$OLD" > /tmp/dns-old.$$
echo "Reading $DOMAIN from $NEW ..." >&2
snapshot "$NEW" > /tmp/dns-new.$$

# The NS records differ by definition during a migration. Everything else is a
# real difference and the whole point of running this.
grep -v " NS " /tmp/dns-old.$$ > /tmp/dns-old2.$$ && mv /tmp/dns-old2.$$ /tmp/dns-old.$$
grep -v " NS " /tmp/dns-new.$$ > /tmp/dns-new2.$$ && mv /tmp/dns-new2.$$ /tmp/dns-new.$$

MISSING=$(comm -23 /tmp/dns-old.$$ /tmp/dns-new.$$)
EXTRA=$(comm -13 /tmp/dns-old.$$ /tmp/dns-new.$$)
COUNT=$(wc -l < /tmp/dns-old.$$ | tr -d ' ')
rm -f /tmp/dns-old.$$ /tmp/dns-new.$$

echo
if [ -n "$MISSING" ]; then
  echo "MISSING from $NEW — these are served today and would stop being served:"
  echo "$MISSING" | sed 's/^/  /'
  echo
fi
if [ -n "$EXTRA" ]; then
  echo "ONLY on $NEW — new, or changed. Read each one before you move anything:"
  echo "$EXTRA" | sed 's/^/  /'
  echo
fi
if [ -z "$MISSING" ] && [ -z "$EXTRA" ]; then
  echo "Identical. All $COUNT record(s) on $OLD are served the same by $NEW."
  echo "Safe to change the nameservers at the registrar."
  exit 0
fi
echo "Not safe to move yet. Fix the differences above and run this again."
exit 1
