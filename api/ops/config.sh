# Shared deploy settings, sourced by the ops scripts.
#
# Everything host-specific comes from the environment or from ops/ops.env
# (git-ignored; copy ops/ops.env.example). Paths inside this repository are
# derived from this file's own location, never from the caller's cwd, so a
# script cannot bind to the wrong project by being run from the wrong place.
# shellcheck shell=bash

OPS_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
API_DIR="$(dirname "$OPS_DIR")"
REPO_ROOT="$(dirname "$API_DIR")"
WEB_DIR="${REPO_ROOT}/web"

# shellcheck source=/dev/null
[[ -f "${OPS_DIR}/ops.env" ]] && source "${OPS_DIR}/ops.env"

: "${PHT_REMOTE:?set PHT_REMOTE to the ssh target, e.g. deploy@pht.example.com}"
: "${PHT_DOMAIN:?set PHT_DOMAIN to the public hostname, e.g. pht.example.com}"
# Absolute path of the API checkout on the server (holds .env, node_modules, releases/).
PHT_APP_ROOT="${PHT_APP_ROOT:-/srv/pht/api}"
# Web root for the static frontend (holds releases/ and the current symlink).
PHT_WEB_ROOT="${PHT_WEB_ROOT:-/var/www/pht}"
# Directory on the server where pht-backup.sh writes its dumps.
PHT_REMOTE_BACKUP_DIR="${PHT_REMOTE_BACKUP_DIR:-/srv/pht/backups/}"
PHT_NGINX_CONF="${PHT_NGINX_CONF:-/etc/nginx/sites-available/${PHT_DOMAIN}}"
