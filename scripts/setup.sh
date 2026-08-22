#!/usr/bin/env bash
# This used to be the wizard. It is now four lines that open the real one.
#
# The wizard asked eighteen questions in a fixed order, in a terminal, checking
# none of the answers until the end. One bad paste at question fourteen threw
# away the other thirteen. It also needed a TTY, which meant it could not be
# started from anything except a terminal window.
#
# The console has none of those properties. Start it from anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x node_modules/.bin/wrangler ] || npm install --silent
exec node scripts/console/server.mjs
