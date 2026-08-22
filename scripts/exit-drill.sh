#!/usr/bin/env bash
# LAW 19. A dependency whose exit has never been drilled is not portable, it is
# a hope. This copies everything out of Cloudflare to local disk and prints the
# time it took. Run it on a schedule; when it goes red, moving off is the job.
set -euo pipefail
OUT="${1:-./exit-drill-$(date +%Y%m%d)}"
mkdir -p "$OUT"
START=$(date +%s)

echo "1/3 code"
git bundle create "$OUT/survival-stack.bundle" --all

echo "2/3 data out of R2 (needs rclone with an 'r2' remote configured)"
rclone sync r2:survival-data  "$OUT/data"  --transfers 16
rclone sync r2:survival-audit "$OUT/audit" --transfers 16

echo "3/3 the control plane itself"
cp -R src wrangler.jsonc lighthouse cloud-init "$OUT/" 2>/dev/null || true

ELAPSED=$(( $(date +%s) - START ))
BYTES=$(du -sk "$OUT" | cut -f1)
printf '\nEXIT DRILL GREEN\n  target: %s\n  seconds: %s\n  kilobytes: %s\n  date: %s\n' \
  "$OUT" "$ELAPSED" "$BYTES" "$(date -u +%FT%TZ)" | tee "$OUT/DRILL.txt"
