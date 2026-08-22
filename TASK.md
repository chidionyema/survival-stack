# TASK.md — next week, the week that costs money

Everything below is proved locally already. This is the week the fake
infrastructure is swapped for paid infrastructure, one line at a time.

**Budget: about GBP 12 a month.** Nothing here is a one-off except your time.

Cloudflare Edge replaces the vault box. It does not replace the engine. Workers
are JavaScript and WebAssembly only, so the primary and the standby are still
two real VMs. See `docs/SURVIVAL_STACK_v5.1_CORRECTION.md` section 0b.

| Layer | Runs on | VM |
|---|---|---|
| Control plane, TOTP, provisioning | Cloudflare Worker | No |
| Lighthouse console | Cloudflare Pages | No |
| Health checks and failover | Cloudflare DNS | No |
| Primary engine | Hetzner CX21, EUR 5.35/mo | Yes |
| Standby engine | DigitalOcean 1GB, $6/mo | Yes |
| Object storage | Cloudflare R2, about $2/mo | No |

---

## Before you spend anything

The dry run must be green on the day, not last week.

```
npm test                         # 48 passing, 0 failing
scripts/dry-run.sh               # up, then A to H — 41 assertions
scripts/dry-run.sh down
```

If any of those is red, next week does not start. Fix it first.

---

## Monday — buy, and prove each purchase works before the next one

- [ ] **Hetzner CX21, primary.** Any region. Create it with the API token, not
      the web console, because the Worker will use the same token.
      Proof: `curl -H "Authorization: Bearer $HETZNER_TOKEN" https://api.hetzner.cloud/v1/servers | head -c 200`
- [ ] **DigitalOcean $6 droplet, standby.** 1GB, same region family as your
      customers, different company from Hetzner. That is the whole point.
      Proof: `curl -H "Authorization: Bearer $DO_TOKEN" https://api.digitalocean.com/v2/account | head -c 200`
- [ ] **R2 buckets:** `survival-data` and `survival-audit`.
      Proof: `npx wrangler r2 bucket list`
- [ ] **An SSH key registered at both providers**, same name at both, because
      cloud-init names it once. The setup console reads the names
      out of your provider accounts and offers them.
- [ ] **Do not buy a vault box.** v5.0 had one. It is deleted. If you find
      yourself renting a small VPS to "hold the tooling", stop and re-read
      section 0 of the correction.

Say the running total out loud at the end of Monday. It should be about GBP 12.

## Tuesday — deploy the parts that cost nothing

- [ ] **Everything, from one page.** Double-click `Set up Survival Stack.command`,
      or run `npm run secrets`. Every value is checked against its own service as
      you paste it. The button at the bottom creates the stores, stores the
      secrets, deploys twice, sets the Telegram webhook and messages you.
      Proof: the message arrives on the phone. Then `npx wrangler secret list`
      names them and prints no values.
- [ ] **Lighthouse.** `npx wrangler pages deploy lighthouse`.
      Proof: open the URL on the phone. The status tiles fill in. If they do not,
      `LIGHTHOUSE_ORIGIN` in `wrangler.jsonc` is still `*` or still wrong.
- [ ] **Telegram webhook.** The setup console does it, and proves it by sending
      you a message. Proof: send `/status` from the phone and read the reply.
- [ ] **Both engine boxes, from the phone, not from a laptop.**
      `/cold-start hetzner primary <code>` then `/cold-start digitalocean standby <code>`.
      Proof: the bot edits its own message to "Cold start complete" with an IP
      and a time. That message is the receipt. Screenshot it.
- [ ] **The two DNS records.** The apex is proxied and orange. `p1` and `p2` are
      grey, unproxied, because a health check cannot see through the proxy.
      Proof: `dig +short p1.<domain>` returns the Hetzner IP.

Nothing on Tuesday costs money. If something is broken, it is broken for free.

## Wednesday — the Monday Test, on real infrastructure

Same four scenarios the lab already proves. Run them in this order, and write
down the wall-clock number for each. A number you did not measure is a number
you do not have.

- [ ] **A, failover.** Power off the Hetzner box from the provider console. Do
      not stop the container. A real outage does not stop a container politely.
      Watch: the apex flips to the standby. Expect under 60 seconds.
      Proof: `curl -s https://<domain>/api/whoami` says `standby`, and the bot
      told you before you asked.
- [ ] **B, cold start from a park bench.** Leave the laptop at home. Destroy the
      primary from Telegram, then `/cold-start hetzner <code>`. Wait.
      Proof: the restored box serves an order that was written before you
      destroyed it. If the order count came back zero, litestream is not
      replicating and everything after this is theatre.
- [ ] **C, degraded mode.** Destroy both boxes. Load the shop.
      Proof: the catalogue renders from R2 and `POST /order` returns `ok:true`.
      Then bring a box back and confirm the queued order is drained, not lost.
- [ ] **D, shadow test.** `/shadow-test <code>` with `SHADOW_PROVIDERS` set to
      `hetzner,digitalocean,vultr`. It builds a box on a provider you are not
      using, proves it comes up, and destroys it.
      Proof: `/status` shows the shadow result and `destroyed: true`. Then check
      the provider console yourself. A box you are billed for is not destroyed
      because the control plane says so.
- [ ] **E, the refusals.** A wrong code, a replayed code, an action with no code.
      Proof: three refusals, and nothing in the provider console.
- [ ] **The exit drill.** `scripts/exit-drill.sh` with rclone pointed at R2.
      Proof: `EXIT DRILL GREEN` with a byte count that is not zero. Put it on a
      schedule the same day. An exit that has never run is not an exit.

If A to E are green, the recovery path has been walked end to end by a person
holding a phone. That is the only evidence that counts.

## Thursday — ship, then stop

- [ ] Tag it: `git tag -a v1.0.0 -m "the stack that survives a provider" && git push --tags`
- [ ] Domain on Cloudflare DNS, if it is not already. Registrar stays wherever it
      is; only the nameservers move.
- [ ] Set the shadow-test cron to a night you will be asleep, and confirm the
      Sunday message arrives before you trust it.
- [ ] Write down the three numbers you measured on Wednesday: failover seconds,
      cold-start minutes, exit-drill seconds. They are the baseline. When one of
      them doubles, something rotted.
- [ ] Sleep. That was the requirement.

---

## The two things that will actually go wrong

**The health check cannot see the origin.** Cloudflare cannot health-check a
proxied record. If `p1` and `p2` are orange, failover silently never happens and
everything looks fine until the night it matters. Grey them and prove it with
`dig`.

**The degraded queue never gets drained.** When both boxes are gone the Worker
takes orders and writes them to `orders/queued/` in R2. Nothing picks them up.
The placeholder engine does not, and neither will yours until you build it —
requirement 8 in `docs/ENGINE_CONTRACT.md` has the key format and the two rules
(idempotent by the order's own id, delete only after the order is committed).
Until that exists, degraded mode is a promise to the customer that nobody keeps.
Check it with `wrangler r2 object list survival-data --prefix orders/queued/`
the morning after any outage.

**The restore is empty and nobody notices.** A cold start that comes up healthy
with zero orders looks identical to a cold start that worked, unless you write a
row first and count it afterwards. Test B is written that way for this reason.
Do not shorten it.
