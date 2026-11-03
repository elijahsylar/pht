#!/usr/bin/env bash
# Build the page and drive it in headless Chrome against pht-api's in-memory
# dev server, then run the snap-grid checks in Chrome and Firefox.
#   →  npm run ui:check          (UI_BROWSER=firefox: the walkthrough in
#                                  Firefox too → npm run ui:check:firefox)
#
#   1. vite build (the page always calls same-origin /api),
#   2. pht-api `dev:fake` on 127.0.0.1:4199 (fresh data every run),
#   3. vite preview on 127.0.0.1:4198, proxying /api to it (the built page,
#      with its CSP), and the vite dev server on 127.0.0.1:4197 (the
#      `npm run dev` + `dev:fake` pairing),
#   4. node dev/ui_check.mjs, which saves screenshots to dev/screenshots/,
#   5. node dev/grid_check.mjs (the snap grid: moves, swaps, resizes,
#      presets, restore paths, keys, window contents; both browsers, at 100%
#      and 120%).
#
# Needs /usr/bin/google-chrome, Node 20+ for playwright-core (found in nvm
# when `node` is older), Playwright's Firefox build (`npx playwright-core
# install firefox` under that Node, into ~/.cache/ms-playwright), and
# ../api with its node_modules (override with PHT_API_DIR). The
# servers are stopped on exit.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."
API_DIR="${PHT_API_DIR:-$(pwd)/../api}"
API_PORT=4199
WEB_PORT=4198
DEV_PORT=4197
SHOTS="dev/screenshots"
LOGS="$(mktemp -d)"

[[ -f "${API_DIR}/dev/fakeServer.ts" ]] || { echo "[ABORT] no dev/fakeServer.ts in ${API_DIR}" >&2; exit 1; }
[[ -x /usr/bin/google-chrome ]] || { echo "[ABORT] /usr/bin/google-chrome not found" >&2; exit 1; }

# playwright-core 1.64 needs Node 20+; the servers run on whatever `node` is.
# Use PHT_UI_NODE, else `node` if it is new enough, else the newest nvm one.
UI_NODE="${PHT_UI_NODE:-node}"
if (( $("$UI_NODE" -p 'process.versions.node.split(".")[0]') < 20 )); then
  UI_NODE="$(ls -d "${HOME}"/.nvm/versions/node/v2[0-9]*/bin/node 2>/dev/null | sort -V | tail -1)"
  [[ -x "$UI_NODE" ]] || { echo "[ABORT] the UI checks need Node 20+ (set PHT_UI_NODE)" >&2; exit 1; }
fi
echo "-- UI checks on Node $("$UI_NODE" --version)"

PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill -TERM -- "-${p}" 2>/dev/null || true; done
  rm -rf "$LOGS"
}
trap cleanup EXIT

echo "-- build"
npm run --silent build >"${LOGS}/build.log" 2>&1 || { cat "${LOGS}/build.log"; exit 1; }

echo "-- pht-api dev:fake on :${API_PORT}"
setsid bash -c "cd '${API_DIR}' && NODE_ENV=development PORT=${API_PORT} exec ./node_modules/.bin/tsx dev/fakeServer.ts" \
  >"${LOGS}/api.log" 2>&1 &
PIDS+=($!)

echo "-- vite preview on :${WEB_PORT}"
setsid bash -c "PHT_API_PORT=${API_PORT} exec ./node_modules/.bin/vite preview --port ${WEB_PORT} --strictPort" \
  >"${LOGS}/web.log" 2>&1 &
PIDS+=($!)

echo "-- vite dev on :${DEV_PORT}"
setsid bash -c "PHT_API_PORT=${API_PORT} exec ./node_modules/.bin/vite --port ${DEV_PORT} --strictPort" \
  >"${LOGS}/dev.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:${WEB_PORT}/" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:${DEV_PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null \
  || { echo "[ABORT] servers did not come up"; cat "${LOGS}/api.log" "${LOGS}/web.log"; exit 1; }

mkdir -p "$SHOTS"
status=0
PHT_API_DIR="$API_DIR" PHT_API_URL="http://127.0.0.1:${API_PORT}/api" \
  timeout 540 "$UI_NODE" dev/ui_check.mjs "http://127.0.0.1:${WEB_PORT}" "$SHOTS" "http://127.0.0.1:${DEV_PORT}" || status=1
echo
echo "-- snap-grid checks (Chrome and Firefox)"
PHT_API_DIR="$API_DIR" timeout 540 "$UI_NODE" dev/grid_check.mjs "http://127.0.0.1:${WEB_PORT}" "$SHOTS" || status=1
exit "$status"
