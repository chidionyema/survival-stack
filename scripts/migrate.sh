#!/usr/bin/env bash
# One command. Nothing to type.
#
#   ./scripts/migrate.sh mumchimp.com
#
# It finds a Cloudflare credential, or gets you one without you typing it, then
# moves the domain across and waits for the registrar change to land.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -x node_modules/.bin/wrangler ] || npm install --silent
exec node scripts/migrate-domain.mjs "$@" --watch
