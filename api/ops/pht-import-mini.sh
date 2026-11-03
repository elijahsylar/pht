#!/usr/bin/env bash
# Import the iPhone Scriptable widget's log into PHT, and print the report.
#
#   Usage:  ops/pht-import-mini.sh <file.json>
#
# The file is the widget's own log shape:
#
#   { "log": { "2026-07-01": ["stretch", "read"], "2026-07-02": ["stretch"] } }
#
# POST /api/import/mini-pht is JWT-only (the API token cannot import), so this
# mints a five-minute admin JWT with pht-mint-token.sh, keeps it in a shell
# variable, and sends it on curl's stdin — never in argv, never in a file.
#
# Safe to re-run: the import is additive and idempotent. A second run reports
# everything as alreadyPresent and inserts nothing. Slugs that match no habit
# are ignored and listed under unknownSlugs.
set -euo pipefail

# shellcheck source=config.sh
source "$(dirname "$(readlink -f "$0")")/config.sh"
API="https://${PHT_DOMAIN}/api/import/mini-pht"
HERE="$(dirname "$(readlink -f "$0")")"
MINT="${HERE}/pht-mint-token.sh"

die() { printf '[ABORT] %s\n' "$*" >&2; exit 1; }

[[ $# -eq 1 ]] || die "usage: $(basename "$0") <file.json>"
FILE="$1"
[[ -f "$FILE" && -r "$FILE" ]] || die "cannot read ${FILE}"
[[ -x "$MINT" ]] || die "pht-mint-token.sh not found next to this script (${MINT})"

# Catch a malformed file here, before minting a credential for nothing.
node -e '
const fs = require("fs");
let body;
try { body = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
catch (e) { console.error("not valid JSON: " + e.message); process.exit(1); }
const log = body && body.log;
if (!log || typeof log !== "object" || Array.isArray(log)) {
  console.error("expected { \"log\": { \"YYYY-MM-DD\": [slug, ...] } }"); process.exit(1);
}
const days = Object.keys(log);
const checks = days.reduce((n, d) => n + (Array.isArray(log[d]) ? log[d].length : 0), 0);
console.error(`sending ${days.length} days, ${checks} checks`);
' "$FILE" || die "refusing to send ${FILE}"

TOKEN="$("$MINT")" || die "could not mint a token"
[[ -n "$TOKEN" ]] || die "mint returned an empty token"

# -H @- reads the header from stdin, keeping the token out of `ps`. The status
# code is appended on its own last line so body and code arrive in one capture.
RESP="$(curl -sS -X POST "$API" \
  -H 'Content-Type: application/json' -H @- \
  --data-binary "@${FILE}" -w '\n%{http_code}' <<<"Authorization: Bearer ${TOKEN}")" \
  || die "request failed"
unset TOKEN

CODE="${RESP##*$'\n'}"
BODY="${RESP%$'\n'*}"
printf '%s\n' "$BODY"
[[ "$CODE" == "200" ]] || die "import returned HTTP ${CODE}"
