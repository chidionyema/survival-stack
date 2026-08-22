#!/usr/bin/env bash
# Everything that has to happen before node can be assumed to exist.
#
#   ./scripts/cf-bootstrap.sh            get a credential and store it
#   ./scripts/cf-bootstrap.sh --full     also ask for API Tokens: Edit
#   ./scripts/cf-bootstrap.sh --forget   remove the stored credential
#
# The flow itself is scripts/cf-bootstrap.mjs. It is in node because the
# clipboard reader, the secret store and the Cloudflare checks are already
# written there and used by the migration; a second copy in bash would be two
# implementations of one thing, and they would disagree within a month.
set -euo pipefail
cd "$(dirname "$0")/.."

red() { printf '\033[31m%s\033[0m\n' "$*"; }
dim() { printf '\033[2m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- pre-flight

os="unknown"
case "$(uname -s)" in
  Darwin*) os=macos ;;
  Linux*)  if grep -qi microsoft /proc/version 2>/dev/null; then os=wsl; else os=linux; fi ;;
  CYGWIN*|MINGW*|MSYS*) os=windows ;;
esac

if ! command -v node >/dev/null 2>&1; then
  red "node is not installed, and everything here runs on it."
  case "$os" in
    macos) dim "  brew install node        (or https://nodejs.org)" ;;
    linux) if   command -v apt-get >/dev/null 2>&1; then dim "  sudo apt-get install -y nodejs npm"
           elif command -v dnf     >/dev/null 2>&1; then dim "  sudo dnf install -y nodejs npm"
           elif command -v pacman  >/dev/null 2>&1; then dim "  sudo pacman -S --noconfirm nodejs npm"
           else dim "  https://nodejs.org"; fi ;;
    wsl)   dim "  sudo apt-get install -y nodejs npm   (inside WSL, not Windows)" ;;
    *)     dim "  https://nodejs.org" ;;
  esac
  exit 1
fi

# Top-level await and AbortSignal.timeout. Both are in 18, and 18 is old.
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 18 ]; then
  red "node $major is too old. This needs 18 or newer."
  exit 1
fi

# A clipboard tool is a convenience, not a requirement: without one the flow
# falls through to a hidden paste. So this offers and never blocks.
if [ "$os" = "linux" ] && ! command -v xclip >/dev/null 2>&1 \
   && ! command -v xsel >/dev/null 2>&1 && ! command -v wl-paste >/dev/null 2>&1; then
  pkg="xclip"; [ -n "${WAYLAND_DISPLAY:-}" ] && pkg="wl-clipboard"
  cmd=""
  command -v apt-get >/dev/null 2>&1 && cmd="sudo apt-get install -y $pkg"
  command -v dnf     >/dev/null 2>&1 && cmd="sudo dnf install -y $pkg"
  command -v pacman  >/dev/null 2>&1 && cmd="sudo pacman -S --noconfirm $pkg"
  if [ -n "$cmd" ] && [ -t 0 ]; then
    dim "No clipboard tool. Without one you have to paste the token by hand."
    printf '  Run "%s" now? [y/N] ' "$cmd"
    read -r yn
    case "$yn" in [yY]*) eval "$cmd" || dim "  install failed - carrying on without it" ;; esac
  fi
fi

exec node scripts/cf-bootstrap.mjs "$@"
