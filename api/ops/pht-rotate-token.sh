#!/usr/bin/env bash
# Issue a new PHT API token, and print it to stdout exactly once.
#
# The API token is the long-lived credential for the iPhone widget and the
# server-side mail proxy (see src/lib/apiToken.ts). There is only ever one. This script
# generates a new one ON THE SERVER, stores its SHA-256 in settings
# (api_token_hash) and prints the token. The old token stops working the moment
# the hash is overwritten: rotating is the revocation, and the only one.
#
# The token is never stored anywhere by this script and cannot be recovered
# later — only its hash is kept. If the output is lost, rotate again.
#
#   Usage:  api/ops/pht-rotate-token.sh
#
# Then paste the printed token into the widget and into the mail proxy's config.
# Do NOT redirect this into a file or a log. Send it only in an
# `Authorization: Bearer` header — never in a URL, which the API logs.
#
# Reaches the server the same way pht-mint-token.sh does: ssh, then node in
# the server's API directory (PHT_APP_ROOT) with that directory's .env and node_modules. The program goes over
# stdin so no credential or SQL ever appears in a process argument list.
set -euo pipefail

# shellcheck source=config.sh
source "$(dirname "$(readlink -f "$0")")/config.sh"
REMOTE="${PHT_REMOTE}"

ssh -o BatchMode=yes "$REMOTE" "cd '${PHT_APP_ROOT}' && node -" <<'JS'
require("dotenv").config();
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const KEY = "api_token_hash";

(async () => {
  for (const k of ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"]) {
    if (!process.env[k]) throw new Error(`no ${k} in .env`);
  }
  // base64url by hand: Buffer's "base64url" encoding needs Node 15.7+.
  const token =
    "pht_" +
    crypto.randomBytes(32).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  try {
    await conn.query(
      "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [KEY, hash],
    );
    // Read it back: print the token only once the new hash is really stored.
    const [rows] = await conn.query("SELECT value FROM settings WHERE `key` = ?", [KEY]);
    if (!rows.length || rows[0].value !== hash) throw new Error("stored hash does not match");
  } finally {
    await conn.end();
  }
  process.stdout.write(token + "\n");
})().catch((err) => {
  // Message only: never the token, the hash, or connection details.
  console.error("rotate failed: " + (err && err.message ? err.message : "unknown error"));
  process.exit(1);
});
JS
