#!/usr/bin/env bash
# Run the real-MySQL suite (tests/integration/mysql.test.ts) against a throwaway
# mysql:8.4 container, then remove the container.   →  npm run test:mysql
#
# Needs Docker and the mysql:8.4 image already present (`docker pull mysql:8.4`).
# It installs nothing, binds only to 127.0.0.1 on a random port, keeps the data
# on a tmpfs, and never reads .env — the only database it can reach is its own.
set -euo pipefail

IMAGE="mysql:8.4"
NAME="pht-test-mysql-$$"
ROOT_PW="throwaway"
READY_TIMEOUT=120

cd "$(dirname "$(readlink -f "$0")")/../.."

command -v docker >/dev/null || { echo "[ABORT] docker not found" >&2; exit 1; }
docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || { echo "[ABORT] image ${IMAGE} not present — run: docker pull ${IMAGE}" >&2; exit 1; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "-- starting ${IMAGE} as ${NAME}"
docker run -d --rm --name "$NAME" \
  -e MYSQL_ROOT_PASSWORD="$ROOT_PW" \
  -p 127.0.0.1::3306 \
  --tmpfs /var/lib/mysql:rw,size=512m \
  "$IMAGE" >/dev/null

PORT="$(docker port "$NAME" 3306/tcp | head -1 | sed 's/.*://')"
[[ -n "$PORT" ]] || { echo "[ABORT] could not read the mapped port" >&2; exit 1; }

# Ready means answering over TCP: the image first runs a temporary server on a
# socket only, and a socket ping would report ready too early.
echo -n "-- waiting for MySQL on 127.0.0.1:${PORT} "
for ((i = 0; i < READY_TIMEOUT; i++)); do
  if docker exec "$NAME" mysql -h127.0.0.1 -uroot -p"$ROOT_PW" -e 'SELECT 1' >/dev/null 2>&1; then
    echo " ready (${i}s)"
    break
  fi
  if ! docker inspect "$NAME" >/dev/null 2>&1; then
    echo; echo "[ABORT] container exited during startup" >&2; exit 1
  fi
  echo -n "."
  sleep 1
done
(( i < READY_TIMEOUT )) || { echo; echo "[ABORT] MySQL not ready after ${READY_TIMEOUT}s" >&2; exit 1; }

PHT_TEST_DB_HOST=127.0.0.1 \
PHT_TEST_DB_PORT="$PORT" \
PHT_TEST_DB_USER=root \
PHT_TEST_DB_PASSWORD="$ROOT_PW" \
PHT_TEST_DB_NAME=pht_test \
  timeout 300 npx vitest run tests/integration "$@"
