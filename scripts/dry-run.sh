#!/usr/bin/env bash
# The Monday Test, on a laptop, for nothing.
#
#   scripts/dry-run.sh up      build and start the lab
#   scripts/dry-run.sh test    run tests A to H and print PASS or FAIL
#   scripts/dry-run.sh down    stop everything and remove it
#   scripts/dry-run.sh         up, then test
#
# The Worker under test is the real one. Only the world around it is fake.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
LOGS="${LAB_LOG_DIR:-$ROOT/lab/state}"; mkdir -p "$LOGS"
COMPOSE="docker compose -f lab/dry-run.yml"
WORKER=http://127.0.0.1:8799
EDGE=http://127.0.0.1:8080
SHIM=http://127.0.0.1:2456

# A published test vector, not a secret. The real one lives in Worker Secrets
# and never touches this machine.
LAB_TOTP=JBSWY3DPEHPK3PXP
LAB_HOOK=lab-webhook-secret

# Production waits 15 minutes before it gives up on a box. The lab waits 30
# seconds, so the sweep can be tested for real instead of being trusted.
LAB_STALE_MS=30000

pass=0; fail=0
ok()   { echo "  PASS  $*"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $*"; fail=$((fail+1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# A code can only be spent once, by design. Wait for the next window rather
# than replaying one, which the control plane would refuse — correctly.
#
# The spend record is a file on disk, not a shell variable, because the behave
# harness in features/lab.py spends codes from a different process against the
# same Worker. Two harnesses inside one 30-second window would otherwise replay
# a code and get a 401 that looks like a broken test. Same path both sides.
LAST_CODE_FILE=${LAB_TOTP_SPEND:-$ROOT/lab/state/last-totp}
mkdir -p "$(dirname "$LAST_CODE_FILE")"
code() {
  local c prev
  prev=$(cat "$LAST_CODE_FILE" 2>/dev/null)
  while :; do
    c=$(node -e "import('$ROOT/src/totp.js').then(m=>m.totp('$LAB_TOTP').then(x=>process.stdout.write(x)))")
    [ "$c" != "$prev" ] && break
    sleep 3
  done
  printf '%s' "$c" > "$LAST_CODE_FILE"
  printf '%s' "$c"
}

tg() { # a message from the phone, through the real webhook
  curl -s -X POST "$WORKER/telegram" \
    -H "x-telegram-bot-api-secret-token: $LAB_HOOK" \
    -H 'content-type: application/json' \
    -d "{\"message\":{\"chat\":{\"id\":1},\"text\":$(node -p "JSON.stringify(process.argv[1])" "$1")}}"
}

api() { # the same action from the phone console
  curl -s -X POST "$WORKER/api/action" -H 'content-type: application/json' -d "$1"
}

boxes() { curl -s "$WORKER/api/status"; }

wait_for() { # wait_for <seconds> <shell test>
  local n=$1; shift
  for _ in $(seq "$n"); do eval "$*" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

# ----------------------------------------------------------------------- up
lab_up() {
  step "Building images"
  docker build -q -t survival-lab-engine lab/engine || return 1
  docker build -q -t survival-lab-sqlite sidecars/sqlite || return 1

  step "Starting object storage and the edge"
  $COMPOSE up -d minio minio-init edge || return 1
  wait_for 60 "curl -sf $EDGE >/dev/null || true; docker inspect -f '{{.State.Running}}' lab-edge-1 | grep -q true"

  step "Starting the shim (provider, DNS, Telegram)"
  pkill -f 'lab/shim.js' 2>/dev/null
  ( node lab/shim.js >"$LOGS/shim.log" 2>&1 & )
  wait_for 20 "curl -sf $SHIM/docker/_servers" || { echo "shim did not start"; tail -5 "$LOGS/shim.log"; return 1; }

  step "Starting the real Worker"
  pkill -f 'wrangler dev' 2>/dev/null
  ( npx wrangler dev --port 8799 --local --test-scheduled \
      --var DOMAIN:lab.test \
      --var CF_API_BASE:"$SHIM/cf" --var CF_ZONE_ID:zone --var CF_DNS_RECORD_ID:apex --var CF_API_TOKEN:lab \
      --var TELEGRAM_API_BASE:"$SHIM/tg/bot" --var TELEGRAM_BOT_TOKEN:lab \
      --var TELEGRAM_CHAT_ID:1 --var TELEGRAM_WEBHOOK_SECRET:"$LAB_HOOK" \
      --var TOTP_SECRET:"$LAB_TOTP" \
      --var DOCKER_SHIM_URL:"$SHIM/docker" \
      --var LAB_ORIGIN_P1:http://127.0.0.1:3001 --var LAB_ORIGIN_P2:http://127.0.0.1:3002 \
      --var CONTROL_URL:"$WORKER" \
      --var ENGINE_IMAGE:survival-lab-engine --var DB_BACKUP_IMAGE:survival-lab-sqlite \
      --var R2_BUCKET:prospector --var R2_ENDPOINT:http://minio:9000 \
      --var R2_ACCESS_KEY:admin --var R2_SECRET_KEY:password123 \
      --var SSH_KEY_NAME:lab --var STRIPE_SECRET_KEY:sk_test_lab --var JWT_SECRET:lab \
      --var LIGHTHOUSE_ORIGIN:'*' \
      --var STALE_MS:"$LAB_STALE_MS" --var SHADOW_PROVIDERS:docker \
      >"$LOGS/wrangler.log" 2>&1 & )
  wait_for 60 "curl -sf $WORKER/health | grep -q survival-control-plane" || { echo "worker did not start"; tail -20 "$LOGS/wrangler.log"; return 1; }

  step "Seeding the degraded catalog into R2"
  npx wrangler r2 object put survival-data/catalog/packs.json \
    --file lab/catalog.json --local --content-type application/json >/dev/null 2>&1 \
    && echo "  catalog in place" || echo "  catalog seed failed (degraded page will be empty)"
  echo "Lab up."
}

lab_down() {
  step "Tearing down"
  pkill -f 'wrangler dev' 2>/dev/null
  pkill -f 'lab/shim.js' 2>/dev/null
  docker ps -aq --filter 'label=survival.role' | xargs -r docker rm -f >/dev/null 2>&1
  docker ps -a --format '{{.Names}}' | grep -E '^(primary|standby|shadow)' | xargs -r docker rm -f >/dev/null 2>&1
  $COMPOSE --profile postgres down -v --remove-orphans >/dev/null 2>&1
  docker volume ls -q | grep -E '^(primary|standby|shadow)' | xargs -r docker volume rm -f >/dev/null 2>&1
  echo "Down."
}

registered() { # registered <role>
  boxes | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);process.exit(b.boxes&&b.boxes['$1']?0:1)})"
}
box_ip() {
  boxes | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);process.stdout.write(b.boxes?.['$1']?.ip??'')})"
}

