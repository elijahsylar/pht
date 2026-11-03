#!/usr/bin/env bash
# Run every test that needs no extra services: API unit + route tests,
# then the web unit tests. The real-MySQL suite (Docker) and the browser
# walkthrough are separate: `npm run test:mysql` in api/, `npm run ui:check` in web/.
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
for d in api web; do
  [[ -d "${ROOT}/${d}/node_modules" ]] || (cd "${ROOT}/${d}" && npm ci)
done
(cd "${ROOT}/api" && npm test)
(cd "${ROOT}/web" && npm test)
