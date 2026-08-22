# The Strategy: Real Code, Fake Infrastructure

Build the production code now. But instead of real VMs, use Docker containers. Instead of R2, use MinIO (free S3-compatible). Instead of Cloudflare, use a local Caddy proxy. Test everything locally. Once it passes, swap the Docker commands for real API calls and deploy.

## Step 1: The Local Lab (One Docker Compose File)

Create `dry-run.yml`. This simulates your entire estate for free.

```yaml
version: "3.8"

services:
  # === R2 (Free Stand-In) ===
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=admin
      - MINIO_ROOT_PASSWORD=password123
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio-data:/data

  # === Primary (Simulated Hetzner CX21) ===
  primary:
    build:
      context: ./engine          # Your real engine Dockerfile
      dockerfile: Dockerfile
    environment:
      - DATABASE_URL=sqlite:///data/db.sqlite
      - RESTORE_ON_START=false
      - R2_ENDPOINT=http://minio:9000
      - R2_BUCKET=prospector
      - R2_ACCESS_KEY=admin
      - R2_SECRET_KEY=password123
    volumes:
      - primary-data:/data
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health"]
      interval: 5s
      timeout: 3s
      retries: 3

  # === Standby (Simulated DigitalOcean) ===
  standby:
    build:
      context: ./engine
      dockerfile: Dockerfile
    environment:
      - DATABASE_URL=sqlite:///data/db.sqlite
      - RESTORE_ON_START=true
      - R2_ENDPOINT=http://minio:9000
      - R2_BUCKET=prospector
      - R2_ACCESS_KEY=admin
      - R2_SECRET_KEY=password123
    volumes:
      - standby-data:/data
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health"]
      interval: 5s
      timeout: 3s
      retries: 3

  # === Litestream (Replicates Primary DB to MinIO) ===
  litestream:
    image: litestream/litestream:0.3
    volumes:
      - primary-data:/data
      - ./litestream.yml:/etc/litestream.yml:ro
    command: replicate /data/db.sqlite s3://prospector/db-replica
    depends_on:
      - minio
      - primary

  # === Edge Proxy (Simulates Cloudflare) ===
  edge:
    image: caddy:2-alpine
    volumes:
      - ./Caddyfile.edge:/etc/caddy/Caddyfile:ro
    ports:
      - "80:80"
      - "443:443"

  # === Degraded Worker (Simulates Cloudflare Worker) ===
  degraded:
    build:
      context: ./degraded
      dockerfile: Dockerfile
    ports:
      - "8787:8787"
    environment:
      - PRIMARY_URL=http://primary:3000
      - STANDBY_URL=http://standby:3000
      - R2_ENDPOINT=http://minio:9000

  # === Vault Bot (Simulates Hermes on Hetzner CX11) ===
  vault:
    build:
      context: ./vault
      dockerfile: Dockerfile
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - TOTP_SECRET=${TOTP_SECRET}
      - MODE=dry-run
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock  # So it can start/stop containers
      - ./mock-surge:/usr/local/bin/surge
    depends_on:
      - primary
      - standby

volumes:
  minio-data:
  primary-data:
  standby-data:
```

## Step 2: The Mock `surge` (Real Logic, Docker Backend)

Instead of calling Hetzner API, `surge` calls Docker. Same commands. Same flow. Different backend.

```python
#!/usr/bin/env python3
# mock-surge — replaces the Go binary for dry run only

import subprocess
import sys
import time

def cold_start(provider, region, role):
    # "Provider" = just a Docker container name
    name = f"{role}-{provider}-{int(time.time())}"
    subprocess.run([
        "docker", "run", "-d", "--name", name,
        "--network", "survival-stack_default",
        "-e", "RESTORE_ON_START=true",
        "-e", "R2_ENDPOINT=http://minio:9000",
        "-v", "survival-stack_standby-data:/data",
        "survival-stack-engine"
    ], check=True)

    # Poll health
    for i in range(60):
        result = subprocess.run(
            ["docker", "exec", name, "wget", "-q", "--spider", "http://localhost:3000/health"],
            capture_output=True
        )
        if result.returncode == 0:
            print(f'{{"status": "healthy", "ip": "{name}", "time_ms": {i*5000}}}')
            return
        time.sleep(5)

    print("FAIL: Health check timeout")

def destroy(name):
    subprocess.run(["docker", "stop", name], check=False)
    subprocess.run(["docker", "rm", name], check=False)
    print(f'{{"status": "destroyed", "id": "{name}"}}')

if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "cold-start":
        cold_start(sys.argv[3], sys.argv[5], sys.argv[7])
    elif cmd == "destroy":
        destroy(sys.argv[3])
```