# --------------------------------------------------------------------- tests
test_a() {
  step "TEST A — failover: the standby takes over"
  echo "  cold-starting primary from Telegram"
  tg "/cold-start docker $(code)" >/dev/null
  wait_for 180 "$0 _registered primary" && ok "primary registered by the control plane" || { bad "primary never reported in"; return; }

  echo "  cold-starting standby from the phone console"
  api "{\"action\":\"cold-start\",\"provider\":\"docker\",\"role\":\"standby\",\"code\":\"$(code)\"}" >/dev/null
  wait_for 180 "$0 _registered standby" && ok "standby registered" || bad "standby never reported in"

  local who
  who=$(curl -s --max-time 5 "$EDGE/api/whoami" | node -pe 'JSON.parse(require("fs").readFileSync(0)).role' 2>/dev/null)
  [ "$who" = primary ] && ok "the apex serves the primary" || bad "apex served '$who', expected primary"

  echo "  killing the primary box"
  docker ps -q --filter 'label=survival.role=primary' | xargs -r docker rm -f >/dev/null

  who=$(curl -s --max-time 20 "$WORKER/api/whoami" | node -pe 'JSON.parse(require("fs").readFileSync(0)).role' 2>/dev/null)
  [ "$who" = standby ] && ok "the edge fell through to the standby with no human involved" \
                       || bad "edge served '$who', expected standby"

  echo "  promoting the standby"
  api "{\"action\":\"promote\",\"code\":\"$(code)\"}" >/dev/null
  sleep 3
  who=$(curl -s --max-time 10 "$EDGE/api/whoami" | node -pe 'JSON.parse(require("fs").readFileSync(0)).role' 2>/dev/null)
  [ "$who" = standby ] && ok "the apex record now points at the standby" || bad "apex served '$who' after promote"
}

