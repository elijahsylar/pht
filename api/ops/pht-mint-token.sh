#!/usr/bin/env bash
# Mint a short-lived admin JWT for API verification, and print it to stdout.
#
# Why this exists: verifying an API change by hand needs a full-stage token, and
# the only way to get one without the admin password is to sign it with the
# server's JWT_SECRET. Done ad hoc, that tends to end with a live bearer
# credential sitting in a file on a laptop, because cleanup is a thing you have
# to remember. The expiry here is the control, not the cleanup: five minutes,
# baked in, no flag to extend it. If a check takes longer than that, mint again.
#
# There is no revocation. PHT verifies JWTs statelessly, so a leaked token stays
# valid until it expires; the only kill switch is rotating JWT_SECRET in
# the server's .env, which logs out every session including the browser.
#
#   Usage:  TOKEN=$(api/ops/pht-mint-token.sh)
#           curl -s -H "Authorization: Bearer $TOKEN" https://pht.example.com/api/...
#
# Do NOT redirect this into a file. Keep it in a shell variable, in one command.
set -euo pipefail

# shellcheck source=config.sh
source "$(dirname "$(readlink -f "$0")")/config.sh"
REMOTE="${PHT_REMOTE}"
TTL="5m"

ssh -o BatchMode=yes "$REMOTE" "cd '${PHT_APP_ROOT}' && node -e '
require(\"dotenv\").config();
const jwt = require(\"jsonwebtoken\");
if (!process.env.JWT_SECRET) { console.error(\"no JWT_SECRET in .env\"); process.exit(1); }
process.stdout.write(jwt.sign(
  { username: process.env.ADMIN_USERNAME, stage: \"full\" },
  process.env.JWT_SECRET,
  { expiresIn: \"${TTL}\" },
));
'"