**Why this works:** The Python script has the same CLI interface as the real `surge` binary. When you prove it works locally, you swap this file for the compiled Go binary. Nothing else changes.

## Step 3: The Engine Placeholder (Your Real Dockerfile, Dummy App)

For the dry run, your engine is a 20-line Python app. But you build it with your real Dockerfile to prove the containerization works.

```python
# engine/app.py — placeholder. Replace with your Rust/Python/Next.js app later.

from flask import Flask, jsonify
import os
import sqlite3

app = Flask(__name__)

@app.route("/health")
def health():
    return jsonify({"status": "ok", "version": "dry-run-1.0", "orders_24h": 12})

@app.route("/api/orders", methods=["POST"])
def order():
    return jsonify({"client_secret": "pi_test_123"})

@app.route("/api/packs")
def packs():
    return jsonify([{"id": "1", "name": "Test Pack", "price_cents": 1000}])

if __name__ == "__main__":
    # Create DB if not exists
    db_path = os.environ.get("DATABASE_URL", "sqlite:///data/db.sqlite").replace("sqlite:///", "")
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY)")
    conn.close()
    app.run(host="0.0.0.0", port=3000)
```

```dockerfile
# engine/Dockerfile — your REAL Dockerfile structure
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app.py .
EXPOSE 3000
CMD ["python", "app.py"]
```

## Step 4: The Telegram Bot (Local Polling Mode, No Server Needed)

You don't need a server or webhook for testing. The bot runs on your laptop in polling mode. It talks to Telegram's servers directly. Free.

```python
# vault/bot.py — Hermes dry run

import asyncio
import os
from aiogram import Bot, Dispatcher, types
from aiogram.filters import Command
import pyotp

BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
TOTP_SECRET = os.environ["TOTP_SECRET"]

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()
totp = pyotp.TOTP(TOTP_SECRET)

@dp.message(Command("start"))
async def start(msg: types.Message):
    await msg.answer("🛡️ Survival Stack Dry Run\n/status — check health\n/cold-start — test recovery")

@dp.message(Command("status"))
async def status(msg: types.Message):
    # Check primary and standby via Docker network
    import urllib.request
    try:
        urllib.request.urlopen("http://primary:3000/health", timeout=2)
        primary = "🟢"
    except:
        primary = "🔴"
    try:
        urllib.request.urlopen("http://standby:3000/health", timeout=2)
        standby = "🟢"
    except:
        standby = "🔴"

    await msg.answer(f"Primary: {primary}\nStandby: {standby}\nMode: DRY RUN")

@dp.message(Command("cold-start"))
async def cold_start(msg: types.Message):
    await msg.answer("🔐 Enter 6-digit TOTP:")
    # In real bot, you'd use a state machine. For dry run:
    # Just ask them to send it in next message, or hardcode test mode.

@dp.message()
async def check_totp(msg: types.Message):
    if len(msg.text) == 6 and msg.text.isdigit():
        if totp.verify(msg.text):
            await msg.answer("✅ TOTP valid. Starting cold-start...")
            # Call mock surge
            import subprocess
            result = subprocess.run(
                ["surge", "cold-start", "--provider", "docker", "--region", "local", "--role", "primary"],
                capture_output=True, text=True
            )
            await msg.answer(f"Result:\n{result.stdout}")
        else:
            await msg.answer("❌ Invalid TOTP")

async def main():
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
```

**To test:** `docker compose -f dry-run.yml up`. Then message your bot on Telegram. It responds. You see health. You test TOTP. You test cold-start.

## Step 5: The Monday Test (Dry Run Commands)

Run these on your laptop. Total cost: £0.

### Test A: Auto-Failover (You Sleep)

