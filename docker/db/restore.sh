#!/bin/sh
# The other half of backup.sh. Run it deliberately, from the host:
#
#   docker compose -f compose.yaml -f compose.prod.yaml run --rm \
#     -v evp-backups:/backups --entrypoint /bin/sh backup /opt/restore.sh evp-20260911T030000Z.dump
#
# It exists so that the restore path is rehearsed rather than improvised at the
# worst possible moment. The release checklist runs it against a scratch
# database; that rehearsal is the only thing that makes the backups above
# meaningful.

set -eu

DUMP="${1:?usage: restore.sh <file-in-/backups> [target-database]}"
TARGET="${2:-evp_restore_check}"
BACKUP_DIR=/backups

: "${PGHOST:?}" "${PGUSER:?}"

if [ -n "${PGPASSFILE_SOURCE:-}" ]; then
  PGPASSWORD="$(cat "$PGPASSFILE_SOURCE")"
  export PGPASSWORD
fi

if [ ! -r "$BACKUP_DIR/$DUMP" ]; then
  echo "restore: $BACKUP_DIR/$DUMP not found. Available:" >&2
  ls -1t "$BACKUP_DIR" >&2
  exit 1
fi

# Refusing to restore over the live database is the point. A restore that can
# overwrite production with one mistyped argument is a bigger risk than the
# outage it is meant to fix; recovering for real means renaming databases
# afterwards, deliberately, with the application stopped.
if [ "$TARGET" = "evp" ]; then
  echo "restore: refusing to restore directly over 'evp'." >&2
  echo "         Restore to a scratch database, verify it, then swap." >&2
  exit 2
fi

echo "restore: (re)creating $TARGET"
psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$TARGET\";"
psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET\" OWNER evp_migrator;"

echo "restore: loading $DUMP"
pg_restore --dbname="$TARGET" --no-owner --role=evp_migrator --exit-on-error \
           --jobs="${EVP_RESTORE_JOBS:-2}" "$BACKUP_DIR/$DUMP"

echo "restore: done. Sanity check:"
psql -d "$TARGET" -c "SELECT count(*) AS organizations FROM organizations;" \
     -c "SELECT count(*) AS assignments FROM assignments;"
