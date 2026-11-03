#!/usr/bin/env bash
# Roll PHT back to the previous release (or a named one).
#
#   pht-rollback.sh [frontend|backend] [release-id]
#
# Releases are written by pht-deploy-frontend.sh / pht-deploy-backend.sh into
# <root>/releases/YYYYMMDD-HHMMSS, with a symlink naming the live one. Rolling
# back is a rename(2) over that symlink, so it is atomic and takes no rebuild.
set -euo pipefail

# shellcheck source=config.sh
source "$(dirname "$(readlink -f "$0")")/config.sh"
REMOTE="${PHT_REMOTE}"
SITE_URL="https://${PHT_DOMAIN}/"
HEALTH_URL="https://${PHT_DOMAIN}/api/health"
WEB_ROOT="${PHT_WEB_ROOT}"
APP_ROOT="${PHT_APP_ROOT}"
NGINX_CONF="${PHT_NGINX_CONF}"
PM2_APP="pht-api"

SSH=(ssh -o BatchMode=yes "$REMOTE")

die() { printf '\n[ABORT] %s\n' "$*" >&2; exit 1; }
ok()  { printf '  [ok] %s\n' "$*"; }

TARGET_SIDE="${1:-frontend}"
WANTED="${2:-}"

case "$TARGET_SIDE" in
  frontend) ROOT="$WEB_ROOT"; CURRENT="${WEB_ROOT}/current" ;;
  backend)  ROOT="$APP_ROOT"; CURRENT="${APP_ROOT}/dist" ;;
  *) die "usage: $(basename "$0") [frontend|backend] [release-id]" ;;
esac
REL_ROOT="${ROOT}/releases"

echo "== PHT ${TARGET_SIDE} rollback =="

# 1. What is live now, and what can we go back to?
LIVE="$("${SSH[@]}" "readlink '${CURRENT}' 2>/dev/null | sed 's#releases/##'" || true)"
[[ -n "$LIVE" ]] || die "${CURRENT} is not a release symlink — nothing deployed with versioning yet"
ok "currently live: ${LIVE}"

RELEASES="$("${SSH[@]}" "ls -1d '${REL_ROOT}'/*/ 2>/dev/null | sed 's#.*/releases/##; s#/\$##' | sort" || true)"
[[ -n "$RELEASES" ]] || die "no releases found under ${REL_ROOT}"

COUNT="$(printf '%s\n' "$RELEASES" | wc -l | tr -d ' ')"
echo "  available releases (${COUNT}):"
while read -r r; do
  [[ "$r" == "$LIVE" ]] && echo "    ${r}  <- live" || echo "    ${r}"
done <<< "$RELEASES"

# 2. Pick the target: the newest release older than the live one, unless named.
if [[ -n "$WANTED" ]]; then
  printf '%s\n' "$RELEASES" | grep -qx "$WANTED" || die "no such release: ${WANTED}"
  [[ "$WANTED" != "$LIVE" ]] || die "${WANTED} is already live"
  TARGET="$WANTED"
else
  TARGET="$(printf '%s\n' "$RELEASES" | awk -v live="$LIVE" '$0 < live' | tail -1)"
  [[ -n "$TARGET" ]] || die "no release older than ${LIVE} to roll back to"
fi
echo
ok "rolling back: ${LIVE} -> ${TARGET}"

# 3. Atomic repoint.
"${SSH[@]}" "set -e
  test -d '${REL_ROOT}/${TARGET}'
  ln -sfn 'releases/${TARGET}' '${CURRENT}.tmp'
  mv -Tf '${CURRENT}.tmp' '${CURRENT}'"
ok "${CURRENT} -> releases/${TARGET}"

if [[ "$TARGET_SIDE" == "frontend" ]]; then
  # Mirror to the flat root while nginx still serves it directly (see the deploy
  # script). Self-disabling once the root points at the symlink.
  if "${SSH[@]}" "grep -qE '^\s*root\s+${WEB_ROOT}/current;' '${NGINX_CONF}'" 2>/dev/null; then
    ok "nginx serves via the symlink"
  else
    "${SSH[@]}" "rsync -a --delete --exclude=releases --exclude=current \
       '${REL_ROOT}/${TARGET}/' '${WEB_ROOT}/'"
    ok "mirrored ${TARGET} to the flat root"
  fi

  EXPECTED="$("${SSH[@]}" "grep -o 'index-[A-Za-z0-9_-]*\.js' '${REL_ROOT}/${TARGET}/index.html' | head -1")"
  SERVED="$(curl -s "${SITE_URL}?cb=$$" | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1)"
  [[ "$SERVED" == "$EXPECTED" ]] || die "serving '${SERVED}', expected '${EXPECTED}'"
  ok "serving ${SERVED}"

  STATUS="$(curl -s -o /dev/null -w '%{http_code}' "${SITE_URL}")"
  [[ "$STATUS" == "200" ]] || die "site returned HTTP ${STATUS}"
  ok "${SITE_URL} -> 200"
else
  "${SSH[@]}" "cd '${APP_ROOT}' && pm2 restart ${PM2_APP} --update-env >/dev/null 2>&1"
  sleep 2
  PM2_STATUS="$("${SSH[@]}" "pm2 jlist | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const a=JSON.parse(d).find(x=>x.name===\"${PM2_APP}\");process.stdout.write(a?a.pm2_env.status:\"missing\")})'")"
  [[ "$PM2_STATUS" == "online" ]] || die "pm2 status is '${PM2_STATUS}', expected 'online'"
  ok "pm2 ${PM2_APP}: online"
  HEALTH="$(curl -s -o /dev/null -w '%{http_code}' "${HEALTH_URL}")"
  [[ "$HEALTH" == "200" ]] || die "${HEALTH_URL} returned HTTP ${HEALTH}"
  ok "${HEALTH_URL} -> 200"
fi

echo "== rolled back to ${TARGET} =="
echo "   forward again: $(basename "$0") ${TARGET_SIDE} ${LIVE}"