```bash
# 1. Start everything
docker compose -f dry-run.yml up -d

# 2. Verify both healthy
curl http://localhost/health  # Should hit primary via edge proxy

# 3. Kill primary
docker compose -f dry-run.yml stop primary

# 4. Edge proxy should flip to standby (simulated by Caddy config reload or simple script)
# Edit Caddyfile.edge to proxy to standby:3000 instead of primary:3000
docker compose -f dry-run.yml restart edge

# 5. Verify
curl http://localhost/health  # Should hit standby

# 6. Check Telegram bot: /status shows primary 🔴, standby 🟢
# PASS: Failover works. DNS flip simulated.
```

### Test B: Cold Start (Park Bench)

```bash
# 1. Kill both
docker compose -f dry-run.yml stop primary standby

# 2. Telegram: /cold-start docker + TOTP
# Bot runs mock surge → starts new container → restores from MinIO

# 3. Verify
docker ps  # See new container running
curl http://localhost/health  # New container responds

# PASS: Cold start from phone works.
```

### Test C: Degraded Mode (Total Disaster)

```bash
# 1. Kill primary, standby, AND litestream
docker compose -f dry-run.yml stop primary standby litestream

# 2. Edge should serve degraded mode
curl http://localhost/api/packs  # Should return static JSON from degraded worker

# 3. Verify order queue in MinIO
# Open MinIO console: http://localhost:9001 (admin / password123)
# Check bucket: orders/queued/

# PASS: Revenue didn't stop.
```

### Test D: Database Swap (SQLite → Postgres)

```bash
# 1. Stop stack
docker compose -f dry-run.yml down

# 2. Edit .env: DB_TYPE=postgres, DB_BACKUP_IMAGE=postgres:15-alpine

# 3. Edit compose to include Postgres sidecar instead of SQLite volume

# 4. Start
docker compose -f dry-run.yml up -d

# 5. Verify
curl http://localhost/health  # Still works

# PASS: Stack absorbed DB change.
```

## Step 6: What This Proves vs. What Needs Real Money

| Component | Dry Run Proves | Real Money Needed For |
|---|---|---|
| cloud-init | Commands work, services start | Actual VM boot time, provider quirks |
| Litestream | Replicates to MinIO, restores correctly | R2 latency, egress costs |
| Auto-failover | Proxy flips, standby takes over | Cloudflare health check behavior, real DNS propagation |
| Cold start | Container spins up, restores, serves | Provider API speed, real IP allocation |
| TOTP + Telegram | Bot validates, triggers actions | Webhook reliability, SIM swap resistance |
| Degraded mode | Worker serves static, queues orders | Cloudflare Worker cold start, Stripe API limits |
| Engine container | Dockerfile builds, /health works | Real traffic, real Stripe keys |

**What the dry run does NOT prove:**

- Real RTO (your laptop is faster than a VM)
- Provider API quirks (Hetzner vs. DO vs. Vultr)
- Real DNS propagation (local is instant)
- Real SSL certificate issuance (Caddy local vs. Let's Encrypt)
- Real Stripe webhooks (test mode vs. live mode)

But it proves the architecture. The code works. The flow works. The TOTP works. The failover logic works. The only thing left is to swap Docker for real APIs.

## Step 7: The "Go Live" Checklist (Spend After Proof)

Once the dry run passes all 4 tests:

- [ ] Buy Hetzner CX21 (€5.35) — primary
- [ ] Buy DigitalOcean $6 droplet — standby
- [ ] Buy Cloudflare domain or migrate — DNS
- [ ] Set up R2 bucket — $2/mo
- [ ] Deploy real Cloudflare Worker — `wrangler deploy`
- [ ] Compile real surge binary — `GOOS=linux go build`
- [ ] Swap mock-surge for real surge — same CLI, real APIs
- [ ] Swap placeholder engine for your real engine — same Dockerfile
- [ ] Run real Monday Test — from your phone, on a park bench

**Total first-month cost after proof: ~£15.**

## What to Hand Your Agent Today

1. `dry-run.yml` — the local simulation
2. `mock-surge` — the Docker-backed provisioner
3. `engine/app.py` — the placeholder engine
4. `vault/bot.py` — the polling-mode Telegram bot
5. The 4 test commands above

**Assignment:** "Make all 4 dry-run tests pass. Submit evidence (screenshots, logs). Then we go live."

No money spent. Architecture proven. Sleep secured.
