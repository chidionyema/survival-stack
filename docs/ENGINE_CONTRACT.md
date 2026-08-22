# The engine contract

The engine is the only part of this stack that is yours. Everything else —
the control plane, the sidecars, the cloud-init, the edge — treats it as a
container that meets the eight requirements below. Meet them and your image
drops in. Miss one and the box either never serves or serves and loses data.

The lab engine at `lab/engine/app.py` is 90 lines and meets all eight. Read it
if a sentence here is ambiguous; it is the executable copy of this file.

---

## 1. Listen on `$ENGINE_PORT`, on all interfaces

The box publishes `127.0.0.1:$ENGINE_PORT:$ENGINE_PORT` and Caddy reverse
proxies to it. Bind `0.0.0.0:$ENGINE_PORT` inside the container.

Nothing else on the box is reachable from outside. Ports 80 and 443 belong to
Caddy, which holds the certificate for both the apex and the origin host.

`ENGINE_PORT` is set in `wrangler.jsonc` (`"8080"`) and lands in the `.env`.
Hard-coding the port is the most common way to fail this contract: the health
check never connects, `report-in.sh` gives up after ten minutes, and the sweep
destroys the box. The failure looks like a provider problem and is not one.

## 2. Serve `GET /health`

- `200` with a JSON body when the engine can reach its database.
- Any non-2xx when it cannot.

Three separate things poll this and all three act on it:

| Who | What it does with the answer |
|---|---|
| The compose healthcheck | restarts the container |
| `report-in.sh` | decides whether to tell the control plane `ok` or `unhealthy` |
| Cloudflare DNS | takes the box out of rotation |

`/health` must actually touch the database. A handler that returns `200` from
a constant is worse than no handler: a box with an unreadable database will
pass every check, take the apex record, and refuse every order.

The lab engine returns `{"status","version","role","db","orders"}`. Only the
status code is load-bearing; the body is for the Lighthouse console.

## 3. Read one connection string: `DATABASE_URL`

The control plane works out the connection string once, in
`src/cloudinit.js`, and writes it into `/opt/survival/.env`. The engine reads
it and nothing else.

| `DB_TYPE` | `DATABASE_URL` the engine receives |
|---|---|
| `sqlite` | `sqlite://$DB_DATA_PATH/app.db` |
| `postgres` | `postgresql://postgres:<DB_PASSWORD>@db:5432/app` |

Do not derive a path from `DB_DATA_PATH` yourself. The sidecar replicates
exactly `$DB_DATA_PATH/app.db`; an engine that opens a different file is
writing to a database nobody backs up, and it looks perfectly healthy while it
does it.

`DB_TYPE` is also in the `.env`, for an engine that needs to switch driver.
Rendering refuses if `DB_TYPE` is postgres and there is no password, because
the alternative — silently falling back to a local sqlite file — passes every
check in this stack.

## 4. Use SQLite in WAL mode

On sqlite, run `PRAGMA journal_mode=WAL` at connect time. litestream cannot
replicate a database in rollback-journal mode. This is one line and it is the
difference between a cold start restoring your orders and restoring an empty
schema.

## 5. Start after the restore, and expect a database that is already there

Compose orders it for you:

- sqlite: `init` runs the sidecar in `restore` mode and must exit 0. The engine
  starts after that, with `$DB_DATA_PATH/app.db` already in place — or with
  nothing there, on a genuine first boot.
- postgres: `init` restores the cluster into `$DB_DATA_PATH`, then a
  `postgres:16-alpine` service starts on top of it, and the engine waits for
  that service to report healthy.

So the engine must handle both an empty data directory (create the schema) and
a populated one (leave it alone). `CREATE TABLE IF NOT EXISTS` at startup is
enough. Never drop or migrate destructively at boot: on a cold start that is
your restored production data.

A restore that fails integrity exits non-zero and the engine never starts.
That is deliberate — a box that does not serve is recoverable, a box serving a
corrupt database is not.

## 6. Read its role, do not infer it

`ROLE` is `primary` or `standby`. `ORIGIN_HOST` is how this specific box is
addressed (`p1.domain` or `p2.domain`); `DOMAIN` is the apex both boxes serve.

