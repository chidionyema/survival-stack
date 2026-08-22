#!/bin/bash
# Two modes and nothing else. The control plane only ever says restore or backup.
#   restore — run once, before the engine starts. Exits 0 or the box never serves.
#   backup  — run forever, streaming the WAL to R2.
set -euo pipefail

MODE="${1:-${MODE:-backup}}"
DB="${DB_DATA_PATH:-/data}/app.db"
REPLICA="s3://${R2_BUCKET:?R2_BUCKET required}/sqlite"

export LITESTREAM_ACCESS_KEY_ID="${R2_ACCESS_KEY:?R2_ACCESS_KEY required}"
export LITESTREAM_SECRET_ACCESS_KEY="${R2_SECRET_KEY:?R2_SECRET_KEY required}"

cat > /etc/litestream.yml <<YML
dbs:
  - path: ${DB}
    replicas:
      - url: ${REPLICA}
        endpoint: ${R2_ENDPOINT:?R2_ENDPOINT required}
        region: auto
        retention: 720h
        snapshot-interval: 1h
YML

case "$MODE" in
  restore)
    if [ -f "$DB" ]; then
      echo "restore: a database is already present, leaving it alone"
    else
      echo "restore: fetching the latest replica from ${REPLICA}"
      # -if-replica-exists so a genuinely first boot is not a failure.
      litestream restore -config /etc/litestream.yml -if-replica-exists "$DB"
    fi
    if [ -f "$DB" ]; then
      # A restore that produces a corrupt file must halt the cold start, not
      # hand a broken database to the engine.
      RESULT=$(sqlite3 "$DB" 'PRAGMA integrity_check;')
      if [ "$RESULT" != "ok" ]; then
        echo "restore: FAILED integrity check: $RESULT" >&2
        exit 1
      fi
      echo "restore: integrity check ok"
    else
      echo "restore: no replica yet — this is a first boot"
    fi
    ;;
  backup)
    echo "backup: replicating ${DB} to ${REPLICA}"
    exec litestream replicate -config /etc/litestream.yml
    ;;
  *)
    echo "unknown mode: $MODE (expected restore or backup)" >&2
    exit 2
    ;;
esac
