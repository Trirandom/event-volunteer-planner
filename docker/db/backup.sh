#!/bin/sh
# Nightly pg_dump with retention. Production only.
#
# Deliberately a shell loop rather than cron: the container's whole job is this
# one task, so a scheduler inside it adds a second thing that can be
# misconfigured and a second place logs go. If the loop dies, the container
# dies, and `restart: unless-stopped` plus the absence of new files is the
# signal. A cron daemon that silently stops firing is not.
#
# This writes backups. It does not prove they restore. `docker/db/restore.sh`
# is the other half, and the release checklist rehearses it — an untested backup
# is not a backup (docs/06 §1).

set -eu

: "${EVP_BACKUP_INTERVAL_SECONDS:=86400}"
: "${EVP_BACKUP_KEEP:=14}"
: "${PGHOST:?}" "${PGUSER:?}" "${PGDATABASE:?}"

BACKUP_DIR=/backups

if [ -n "${PGPASSFILE_SOURCE:-}" ]; then
  # The secret is mounted read-only at /run/secrets; PGPASSWORD is read from it
  # once, here, rather than being passed as an environment value that would show
  # up in `docker inspect` and in the process list.
  PGPASSWORD="$(cat "$PGPASSFILE_SOURCE")"
  export PGPASSWORD
fi

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

mkdir -p "$BACKUP_DIR"

while :; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$BACKUP_DIR/evp-$stamp.dump"

  log "starting $target"
  # -Fc: the custom format, so pg_restore can do a selective or parallel
  # restore. A plain SQL dump restores only as a whole, which is the wrong
  # shape for the one case that matters — recovering a table someone emptied.
  if pg_dump -Fc -Z 6 --file="$target.partial" "$PGDATABASE"; then
    # Rename only on success, so a dump interrupted by a restart never looks
    # like a complete one. This is the line that stops the retention sweep
    # below from deleting good backups in favour of truncated ones.
    mv "$target.partial" "$target"
    log "wrote $(du -h "$target" | cut -f1) to $target"
  else
    rm -f "$target.partial"
    log "FAILED — keeping previous backups"
  fi

  # Retention, newest first. Only completed dumps are counted.
  ls -1t "$BACKUP_DIR"/evp-*.dump 2>/dev/null \
    | tail -n "+$((EVP_BACKUP_KEEP + 1))" \
    | while read -r old; do
        log "pruning $old"
        rm -f "$old"
      done

  sleep "$EVP_BACKUP_INTERVAL_SECONDS"
done