The engine does not decide which box is live — Cloudflare DNS does. A standby
serves the same traffic the moment the health check moves the record, so it
must be able to serve on any request, not sit idle waiting to be promoted.

Use `ROLE` for reporting and for anything that must run in one place only. The
backup sidecar is already restricted to the primary by a compose profile, so
do not write your own leader election.

## 7. Take everything from the environment

`/opt/survival/.env` is mode `0600` and is the only place secrets exist on the
box. The engine gets it via `env_file`. The variables:

| Variable | Meaning |
|---|---|
| `ROLE` | `primary` or `standby` |
| `ORIGIN_HOST` | this box's own name |
| `DOMAIN` | the apex |
| `ENGINE_PORT` | the port to listen on |
| `DB_TYPE` | `sqlite` or `postgres` |
| `DATABASE_URL` | the one connection string |
| `DB_DATA_PATH` | the mounted data volume |
| `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY`, `R2_SECRET_KEY` | object storage |
| `STRIPE_SECRET_KEY`, `JWT_SECRET` | app secrets |
| `POSTGRES_PASSWORD`, `POSTGRES_DB` | postgres only |

No config file is shipped to the box, and there is no way to get one there
short of a new cold start. Anything the engine needs is a variable here, which
means it is a var or a secret on the Worker first.

Never log a secret. The audit log has a property test that refuses any
secret-shaped key; your engine's stdout has nothing of the kind, and stdout is
readable by anyone who can reach the box.

## 8. Drain the degraded-mode queue on startup

While both boxes are gone the Worker keeps selling: the catalog comes from R2
and each order becomes an R2 object. Nothing else picks those up. The engine
has the R2 credentials, so draining the queue is the engine's job, and until
it does it those are orders taken and never fulfilled.

```
key   orders/queued/YYYY-MM-DD/<iso8601>-<uuid>.json
body  {"id": "<uuid>", "at": "<iso8601>", "order": {...}, "source": "degraded"}
```

On startup, and on a timer, list that prefix, apply each order, then delete
the object. Two rules:

- **Idempotent by `id`.** The same object can be seen twice — a crash between
  applying and deleting, or two boxes draining at once. Insert on the order's
  `id`, not a new one.
- **Delete only after the order is committed.** A queue that empties before
  the work lands is worse than one that never drained.

`order` is whatever the customer's form posted, parsed from JSON or form
encoding. Validate it; the Worker only checked it was not empty.

## 9. Be replaceable by tag

`/deploy <tag>` cold-starts a new box running `ENGINE_IMAGE` at that tag,
waits for it to report in healthy, and only then moves DNS. A tag that boots
but never becomes healthy never reaches a customer — the control plane says so
and leaves the old box serving.

Two consequences for the image:

- The image must be pullable from the box with no credentials, or the box
  never boots. A public registry, or a token baked into cloud-init, which this
  stack does not do.
- Two versions of the engine will briefly run against the same replicated
  database. Schema changes must be additive across one release.

---

## What the engine does not have to do

- **TLS.** Caddy holds the certificates.
- **Backups.** The sidecar does it, on the primary only.
- **Failover, promotion or health arbitration.** Cloudflare DNS does it.
- **Provisioning, secrets, or knowing another box exists.** The control plane
  does it, and the engine has no credentials to touch infrastructure.
- **Serving when it is down.** The Worker takes over in degraded mode: the
  catalog comes from R2 and orders are queued there. Picking those orders back
  up is requirement 8 and it is the engine's, not the edge's.

## Checking a candidate image

```bash
docker run --rm -p 8080:8080 \
  -e ENGINE_PORT=8080 -e ROLE=primary -e DB_TYPE=sqlite \
  -e DATABASE_URL=sqlite:///data/app.db -e DB_DATA_PATH=/data \
  -v "$(mktemp -d):/data" your/engine:tag &
curl -fsS http://127.0.0.1:8080/health   # must be 200 on an empty volume
```

If that returns 200 against an empty volume, and again against the same volume
on a second run, the image satisfies requirements 1, 2, 3 and 5. The rest are
read from `docs/` and from the tests in `test/cloudinit.test.js` and
`test/incident-db-selection.test.js`.