test_b() {
  step "TEST B — cold start from a park bench, with the data"
  echo "  making sure there is a primary to lose"
  api "{\"action\":\"cold-start\",\"provider\":\"docker\",\"role\":\"primary\",\"code\":\"$(code)\"}" >/dev/null
  wait_for 240 "curl -sf http://127.0.0.1:3001/health" || { bad "no primary to run the test against"; return; }

  echo "  writing an order to it so there is something to lose"
  curl -s -X POST "http://127.0.0.1:3001/api/orders" -H 'content-type: application/json' \
    -d '{"id":"order-before-disaster"}' >/dev/null
  echo "  waiting for litestream to push the write to object storage"
  sleep 15

  echo "  destroying every box"
  docker ps -q --filter 'label=survival.role' | xargs -r docker rm -f >/dev/null
  docker ps -a --format '{{.Names}}' | grep -- '-backup$' | xargs -r docker rm -f >/dev/null 2>&1

  echo "  /cold-start docker, from Telegram, with a TOTP code"
  tg "/cold-start docker $(code)" >/dev/null
  wait_for 240 "curl -sf http://127.0.0.1:3001/health" && ok "a new box came up and reported in" \
    || { bad "cold start never completed"; return; }

  local orders
  orders=$(curl -s --max-time 10 http://127.0.0.1:3001/health | node -pe 'JSON.parse(require("fs").readFileSync(0)).orders' 2>/dev/null)
  [ "${orders:-0}" -ge 1 ] && ok "the restored database carried $orders order(s) across" \
                           || bad "restored box has ${orders:-no} orders — the restore lost data"
}

test_c() {
  step "TEST C — every box gone, the shop stays open"
  docker ps -q --filter 'label=survival.role' | xargs -r docker rm -f >/dev/null
  docker ps -a --format '{{.Names}}' | grep -- '-backup$' | xargs -r docker rm -f >/dev/null 2>&1

  local page
  page=$(curl -s --max-time 20 "$WORKER/")
  echo "$page" | grep -q "Starter Pack" && ok "the catalog still renders from R2" \
                                        || bad "degraded page did not show the catalog"

  local order
  order=$(curl -s --max-time 20 -X POST "$WORKER/order" -H 'content-type: application/json' -d '{"sku":"pack-basic","email":"a@b.test"}')
  echo "$order" | grep -q '"ok":true' && ok "an order was still taken: $(echo "$order" | head -c 80)" \
                                      || bad "the order was refused: $order"

  curl -s "$WORKER/api/audit?limit=50" | grep -q 'degraded' && ok "the queued order is in the audit log" \
                                                            || bad "nothing about degraded mode in the audit log"
}

test_d() {
  step "TEST D — swap the database, the stack does not notice"
  $COMPOSE --profile postgres up -d postgres >/dev/null 2>&1
  wait_for 60 "docker exec lab-postgres-1 pg_isready -U postgres" && ok "postgres is up" || { bad "postgres never became ready"; return; }

  docker build -q -t survival-lab-postgres sidecars/postgres >/dev/null 2>&1 \
    && ok "the postgres sidecar image builds" || bad "the postgres sidecar image failed to build"

  local out
  out=$(docker run --rm --network lab_default \
    -e R2_BUCKET=prospector -e R2_ENDPOINT=http://minio:9000 \
    -e R2_ACCESS_KEY=admin -e R2_SECRET_KEY=password123 \
    -e DB_DATA_PATH=/tmp/pgdata \
    survival-lab-postgres restore 2>&1)
  echo "$out" | grep -q "first boot" && ok "restore on an empty bucket is a first boot, not a crash" \
                                     || bad "restore said: $(echo "$out" | tail -1)"

  out=$(docker run --rm survival-lab-postgres nonsense 2>&1)
  echo "$out" | grep -q "unknown mode" && ok "the sidecar refuses a mode it does not know" || bad "bad mode was accepted"

  docker rm -f lab-engine-pg >/dev/null 2>&1
  docker run -d --name lab-engine-pg --network lab_default -p 3003:3000 \
    -e DB_TYPE=postgres -e ROLE=primary \
    -e DATABASE_URL='postgresql://postgres:labpass@postgres:5432/app' \
    survival-lab-engine >/dev/null 2>&1
  docker exec lab-engine-pg python -c "
import os,psycopg
c=psycopg.connect(os.environ['DATABASE_URL'])
c.execute('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, at TEXT NOT NULL)'); c.commit()" >/dev/null 2>&1
  wait_for 40 "curl -sf http://127.0.0.1:3003/health"
  local db
  db=$(curl -s --max-time 5 http://127.0.0.1:3003/health | node -pe 'JSON.parse(require("fs").readFileSync(0)).db' 2>/dev/null)
  [ "$db" = postgres ] && ok "the same engine image serves on postgres" || bad "engine health reported db='$db'"
  docker rm -f lab-engine-pg >/dev/null 2>&1
}

# --------------------------------------------------------------- tests E to H
shim_next() { curl -s -X POST "$SHIM/docker/_next" -H 'content-type: application/json' -d "$1" >/dev/null; }
tg_clear()  { curl -s -X POST "$SHIM/tg/_clear" >/dev/null; }
tg_said()   { curl -s "$SHIM/tg/_sent" | grep -qF "$1"; }
audit_has() { curl -s "$WORKER/api/audit?limit=100" | grep -qF "$1"; }
primary_image() {
  docker ps -q --filter 'label=survival.role=primary' \
    | head -1 | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null
}
primary_ip() { box_ip primary; }
cron() { curl -s "$WORKER/__scheduled?cron=$1"; }

test_e() {
  step "TEST E — deploy: a new version, and a bad one that never reaches the customer"
  docker tag survival-lab-engine survival-lab-engine:v2 >/dev/null 2>&1
  docker tag survival-lab-engine survival-lab-engine:v3-broken >/dev/null 2>&1

  echo "  making sure something is serving before the deploy"
  if ! wait_for 3 "curl -sf http://127.0.0.1:3001/health"; then
    api "{\"action\":\"cold-start\",\"provider\":\"docker\",\"role\":\"primary\",\"code\":\"$(code)\"}" >/dev/null
    wait_for 240 "curl -sf http://127.0.0.1:3001/health" || { bad "no box to deploy onto"; return; }
  fi

  tg_clear
  echo "  /deploy v2 from Telegram"
  tg "/deploy v2 $(code)" >/dev/null
  wait_for 240 "[ \"\$(docker ps -q --filter 'label=survival.role=primary' | head -1 | xargs -r docker inspect -f '{{.Config.Image}}')\" = survival-lab-engine:v2 ]" \
    && ok "the box now runs the image the deploy named: $(primary_image)" \
    || { bad "the serving box runs '$(primary_image)', not survival-lab-engine:v2"; return; }

  audit_has '"deploy.started"' && ok "the deploy is in the audit log" || bad "no deploy.started in the audit log"
  curl -s "$WORKER/api/audit?limit=100" | grep -qF 'survival-lab-engine:v2' \
    && ok "the audit log names the exact image that shipped" || bad "the audit log does not name the image"

  echo "  deploying a version that boots but never becomes healthy"
  local before; before=$(primary_ip)
  tg_clear
  shim_next '{"health":"bad"}'
  tg "/deploy v3-broken $(code)" >/dev/null
  wait_for 240 "curl -s $SHIM/tg/_sent | grep -q 'not healthy'" \
    && ok "the control plane called the bad version unhealthy" \
    || bad "nothing reported the bad deploy as unhealthy"
  [ "$(primary_ip)" = "$before" ] \
    && ok "the registered primary did not move to the unhealthy box" \
    || bad "an unhealthy box was registered as primary"
  audit_has 'coldstart.unhealthy' && ok "the unhealthy boot is in the audit log" || bad "no coldstart.unhealthy audit line"
}

test_f() {
  step "TEST F — the Sunday shadow test proves a provider and destroys the evidence"
  tg_clear
  local before after
  before=$(curl -s "$SHIM/docker/_servers" | node -pe 'JSON.parse(require("fs").readFileSync(0)).length')

  echo "  firing the Sunday cron trigger, not a hand-rolled call"
  cron '0+3+*+*+SUN' >/dev/null
  wait_for 300 "curl -s $SHIM/tg/_sent | grep -qE 'Shadow test on .* passed'" \
    && ok "the shadow test came up healthy and said so" \
    || { bad "the shadow test never reported a pass"; }

  local s; s=$(curl -s "$WORKER/api/status")
  echo "$s" | grep -q '"lastShadow":{' && echo "$s" | grep -q '"ok":true' \
    && ok "the last shadow result is recorded for the console" || bad "no shadow result in /api/status"

  echo "$s" | grep -q '"destroyed":true' && ok "the control plane says it destroyed the test box" \
                                         || bad "the shadow box was not destroyed"
  after=$(curl -s "$SHIM/docker/_servers" | node -pe 'JSON.parse(require("fs").readFileSync(0)).length')
  [ "$after" -le "$before" ] && ok "the provider is left with no extra box ($before before, $after after)" \
                             || bad "the provider still holds $after boxes, was $before — a shadow box is being billed"
  docker ps -a --format '{{.Names}}' | grep -q '^survival-shadow' \
    && bad "a shadow container is still on the host" || ok "no shadow container left running"
}

test_g() {
  step "TEST G — a box that never reports in is swept, not left billing"
  tg_clear
  # Count what the provider holds first. Earlier tests leave boxes standing on
  # purpose, so "is there a standby?" is the wrong question — the question is
  # whether this one box came back off the bill.
  local held_before
  held_before=$(curl -s "$SHIM/docker/_servers" | node -pe 'JSON.parse(require("fs").readFileSync(0)).length')
  echo "  cold-starting a box that will never call home"
  shim_next '{"deaf":true}'
  api "{\"action\":\"cold-start\",\"provider\":\"docker\",\"role\":\"standby\",\"code\":\"$(code)\"}" >/dev/null

  wait_for 60 "curl -s $WORKER/api/status | grep -q '\"inFlight\":\[{'" >/dev/null
  local open
  open=$(curl -s "$WORKER/api/status" | node -pe 'JSON.parse(require("fs").readFileSync(0)).inFlight?.length ?? 0')
  [ "${open:-0}" -ge 1 ] && ok "the job is open and waiting for a callback" || bad "no open job to sweep"

  echo "  running the sweep while the job is still young — it must leave it alone"
  cron '*%2F5+*+*+*+*' >/dev/null; sleep 2
  open=$(curl -s "$WORKER/api/status" | node -pe 'JSON.parse(require("fs").readFileSync(0)).inFlight?.length ?? 0')
  [ "${open:-0}" -ge 1 ] && ok "the sweep did not kill a box that is still booting" \
                         || bad "the sweep destroyed a job inside its window"

  echo "  waiting for the job to pass the stale window (STALE_MS=${LAB_STALE_MS}ms in the lab, 15m in production)"
  sleep $(( LAB_STALE_MS / 1000 + 3 ))
  cron '*%2F5+*+*+*+*' >/dev/null; sleep 3

  open=$(curl -s "$WORKER/api/status" | node -pe 'JSON.parse(require("fs").readFileSync(0)).inFlight?.length ?? 0')
  [ "${open:-0}" -eq 0 ] && ok "the stale job is gone" || bad "$open job(s) still open after the sweep"
  audit_has 'coldstart.timeout' && ok "the timeout is in the audit log" || bad "no coldstart.timeout audit line"
  tg_said 'never reported in' && ok "the founder was told, without asking" || bad "no Telegram message about the dead box"

  # Two angles, because either one alone can lie. What the control plane says it
  # did, and what the provider is actually still holding.
  curl -s "$WORKER/api/audit?limit=200" \
    | node -pe 'JSON.parse(require("fs").readFileSync(0)).events.some(e=>e.event==="coldstart.timeout"&&e.destroyed===true)' \
    | grep -q true \
    && ok "the sweep says it destroyed the box at the provider" \
    || bad "the sweep did not report a successful destroy"
  local held_after
  held_after=$(curl -s "$SHIM/docker/_servers" | node -pe 'JSON.parse(require("fs").readFileSync(0)).length')
  [ "$held_after" -eq "$held_before" ] \
    && ok "the provider holds no more boxes than before the dead one ($held_before)" \
    || bad "the provider went from $held_before boxes to $held_after — the dead box is still billing"
}

test_h() {
  step "TEST H — the refusals: no fingerprint, no action"
  local before after
  before=$(curl -s "$SHIM/docker/_servers" | node -pe 'JSON.parse(require("fs").readFileSync(0)).length')
  tg_clear

  echo "  a wrong code"
  tg "/cold-start docker 000000" >/dev/null
  if tg_said '🔒'; then ok "a wrong code is refused, and the founder is told"
  else bad "a wrong code was not refused: $(curl -s "$SHIM/tg/_sent" | tail -c 200)"; fi

  echo "  a replayed code"
  local c; c=$(code)
  api "{\"action\":\"cold-start\",\"provider\":\"docker\",\"role\":\"standby\",\"code\":\"$c\"}" >/dev/null
  local replay
  replay=$(api "{\"action\":\"destroy\",\"ip\":\"10.0.0.1\",\"code\":\"$c\"}")
  echo "$replay" | grep -q '"ok":false' && ok "the same code cannot be spent twice: $(echo "$replay" | head -c 60)" \
                                        || bad "a replayed code was accepted: $replay"

  echo "  no code at all"
  local nocode; nocode=$(api '{"action":"promote"}')
  echo "$nocode" | grep -q '"ok":false' && ok "an action with no code is refused" || bad "an action with no code was accepted"

  echo "  a forged Telegram webhook"
  local forged
  forged=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WORKER/telegram" \
    -H 'x-telegram-bot-api-secret-token: not-the-secret' -H 'content-type: application/json' \
    -d '{"message":{"chat":{"id":1},"text":"/status"}}')
  [ "$forged" = 401 ] && ok "a forged webhook gets 401" || bad "a forged webhook returned $forged"
  audit_has 'forged_webhook' && ok "the forgery is in the audit log" || bad "the forgery was not audited"

  echo "  a callback with a nonce nobody issued"
  local fake
  fake=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$WORKER/im-alive" -H 'content-type: application/json' \
    -d "{\"nonce\":\"$(printf 'a%.0s' $(seq 64))\",\"ip\":\"10.9.9.9\",\"health\":\"ok\"}")
  [ "$fake" = 404 ] && ok "an unknown nonce cannot register a box" || bad "an unknown nonce returned $fake"

  echo "  the destroy path, with a real code"
  wait_for 240 "$0 _registered standby" || true
  local ip; ip=$(box_ip standby)
  if [ -n "$ip" ]; then
    local d; d=$(api "{\"action\":\"destroy\",\"ip\":\"$ip\",\"code\":\"$(code)\"}")
    echo "$d" | grep -q '"ok":true' && ok "a destroy with a valid code is carried out" || bad "destroy refused a valid code: $d"
  else
    bad "no standby to destroy — the earlier cold start did not finish"
  fi
}

case "${1:-all}" in
  up)   lab_up ;;
  down) lab_down ;;
  test) test_a; test_b; test_c; test_d; test_e; test_f; test_g; test_h
        printf '\n\033[1m%s passed, %s failed\033[0m\n' "$pass" "$fail"; [ "$fail" -eq 0 ] ;;
  a) test_a ;; b) test_b ;; c) test_c ;; d) test_d ;;
  e) test_e ;; f) test_f ;; g) test_g ;; h) test_h ;;
  _registered) registered "$2" ;;   # used by wait_for, not by people
  all)  lab_up && "$0" test ;;
  *) echo "usage: $0 [up|test|down|a|b|c|d|e|f|g|h]"; exit 2 ;;
esac
