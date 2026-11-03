#!/usr/bin/env bash
# Deploy the PHT API to the server and restart it.
#
# Counterpart to pht-deploy-frontend.sh — see the note there for why these
# scripts exist. Paths are derived from this script's own location (see
# config.sh); nothing resolves relative to the caller's cwd, so this cannot be
# aimed at the wrong project or the wrong destination.
set -euo pipefail

# shellcheck source=config.sh
source "$(dirname "$(readlink -f "$0")")/config.sh"
PROJECT_DIR="${API_DIR}"
EXPECTED_PKG_NAME="pht-api"
SRC="${PROJECT_DIR}/dist"
REMOTE="${PHT_REMOTE}"
PM2_APP="pht-api"

# Versioned releases, same shape as the frontend. pm2 runs ${PHT_APP_ROOT}/dist/index.js,
# so `dist` becomes a symlink and rollback repoints it and restarts.
APP_ROOT="${PHT_APP_ROOT}"
REL_ROOT="${APP_ROOT}/releases"
CURRENT="${APP_ROOT}/dist"
# How many releases to keep (the live one is never pruned). Override for one
# deploy, e.g. KEEP_RELEASES=6 to keep the legacy rollback target until the drop.
KEEP_RELEASES="${KEEP_RELEASES:-5}"
RELEASE="$(date +%Y%m%d-%H%M%S)"

SSH=(ssh -o BatchMode=yes "$REMOTE")

die() { printf '\n[ABORT] %s\n' "$*" >&2; exit 1; }
ok()  { printf '  [ok] %s\n' "$*"; }

[[ "$KEEP_RELEASES" =~ ^[0-9]+$ ]] && (( KEEP_RELEASES >= 2 )) || die "KEEP_RELEASES must be a whole number, at least 2 (got '${KEEP_RELEASES}')"

echo "== PHT backend deploy =="

# 1. cd by absolute path — the FIRST operation.
cd "$PROJECT_DIR" || die "cannot cd to ${PROJECT_DIR}"
ok "cwd: $(pwd)"

# 2. Assert this is actually the backend repo, before building or copying.
[[ -f package.json ]]      || die "no package.json in $(pwd) — wrong directory"
[[ -f src/index.ts ]]      || die "no src/index.ts in $(pwd) — this is not the backend repo"
PKG_NAME="$(node -p "require('$(pwd)/package.json').name" 2>/dev/null || true)"
[[ "$PKG_NAME" == "$EXPECTED_PKG_NAME" ]] \
  || die "package.json name is '${PKG_NAME}', expected '${EXPECTED_PKG_NAME}'"
ok "repo verified: ${PKG_NAME}"

# 3. Branch guard: main, clean, and identical to origin/main. No override.
# shellcheck source=lib/branch-guard.sh
source "$(dirname "$(readlink -f "$0")")/lib/branch-guard.sh"
require_deployable_main "$PROJECT_DIR" || die "branch guard refused — nothing was built or uploaded"
ok "on main, clean, HEAD = origin/main ($(git rev-parse --short HEAD))"

# 4. Build. (tsc exit status matters — do not pipe it.)
echo "-- building --"
npm run build
ok "build completed"

# 5. Refuse unless the artifact actually looks like a compiled API.
[[ -d "$SRC" ]]            || die "missing build output: ${SRC}"
[[ -f "${SRC}/index.js" ]] || die "${SRC}/index.js not found — not a backend build"
[[ -d "${SRC}/routes" ]]   || die "${SRC}/routes not found — not a backend build"
# Cross-contamination guard: index.html only exists in a FRONTEND build.
[[ -e "${SRC}/index.html" ]] && die "${SRC}/index.html exists — this looks like a FRONTEND build, refusing to deploy it as the API"
# The API reads secrets from the server's own .env; never ship one.
if find "$SRC" -name '.env*' -print -quit | grep -q .; then
  die "an .env file is present under ${SRC} — refusing to deploy"
fi
ok "artifact verified: index.js + routes/, no index.html, no .env"

# 6. Upload into a NEW release directory — the running code is untouched until
#    the symlink flips, so a partial upload can't be half-imported on restart.
echo "-- syncing --"
"${SSH[@]}" "mkdir -p '${REL_ROOT}/${RELEASE}'"
rsync -az --delete -e "ssh -o BatchMode=yes" "${SRC}/" "${REMOTE}:${REL_ROOT}/${RELEASE}/"
ok "uploaded release ${RELEASE}"

# 7. Point dist at the new release. On the very first versioned deploy dist is
#    still a real directory; replace it (its contents are already in a release).
"${SSH[@]}" "set -e
  if [ -d '${CURRENT}' ] && [ ! -L '${CURRENT}' ]; then
    rm -rf '${CURRENT}.old' && mv '${CURRENT}' '${CURRENT}.old'
  fi
  ln -sfn 'releases/${RELEASE}' '${CURRENT}.tmp'
  mv -Tf '${CURRENT}.tmp' '${CURRENT}'"
ok "dist -> releases/${RELEASE}"

# 8. Prune old releases, never touching the one in use.
"${SSH[@]}" "set -e
  cd '${REL_ROOT}'
  live=\$(basename \"\$(readlink -f '${CURRENT}')\")
  ls -1d */ 2>/dev/null | sed 's#/\$##' | sort | head -n -${KEEP_RELEASES} | while read -r old; do
    [ \"\$old\" = \"\$live\" ] && continue
    rm -rf -- \"\$old\"
    echo \"  pruned \$old\"
  done"
KEPT="$("${SSH[@]}" "ls -1d '${REL_ROOT}'/*/ 2>/dev/null | wc -l")"
ok "releases kept: ${KEPT} (limit ${KEEP_RELEASES})"

# 9. Restart and verify the service is actually healthy.
echo "-- restarting --"
ssh -o BatchMode=yes "$REMOTE" "cd '${APP_ROOT}' && pm2 restart ${PM2_APP} --update-env >/dev/null 2>&1"
sleep 2
PM2_STATUS="$(ssh -o BatchMode=yes "$REMOTE" "pm2 jlist | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const a=JSON.parse(d).find(x=>x.name===\"${PM2_APP}\");process.stdout.write(a?a.pm2_env.status:\"missing\")})'")"
[[ "$PM2_STATUS" == "online" ]] || die "pm2 status is '${PM2_STATUS}', expected 'online'"
ok "pm2 ${PM2_APP}: online"

HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "https://${PHT_DOMAIN}/api/health")"
[[ "$HEALTH" == "200" ]] || die "/api/health returned HTTP ${HEALTH}"
ok "https://${PHT_DOMAIN}/api/health -> 200"

echo "== backend deploy OK (release ${RELEASE}) =="
