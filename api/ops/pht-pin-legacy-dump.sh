#!/usr/bin/env bash
# Pin and verify the last dump of the legacy PHT database, on the LAPTOP.
#
# This is the gate in front of ops/pht-drop-legacy.sql. It copies the newest
# dump from the pull directory into a folder that no retention job touches, and
# then proves that copy is a real, complete, recent backup of the tables about
# to be dropped. It fails closed: any doubt is a non-zero exit and the word
# ABORT, and the drop must not be run.
#
#   Usage:  pht-backup-pull.sh && ops/pht-pin-legacy-dump.sh
#
# It never connects anywhere and never deletes: it only reads the pull
# directory and adds files to the pin directory. Pull first so the newest dump
# really is new — a dump older than MAX_AGE_HOURS is refused.
set -euo pipefail

SRC_DIR="${PHT_DUMP_SRC:-${HOME}/backups/pht-server}"
PIN_DIR="${PHT_PIN_DIR:-${HOME}/backups/pht-legacy-final}"
MAX_AGE_HOURS="${PHT_PIN_MAX_AGE_HOURS:-26}"
# The legacy dump was ~8KB compressed in October 2026. Half that means tables
# or rows are missing.
MIN_BYTES=4096
LEGACY_TABLES=(protocols entries journal_entries gratitude_entries coach_conversations settings)
# Tables that hold the history worth keeping; an empty one means a bad dump.
MUST_HAVE_ROWS=(protocols entries settings)

abort() { printf '\n[ABORT] %s\nDo NOT run pht-drop-legacy.sql.\n' "$*" >&2; exit 1; }
ok()    { printf '  [ok] %s\n' "$*"; }

echo "== pin legacy PHT dump =="

[[ -d "$SRC_DIR" ]] || abort "no pull directory at ${SRC_DIR}"
NEWEST="$(find "$SRC_DIR" -maxdepth 1 -name 'pht-*.sql.gz' -type f -printf '%T@ %p\n' \
  | sort -n | tail -1 | cut -d' ' -f2-)"
[[ -n "$NEWEST" && -f "$NEWEST" ]] || abort "no pht-*.sql.gz dump found in ${SRC_DIR}"
ok "newest dump: $(basename "$NEWEST")"

AGE_S=$(( $(date +%s) - $(stat -c %Y "$NEWEST") ))
(( AGE_S >= 0 && AGE_S <= MAX_AGE_HOURS * 3600 )) \
  || abort "newest dump is $(( AGE_S / 3600 ))h old (limit ${MAX_AGE_HOURS}h) — take a fresh dump on the server and run pht-backup-pull.sh first"
ok "age: $(( AGE_S / 3600 ))h $(( AGE_S % 3600 / 60 ))m"

mkdir -p "$PIN_DIR"
chmod 700 "$PIN_DIR"
BASE="$(basename "$NEWEST")"
PINNED="${PIN_DIR}/${BASE}"
cp -p -- "$NEWEST" "$PINNED" || abort "copy into ${PIN_DIR} failed"
chmod 600 "$PINNED"
cmp -s -- "$NEWEST" "$PINNED" || abort "pinned copy differs from the source"
ok "pinned: ${PINNED}"

# Everything below checks the PINNED copy — the file that will be relied on.
gunzip -t -- "$PINNED" 2>/dev/null || abort "gunzip -t failed: ${PINNED} is truncated or corrupt"
ok "gunzip -t"

SIZE="$(stat -c %s "$PINNED")"
(( SIZE >= MIN_BYTES )) || abort "dump is ${SIZE} bytes, under the ${MIN_BYTES}-byte floor"
ok "size: ${SIZE} bytes"

# grep without -q throughout: -q exits at the first match, gunzip then dies of
# SIGPIPE on a large dump, and pipefail would turn a good dump into an ABORT.
for t in "${LEGACY_TABLES[@]}"; do
  gunzip -c -- "$PINNED" | grep "^CREATE TABLE \`${t}\`" >/dev/null \
    || abort "dump has no CREATE TABLE for \`${t}\`"
done
ok "all ${#LEGACY_TABLES[@]} table definitions present"

for t in "${MUST_HAVE_ROWS[@]}"; do
  gunzip -c -- "$PINNED" | grep "^INSERT INTO \`${t}\`" >/dev/null \
    || abort "dump has no rows for \`${t}\`"
done
ok "rows present for: ${MUST_HAVE_ROWS[*]}"

# mysqldump writes this as its last line only when it finished cleanly.
gunzip -c -- "$PINNED" | tail -n 1 | grep '^-- Dump completed' >/dev/null \
  || abort "dump does not end with mysqldump's completion marker"
ok "completion marker"

( cd "$PIN_DIR" && sha256sum -- "$BASE" > "${BASE}.sha256" && sha256sum -c --quiet -- "${BASE}.sha256" ) \
  || abort "could not write or verify the checksum"
chmod 600 "${PINNED}.sha256"
ok "sha256 written: ${BASE}.sha256"

echo "== dump pinned and verified =="
echo "Safe to run ops/pht-drop-legacy.sql against the server database."
