#!/usr/bin/env bash
# One pass, one time. Every question has a default or a reason.
# Nothing here prints a secret back to the screen.
set -euo pipefail

cd "$(dirname "$0")/.."
WRANGLER="npx --yes wrangler@latest"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask()  { local p="$1" d="${2:-}" v; read -r -p "$p${d:+ [$d]}: " v; echo "${v:-$d}"; }
secret() {
  local name="$1" prompt="$2" v
  read -r -s -p "$prompt: " v; echo
  if [ -z "$v" ]; then echo "  skipped $name"; return; fi
  printf '%s' "$v" | $WRANGLER secret put "$name" >/dev/null
  echo "  stored $name"
}

say "Survival Stack — one-time setup"
echo "This stores secrets in Cloudflare, encrypted. Nothing is written to this machine."

say "1. Cloudflare login"
$WRANGLER whoami >/dev/null 2>&1 || $WRANGLER login

say "2. State stores"
echo "Creating the KV namespace and the two R2 buckets (skipped if they exist)."
$WRANGLER kv namespace create STATE 2>&1 | grep -E 'id|already' || true
$WRANGLER r2 bucket create survival-audit 2>&1 | grep -Ev '^$' || true
$WRANGLER r2 bucket create survival-data  2>&1 | grep -Ev '^$' || true
echo
echo "Paste the KV id printed above into wrangler.jsonc (kv_namespaces[0].id), then press return."
read -r _

say "3. Your TOTP secret"
echo "This is the key your authenticator app holds. Generate one now if you have none:"
echo "  head -c 20 /dev/urandom | base32 | tr -d '='"
echo "Add it to Aegis / Google Authenticator as a TOTP entry BEFORE continuing."
secret TOTP_SECRET "TOTP secret (base32, hidden)"

say "4. Telegram"
echo "Create a bot with @BotFather, then send it any message from the phone you will use."
secret TELEGRAM_BOT_TOKEN "Bot token (hidden)"
CHAT_ID=$(ask "Your Telegram chat id (see @userinfobot)")
HOOK_SECRET=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
printf '%s' "$CHAT_ID"     | $WRANGLER secret put TELEGRAM_CHAT_ID >/dev/null
printf '%s' "$HOOK_SECRET" | $WRANGLER secret put TELEGRAM_WEBHOOK_SECRET >/dev/null
echo "  stored TELEGRAM_CHAT_ID and a fresh webhook secret"

say "5. Cloudflare DNS"
secret CF_API_TOKEN "Cloudflare API token with Zone:DNS:Edit (hidden)"
printf '%s' "$(ask 'Cloudflare zone id')"      | $WRANGLER secret put CF_ZONE_ID >/dev/null
printf '%s' "$(ask 'Apex A record id')"        | $WRANGLER secret put CF_DNS_RECORD_ID >/dev/null

say "6. Providers — leave blank to skip any you do not use"
secret HETZNER_TOKEN       "Hetzner API token (hidden)"
secret DIGITALOCEAN_TOKEN  "DigitalOcean token (hidden)"
secret VULTR_TOKEN         "Vultr API key (hidden)"

say "7. R2 keys for the boxes, and app secrets"
secret R2_ACCESS_KEY    "R2 access key id (hidden)"
secret R2_SECRET_KEY    "R2 secret access key (hidden)"
secret STRIPE_SECRET_KEY "Stripe live secret key (hidden)"
secret JWT_SECRET        "App JWT secret (hidden)"
SSH_KEY=$(ask "SSH key name registered at your providers" "survival")
printf '%s' "$SSH_KEY" | $WRANGLER secret put SSH_KEY_NAME >/dev/null

say "8. Deploy"
$WRANGLER deploy

WORKER_URL=$(ask "The workers.dev URL printed above")
say "9. Point Telegram at it"
BOT_TOKEN=$(ask "Paste the bot token once more (used here, not stored)")
curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=${WORKER_URL}/telegram" \
  -d "secret_token=${HOOK_SECRET}" \
  -d 'allowed_updates=["message"]' | head -c 200
echo

say "Done. Send /status to your bot."
echo "Set CONTROL_URL in wrangler.jsonc to ${WORKER_URL} and run 'npm run deploy' once more."
