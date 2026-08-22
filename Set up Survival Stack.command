#!/bin/bash
# Double-click this. Finder runs it in a terminal, it updates itself and opens
# the setup console in your browser. Nothing to type and nothing to remember.
cd "$(dirname "$0")"
printf '\033]0;Survival Stack setup\007'
echo "Updating..."
git pull --quiet --ff-only 2>/dev/null || echo "  (offline, using what is here)"
exec bash scripts/setup.sh
