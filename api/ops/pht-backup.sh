#!/usr/bin/env bash
# Nightly PHT database backup.
# Runs on the server (cron). Paths default to the deploy user's home.
#   - credentials come from $PHT_APP_ROOT/.env (never hardcoded, never echoed)
#   - dumps to $PHT_BACKUP_DIR/pht-YYYYMMDD-HHMMSS.sql.gz
#   - prunes dumps older than 30 days
#   - appends a timestamped success/failure line to $PHT_BACKUP_DIR/backup.log
#   - exits non-zero on failure so cron surfaces the error
set -euo pipefail

ENV_FILE="${PHT_APP_ROOT:-${HOME}/pht-api}/.env"
BACKUP_DIR="${PHT_BACKUP_DIR:-${HOME}/backups/pht}"
LOG="${BACKUP_DIR}/backup.log"
RETENTION_DAYS=30
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/pht-${STAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" "$*" >>"$LOG"; }

# Any unexpected exit is a failure — record it and keep the non-zero status.
FAILED_MSG="unknown error"
SUCCEEDED=0
on_err() { log "FAILURE  ${FAILED_MSG}"; }
trap on_err ERR

# On ANY non-success exit, delete the partial dump. A truncated .gz left in the
# backup dir would otherwise look like a real backup to both the retention
# sweep and to a human restoring in a hurry.
discard_partial() {
  if (( SUCCEEDED == 0 )) && [[ -n "${OUT:-}" && -e "$OUT" ]]; then
    rm -f "$OUT"
  fi
}

if [[ ! -r "$ENV_FILE" ]]; then
  FAILED_MSG="cannot read ${ENV_FILE}"
  log "FAILURE  ${FAILED_MSG}"
  exit 1
fi

# Read credentials out of the env file WITHOUT sourcing it. Sourcing would both
# execute the file and mangle values containing `$` (ADMIN_PASSWORD_HASH is a
# bcrypt hash starting with `$2y$`, which breaks under `set -u`).
# +x guarantees no tracing can leak values.
set +x
read_env() {
  local key="$1" line
  line="$(grep -m1 -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" || true)"
  [[ -z "$line" ]] && return 0
  line="${line#*=}"
  line="${line%$'\r'}"                       # strip CR from CRLF files
  if [[ "$line" == \"*\" && ${#line} -ge 2 ]]; then
    line="${line:1:${#line}-2}"
  elif [[ "$line" == \'*\' && ${#line} -ge 2 ]]; then
    line="${line:1:${#line}-2}"
  fi
  printf '%s' "$line"
}

DB_NAME="$(read_env DB_NAME)"
DB_USER="$(read_env DB_USER)"
DB_PASSWORD="$(read_env DB_PASSWORD)"
DB_HOST="$(read_env DB_HOST)"
DB_HOST="${DB_HOST:-localhost}"

for v in DB_NAME DB_USER DB_PASSWORD; do
  if [[ -z "${!v}" ]]; then
    FAILED_MSG="${v} missing from ${ENV_FILE}"
    log "FAILURE  ${FAILED_MSG}"
    exit 1
  fi
done

# Pass credentials via a 0600 defaults-file rather than argv, so the password
# never appears in `ps` output.
CNF="$(mktemp)"
chmod 600 "$CNF"
cleanup() { rm -f "$CNF"; discard_partial; }
trap 'cleanup' EXIT
cat >"$CNF" <<EOF
[client]
user=${DB_USER}
password=${DB_PASSWORD}
host=${DB_HOST}
EOF

FAILED_MSG="mysqldump failed for database ${DB_NAME}"
# pipefail makes a mysqldump failure fail the whole pipeline.
# --no-tablespaces: the app DB user lacks the PROCESS privilege (and doesn't
# need it); without this mysqldump warns on every run.
mysqldump --defaults-extra-file="$CNF" \
  --single-transaction --quick --routines --no-tablespaces \
  "$DB_NAME" | gzip -c >"$OUT"

# A dump that exists but is truncated/corrupt is not a backup — verify it.
FAILED_MSG="gzip integrity check failed for ${OUT}"
gzip -t "$OUT"

# The size floor separates "no tables at all" from the smallest real dump.
# Measured with mysqldump 8.4: an empty database is ~460 bytes compressed; the
# rebuilt schema with only its seed rows is ~1370. The table and marker checks
# below are what actually prove completeness; the floor is a cheap first gate.
FAILED_MSG="dump looks too small (<1KB): ${OUT}"
SIZE="$(stat -c %s "$OUT")"
if (( SIZE < 1024 )); then
  log "FAILURE  ${FAILED_MSG} (${SIZE} bytes)"
  exit 1
fi

# Every table the app needs must be in the dump. Fails closed: a dump missing
# any of them is deleted (discard_partial) and the run is logged as a FAILURE.
# This list is the post-rebuild schema, so install this version of the script
# on the server only AFTER `node dist/db/migrate.js` has created those tables.
# grep without -q: -q stops reading early, gunzip dies of SIGPIPE, and pipefail
# would turn a good dump into a failure.
REQUIRED_TABLES=(settings habits checks day_notes)
for t in "${REQUIRED_TABLES[@]}"; do
  FAILED_MSG="dump has no CREATE TABLE for \`${t}\`: ${OUT}"
  if ! gunzip -c "$OUT" | grep "^CREATE TABLE \`${t}\`" >/dev/null; then
    log "FAILURE  ${FAILED_MSG}"
    exit 1
  fi
done
TABLES="$(gunzip -c "$OUT" | grep -c '^CREATE TABLE' || true)"

# mysqldump writes this as its last line only when it finished cleanly.
FAILED_MSG="dump lacks mysqldump's completion marker: ${OUT}"
if ! gunzip -c "$OUT" | tail -n 1 | grep '^-- Dump completed' >/dev/null; then
  log "FAILURE  ${FAILED_MSG}"
  exit 1
fi

chmod 600 "$OUT"

# Prune old dumps (log files are kept).
FAILED_MSG="retention prune failed"
DELETED="$(find "$BACKUP_DIR" -maxdepth 1 -name 'pht-*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l)"

trap - ERR
SUCCEEDED=1   # from here the dump is verified and must be kept
log "SUCCESS  $(basename "$OUT")  size=${SIZE}B  tables=${TABLES}  pruned=${DELETED}"
exit 0
