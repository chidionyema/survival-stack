#!/usr/bin/env bash
# LAW 19. A dependency whose exit has never been drilled is not portable, it is
# a hope. This copies everything out of Cloudflare to local disk and prints the
# time it took. Run it on a schedule; when it goes red, moving off is the job.
#
# It talks S3, so the same script drills Cloudflare R2 and the MinIO in the lab.
# Point it at either with the four variables below.
#
#   R2_ENDPOINT    https://<account>.r2.cloudflarestorage.com
#   R2_ACCESS_KEY  an R2 access key id
#   R2_SECRET_KEY  its secret
#   R2_BUCKETS     space separated, default "survival-data survival-audit"
#
# Lab drill:
#   R2_ENDPOINT=http://127.0.0.1:9000 R2_ACCESS_KEY=admin \
#   R2_SECRET_KEY=password123 R2_BUCKETS=prospector scripts/exit-drill.sh
set -euo pipefail
OUT="${1:-./exit-drill-$(date +%Y%m%d)}"
BUCKETS="${R2_BUCKETS:-survival-data survival-audit}"

command -v rclone >/dev/null || { echo "exit drill needs rclone (brew install rclone)" >&2; exit 2; }
: "${R2_ENDPOINT:?R2_ENDPOINT required}"
: "${R2_ACCESS_KEY:?R2_ACCESS_KEY required}"
: "${R2_SECRET_KEY:?R2_SECRET_KEY required}"

# No rclone.conf and no named remote. A drill that depends on a config file
# somebody set up once is a drill that stops working when that laptop dies.
S3=(rclone
  --s3-provider Other
  --s3-endpoint "$R2_ENDPOINT"
  --s3-access-key-id "$R2_ACCESS_KEY"
  --s3-secret-access-key "$R2_SECRET_KEY"
  --s3-region auto
  --s3-force-path-style)

mkdir -p "$OUT"
START=$(date +%s)

echo "1/3 code"
git bundle create "$OUT/survival-stack.bundle" --all

echo "2/3 data out of object storage"
for b in $BUCKETS; do
  echo "  $b"
  "${S3[@]}" sync ":s3:$b" "$OUT/$b" --transfers 16
done

echo "3/3 the control plane itself"
cp -R src wrangler.jsonc lighthouse cloud-init "$OUT/" 2>/dev/null || true

# An exit that produced nothing is not an exit. Count what actually landed.
OBJECTS=$(find "$OUT" -type f | wc -l | tr -d ' ')
[ "$OBJECTS" -gt 0 ] || { echo "EXIT DRILL RED: nothing was copied" >&2; exit 1; }
git bundle verify "$OUT/survival-stack.bundle" >/dev/null 2>&1 \
  || { echo "EXIT DRILL RED: the code bundle does not restore" >&2; exit 1; }

ELAPSED=$(( $(date +%s) - START ))
BYTES=$(du -sk "$OUT" | cut -f1)
printf '\nEXIT DRILL GREEN\n  target: %s\n  endpoint: %s\n  buckets: %s\n  files: %s\n  seconds: %s\n  kilobytes: %s\n  date: %s\n' \
  "$OUT" "$R2_ENDPOINT" "$BUCKETS" "$OBJECTS" "$ELAPSED" "$BYTES" "$(date -u +%FT%TZ)" | tee "$OUT/DRILL.txt"
