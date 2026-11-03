#!/usr/bin/env bash
# Run the whole app locally on synthetic data:
#   - api/  `npm run dev:fake`: the real API over an in-memory store,
#           seeded with invented habits, notes and articles, on 127.0.0.1:4100
#   - web/  `npm run dev`: the page on http://127.0.0.1:5173, proxying /api
# The dev login is printed by the API on start. Ctrl-C stops both.
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"

for d in api web; do
  [[ -d "${ROOT}/${d}/node_modules" ]] || (cd "${ROOT}/${d}" && npm ci)
done

# Job control gives each server its own process group, so stopping one
# stops npm and everything it started (tsx, node, vite).
set -m
PIDS=()
cleanup() {
  trap - EXIT INT TERM
  for p in "${PIDS[@]}"; do kill -TERM -- "-${p}" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

(cd "${ROOT}/api" && exec npm run dev:fake) & PIDS+=($!)
(cd "${ROOT}/web" && exec npm run dev -- --host 127.0.0.1) & PIDS+=($!)
wait
