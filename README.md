# Survival Stack — serverless control plane

The vault box is deleted. Everything that used to run on it — the Telegram bot,
the provider drivers, the secrets, the shadow-test cron — runs in one Cloudflare
Worker. There is no machine in the recovery path that can die and take the
recovery tooling with it.

Specs: [`docs/SURVIVAL_STACK_v5.0.md`](docs/SURVIVAL_STACK_v5.0.md) (original) and
[`docs/SURVIVAL_STACK_v5.1_CORRECTION.md`](docs/SURVIVAL_STACK_v5.1_CORRECTION.md)
(the vault-less correction this code implements).

Swapping in your own engine container:
[`docs/ENGINE_CONTRACT.md`](docs/ENGINE_CONTRACT.md) — the nine things an image
must do, and the five it does not have to.

## What is here

| Path | What it is |
|---|---|
| `src/index.js` | Router: Telegram webhook, `/im-alive` callback, Lighthouse API, degraded mode, cron |
| `src/totp.js` | RFC 6238 on WebCrypto — no dependency, runs in Worker and Node alike |
| `src/coldstart.js` | Nonce mint → provision → callback → DNS. The whole lifecycle |
| `src/providers/` | One file per provider. Adding AWS is one file and one line |
| `src/degraded.js` | Mode 4: origin dead, edge sells, orders queue in R2 |
| `src/cloudinit.js` | The document that makes a bare VM into a running box |
| `lighthouse/index.html` | The static page. Loads when every server is ash |
| `scripts/console/` | The setup console. A page on loopback, not eighteen terminal prompts |
| `scripts/setup.sh` | Four lines that open it |
| `scripts/console/zone.mjs` | Moves a domain onto Cloudflare and refuses to say ready unless both nameserver sets answer identically |
| `scripts/migrate.sh` | Move a domain onto Cloudflare. One command, nothing typed |
| `scripts/lib/cf-auth.mjs` | Finds a Cloudflare credential, or catches one off the clipboard into the keychain |
| `scripts/exit-drill.sh` | Proves you can leave. Run it on a schedule |

Zero runtime dependencies. `wrangler` is a dev tool, not a dependency of the code.

## Set it up

Double-click **Set up Survival Stack.command** in Finder. Or, from anywhere:

```bash
npm test          # 64 tests, no network
npm run secrets   # opens the setup console in your browser
```

A page opens on `127.0.0.1`. Fill the cards in any order. Each value is checked
against the service that owns it as you paste it, so a wrong token turns red on
the page instead of at 2am: Cloudflare verifies the API token and lists your
domains, Telegram names the bot back, the providers report their SSH keys, Stripe
says whether the key is live or test, and the R2 pair is signed and sent for real.

Three things you no longer supply. The zone id and the apex A record id are looked
up from your domain, and the record is created if it does not exist. Your Telegram
chat id arrives by messaging the bot. The TOTP secret is generated in the page,
shown once as a QR code, and only accepted once you have typed back a working code
— so enrolment is proved before it is stored, not assumed.

One button then creates the KV namespace and both R2 buckets, fills in
`wrangler.jsonc`, stores every secret, deploys twice (the second one carries the
`CONTROL_URL` that the first deploy revealed), sets the Telegram webhook, and
sends you a message. The message arriving is the proof.

Nothing reaches disk. Values live in that process's memory and go out over stdin
to `wrangler secret put`. The page is reachable only from loopback, only with the
token in the URL it printed, and only from its own origin.

Then publish `lighthouse/` to Cloudflare Pages and open it once with
`?api=https://<your-worker>.workers.dev` — it remembers the URL after that.

## Operate it

```
/status                          health of both boxes, DNS, last shadow test
/cold-start hetzner 123456       new primary; DNS moves only when it is healthy
/cold-start vultr standby 123456 build a standby somewhere else
/promote 123456                  standby takes the apex record
/deploy v1.2.3 123456            blue/green onto a fresh box
/destroy 203.0.113.9 123456      remove a box and forget it
/shadow-test 123456              run the Sunday drill now
/verify                          full JSON, both boxes probed
```

The six digits at the end of the line are the TOTP. Every command that spends
money or moves traffic requires one, each code works once, and a control plane
with no `TOTP_SECRET` refuses every command rather than falling open.

## How a cold start actually runs

A Worker cannot sit and watch a VM boot, so it does not try.

1. TOTP checked, a 32-byte nonce minted into KV with a 15-minute life
2. The provider API is called with a cloud-init document carrying that nonce
3. The VM installs Docker, restores the database from R2, starts Caddy
4. The VM `POST`s `/im-alive` with the nonce and its own IP
5. The nonce is burned, DNS moves, Telegram says how long it took

