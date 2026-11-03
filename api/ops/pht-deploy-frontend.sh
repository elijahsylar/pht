#!/usr/bin/env bash
# Deploy the PHT frontend to the server's web root.
#
# Exists because two separate incidents shipped the BACKEND build into the
# public web root. Both had the same shape: a single shell invocation that
# `cd`s into one project and then uses a relative `./dist/` meant for the
# other. The destination was right; the SOURCE silently bound to the wrong
# cwd. "Remember to use absolute paths" failed twice, so the paths are now
# derived from this script's own location (config.sh) and every assumption is
# asserted rather than trusted.
set -euo pipefail

# shellcheck source=config.sh
source "$(dirname "$(readlink -f "$0")")/config.sh"
PROJECT_DIR="${WEB_DIR}"
EXPECTED_PKG_NAME="personal-habit-tracker"
SRC="${PROJECT_DIR}/dist"
REMOTE="${PHT_REMOTE}"
SITE_URL="https://${PHT_DOMAIN}/"

# Versioned releases. /var/www is root-owned, so the releases tree and the
# symlink both live INSIDE a deploy-user-owned web root — see WEB_ROOT below.
WEB_ROOT="${PHT_WEB_ROOT}"
REL_ROOT="${WEB_ROOT}/releases"
CURRENT="${WEB_ROOT}/current"
# How many releases to keep (the live one is never pruned). Override for one
# deploy, e.g. KEEP_RELEASES=6 to keep an older rollback target a while longer.
KEEP_RELEASES="${KEEP_RELEASES:-5}"
NGINX_CONF="${PHT_NGINX_CONF}"
RELEASE="$(date +%Y%m%d-%H%M%S)"

SSH=(ssh -o BatchMode=yes "$REMOTE")

die() { printf '\n[ABORT] %s\n' "$*" >&2; exit 1; }
ok()  { printf '  [ok] %s\n' "$*"; }

[[ "$KEEP_RELEASES" =~ ^[0-9]+$ ]] && (( KEEP_RELEASES >= 2 )) || die "KEEP_RELEASES must be a whole number, at least 2 (got '${KEEP_RELEASES}')"

echo "== PHT frontend deploy =="

# 1. cd by absolute path — the FIRST operation, before anything can run relative.
cd "$PROJECT_DIR" || die "cannot cd to ${PROJECT_DIR}"
ok "cwd: $(pwd)"

# 2. Assert this is actually the frontend repo, before building or copying.
[[ -f package.json ]]     || die "no package.json in $(pwd) — wrong directory"
[[ -f vite.config.ts ]]   || die "no vite.config.ts in $(pwd) — this is not the frontend repo"
PKG_NAME="$(node -p "require('$(pwd)/package.json').name" 2>/dev/null || true)"
[[ "$PKG_NAME" == "$EXPECTED_PKG_NAME" ]] \
  || die "package.json name is '${PKG_NAME}', expected '${EXPECTED_PKG_NAME}'"
ok "repo verified: ${PKG_NAME}"

# 3. Branch guard: main, clean, and identical to origin/main. No override.
# shellcheck source=lib/branch-guard.sh
source "$(dirname "$(readlink -f "$0")")/lib/branch-guard.sh"
require_deployable_main "$PROJECT_DIR" || die "branch guard refused — nothing was built or uploaded"
ok "on main, clean, HEAD = origin/main ($(git rev-parse --short HEAD))"

# 4. Build. The page always calls same-origin /api (there is no base-URL
#    setting any more); step 5 refuses a bundle with an absolute API URL in it.
echo "-- building --"
npm run build
ok "build completed"

# 5. Refuse unless the artifact is a build of the 98.css page: one entry
#    bundle, the CSP meta first in <head>, no inline script or style, no
#    absolute API URL, 98.css and its licences, the manifest and icons, no
#    source maps, no backend files, no .env, no React.
# shellcheck source=lib/frontend-artifact.sh
source "$(dirname "$(readlink -f "$0")")/lib/frontend-artifact.sh"
verify_frontend_artifact "$SRC" || die "the build in ${SRC} failed its checks — nothing was uploaded"
ok "artifact verified: entry bundle, CSP meta, same-origin API, 98.css + licences, manifest + icons, no maps/.env/backend/React"

# 6. Upload into a NEW release directory. Nothing being served is touched yet,
#    so a failed or partial upload cannot take the site down.
echo "-- syncing --"
"${SSH[@]}" "mkdir -p '${REL_ROOT}/${RELEASE}'"
rsync -az --delete -e "ssh -o BatchMode=yes" "${SRC}/" "${REMOTE}:${REL_ROOT}/${RELEASE}/"
ok "uploaded release ${RELEASE}"

# 7. Flip the symlink. `ln -sfn` deletes and recreates, leaving a window where
#    the path doesn't exist; creating a temp link and rename(2)-ing it over the
#    old one is atomic, so a request either sees the old release or the new one.
"${SSH[@]}" "set -e
  ln -sfn 'releases/${RELEASE}' '${CURRENT}.tmp'
  mv -Tf '${CURRENT}.tmp' '${CURRENT}'"
ok "current -> releases/${RELEASE}"

# 8. Compatibility shim. If nginx still has `root <web root>` rather than
#    `root <web root>/current` (a one-line, sudo change), then
#    mirror the release into the flat root so the site serves this build and so
#    rollback still changes what users get. Detected, so it disables itself.
if "${SSH[@]}" "grep -qE '^\s*root\s+${WEB_ROOT}/current;' '${NGINX_CONF}'" 2>/dev/null; then
  ok "nginx root is ${WEB_ROOT}/current — serving via symlink, no shim needed"
else
  "${SSH[@]}" "rsync -a --delete --exclude=releases --exclude=current \
     '${REL_ROOT}/${RELEASE}/' '${WEB_ROOT}/'"
  ok "mirrored to flat root (nginx root is still ${WEB_ROOT} — see NOTE below)"
fi

# 9. Prune old releases, never touching the one in use.
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

# 10. Verify what is actually being SERVED over HTTP — not just what is on disk.
LOCAL_HASH="$(grep -o 'index-[A-Za-z0-9_-]*\.js' "${SRC}/index.html" | head -1)"
SERVED_HASH="$(curl -s "${SITE_URL}?cb=$$" | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1)"
[[ -n "$LOCAL_HASH" && "$LOCAL_HASH" == "$SERVED_HASH" ]] \
  || die "served bundle '${SERVED_HASH}' != built bundle '${LOCAL_HASH}'"
ok "serving ${SERVED_HASH}"

STATUS="$(curl -s -o /dev/null -w '%{http_code}' "${SITE_URL}")"
[[ "$STATUS" == "200" ]] || die "site returned HTTP ${STATUS}"
ok "${SITE_URL} -> 200"

echo "== frontend deploy OK (release ${RELEASE}) =="
if ! "${SSH[@]}" "grep -qE '^\s*root\s+${WEB_ROOT}/current;' '${NGINX_CONF}'" 2>/dev/null; then
  echo
  echo "NOTE: nginx still serves ${WEB_ROOT} directly. To serve through the"
  echo "      symlink (needed for instant rollback), run once on the server:"
  echo "        sudo sed -i 's#root ${WEB_ROOT};#root ${WEB_ROOT}/current;#' ${NGINX_CONF} \\"
  echo "          && sudo nginx -t && sudo systemctl reload nginx"
fi
