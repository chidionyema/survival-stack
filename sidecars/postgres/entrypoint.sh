#!/bin/bash
# Same two modes as the sqlite sidecar. The control plane cannot tell them apart,
# which is the point: switching database is four lines in wrangler.jsonc.
set -euo pipefail

MODE="${1:-${MODE:-backup}}"
export PGDATA="${DB_DATA_PATH:-/var/lib/postgresql/data}"
export WALG_S3_PREFIX="s3://${R2_BUCKET:?R2_BUCKET required}/postgres"
export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY:?R2_ACCESS_KEY required}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_KEY:?R2_SECRET_KEY required}"
export AWS_ENDPOINT="${R2_ENDPOINT:?R2_ENDPOINT required}"
export AWS_S3_FORCE_PATH_STYLE=true
export AWS_REGION=auto

case "$MODE" in
  restore)
    if [ -s "${PGDATA}/PG_VERSION" ]; then
      echo "restore: a cluster is already present, leaving it alone"
      exit 0
    fi
    if ! wal-g backup-list >/dev/null 2>&1 || [ -z "$(wal-g backup-list 2>/dev/null | tail -n +2)" ]; then
      echo "restore: no base backup yet — this is a first boot"
      exit 0
    fi
    echo "restore: fetching the latest base backup"
    wal-g backup-fetch "$PGDATA" LATEST
    cat > "${PGDATA}/postgresql.auto.conf" <<CONF
restore_command = 'wal-g wal-fetch "%f" "%p"'
CONF
    touch "${PGDATA}/recovery.signal"
    echo "restore: base backup in place, recovery armed"
    ;;
  backup)
    echo "backup: base backup every ${BACKUP_INTERVAL:-3600}s, WAL archived continuously"
    while true; do
      wal-g backup-push "$PGDATA" || echo "backup: push failed, retrying next interval" >&2
      sleep "${BACKUP_INTERVAL:-3600}"
    done
    ;;
  *)
    echo "unknown mode: $MODE (expected restore or backup)" >&2
    exit 2
    ;;
esac