Nothing polls. A box that never reports in is caught by the five-minute sweep,
destroyed, and reported as a failure with a retry command.

## Two DNS records, and why

The apex `A` record is what customers resolve and what failover moves. Two
grey-cloud records, `p1.<domain>` and `p2.<domain>`, point at the primary and the
standby by name. That is what lets the health check and the degraded-mode proxy
reach a specific box with a valid certificate, on a free plan, without the
Worker fetching its own hostname in a loop. Caddy is told to serve both names.

## The exit

`scripts/exit-drill.sh` copies the code, both R2 buckets and the control plane to
local disk and prints the elapsed seconds. R2 is S3-compatible, the app is a
Docker image, and the control plane is standard JavaScript on Web APIs — it ports
to Lambda, Deno Deploy, or a $6 box. Run the drill on a schedule. When it goes
red, moving off is the job.

## Tests

Types where possible, properties where not, incident tests for real bugs — no
example tests of orchestration.

- **Property** — base32 round-trip, TOTP generate/verify, wrong-secret rejection,
  clock drift at the window edge, malformed input, nonce single-use, forged
  nonce changes nothing, the sweep's 15-minute boundary, secret redaction
- **Invariant** — cloud-init refuses to render with a missing value, leaves no
  placeholder, puts secrets only in the `0600` file
- **Incident** — a bad base32 secret refuses rather than authenticating; a
  degraded-mode order survives the dead-origin attempt that already read the
  body; a deploy ships the image it named instead of the configured one; the
  box is told which database it is running instead of guessing; `wrangler
  whoami` exits 0 while saying you are not logged in, so the console reads the
  words; the QR the page draws scans back to the URI it was drawn from; a
  credential that failed its check does not count as filled in; a domain
  migration that dropped a mail record reported as ready; `wrangler login`
  was believed to cover zone creation, so the scope list is now asserted

```
$ npm test
ℹ tests 64
ℹ pass 64
ℹ fail 0
```

## The dry run

Real code, fake infrastructure. The Worker under test is the production one;
only the world around it is faked, so nothing is proven about a Worker that
does not exist.

| Real | Faked by | Where |
|---|---|---|
| The control plane | nothing — the real Worker runs | `wrangler dev` on port 8799 |
| Hetzner / DigitalOcean / Vultr | a provider driver whose backend is `docker run` | `src/providers/docker.js`, `lab/shim.js` |
| R2, for the boxes | MinIO | `lab/dry-run.yml` |
| R2, for the Worker | the local store `wrangler dev` provides | `.wrangler/state` |
| The proxied apex A record | Caddy, reconfigured whenever DNS moves | `lab/state/Caddyfile` |
| Telegram | a recorder the tests can read back | `lab/shim.js` |

```bash
scripts/dry-run.sh          # build, start, run tests A to H
scripts/dry-run.sh e        # one test on a lab that is already up
scripts/dry-run.sh down     # remove all of it
```

Eight tests, each one a thing that has to be true at 3am:

| | What it proves |
|---|---|
| A | The standby takes over with nobody awake, and the apex follows a promote |
| B | A box rebuilt from one Telegram line comes back with the orders in it |
| C | Every box gone and the shop still takes an order |
| D | The same engine image serves on Postgres, and a sidecar refuses a mode it does not know |
| E | A deploy ships the version it named, and an unhealthy version never gets DNS |
| F | The Sunday shadow test proves a provider and leaves no box billing |
| G | A box that never reports in is swept and destroyed, not left running |
| H | A wrong code, a replayed code, no code, a forged webhook and an unknown nonce all refuse |

The behave suite in `features/` proves the same checkpoints through the same
lab. `verify/cp1.sh` to `verify/cp5.sh` run them one checkpoint at a time.

`TASK.md` is the week after this one: what to buy, in what order, and the
command that proves each purchase before the next.

Two seams exist only for the lab, and both default to production behaviour when
unset: `STALE_MS` shortens the 15-minute sweep window so test G finishes in
under a minute, and `POST /docker/_next` on the shim arms one boot to come up
unhealthy or to never report in.

The three environment seams that make this possible (`CF_API_BASE`,
`TELEGRAM_API_BASE`, `LAB_ORIGIN_P1` / `LAB_ORIGIN_P2`) are unset in
production, where the constants in `src/dns.js` and `src/telegram.js` apply.

What the dry run cannot prove: real VM boot time, provider API quirks, DNS
propagation, Let's Encrypt issuance, live Stripe. Those need money and a real
Monday.
