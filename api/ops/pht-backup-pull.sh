#!/usr/bin/env bash
# Pull PHT database dumps from the server down to this machine.
#
# Deliberately does NOT use `rsync --delete`: if the server were wiped or
# compromised, --delete would replicate that deletion and destroy the only
# off-site copy. Local retention is enforced independently below.
set -euo pipefail

# shellcheck source=config.sh
source "$(dirname "$(readlink -f "$0")")/config.sh"
REMOTE="${PHT_REMOTE}"
REMOTE_DIR="${PHT_REMOTE_BACKUP_DIR}"
LOCAL_DIR="${PHT_LOCAL_BACKUP_DIR:-${HOME}/backups/pht-server}"
LOG="${LOCAL_DIR}/pull.log"
RETENTION_DAYS=30

mkdir -p "$LOCAL_DIR"
chmod 700 "$LOCAL_DIR"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" "$*" >>"$LOG"; }

FAILED_MSG="unknown error"
trap 'log "FAILURE  ${FAILED_MSG}"' ERR

FAILED_MSG="rsync from ${REMOTE} failed (server unreachable or ssh key rejected)"
rsync -az --timeout=60 \
  -e "ssh -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new" \
  --include='pht-*.sql.gz' --include='backup.log' --exclude='*' \
  "${REMOTE}:${REMOTE_DIR}" "${LOCAL_DIR}/"

# Verify we actually hold at least one intact dump locally.
FAILED_MSG="no valid dump present locally after pull"
NEWEST="$(find "$LOCAL_DIR" -maxdepth 1 -name 'pht-*.sql.gz' -type f -printf '%T@ %p\n' \
          | sort -rn | head -1 | cut -d' ' -f2-)"
if [[ -z "$NEWEST" ]] || ! gzip -t "$NEWEST" 2>/dev/null; then
  log "FAILURE  ${FAILED_MSG}"
  exit 1
fi

# Local retention, enforced independently of the server's own pruning.
FAILED_MSG="local retention prune failed"
PRUNED="$(find "$LOCAL_DIR" -maxdepth 1 -name 'pht-*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)"
COUNT="$(find "$LOCAL_DIR" -maxdepth 1 -name 'pht-*.sql.gz' -type f | wc -l)"

trap - ERR
log "SUCCESS  newest=$(basename "$NEWEST")  local_copies=${COUNT}  pruned=${PRUNED}"
exit 0
