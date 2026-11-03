# Deploying PHT

PHT runs on one small Linux server: nginx serves the static page and proxies `/api` to the Node API (managed by pm2), with MySQL on localhost. Everything in `api/ops/` is plain bash and is run from a developer machine over ssh.

## Configuration

Copy `api/ops/ops.env.example` to `api/ops/ops.env` (git-ignored) or export the variables:

| Variable | Meaning |
|---|---|
| `PHT_REMOTE` | ssh target, e.g. `deploy@pht.example.com` (required) |
| `PHT_DOMAIN` | public hostname, e.g. `pht.example.com` (required) |
| `PHT_APP_ROOT` | API directory on the server (holds `.env`, `node_modules`, `releases/`) |
| `PHT_WEB_ROOT` | web root on the server (holds `releases/` and the `current` symlink) |
| `PHT_REMOTE_BACKUP_DIR` | where the server's nightly dumps are written |

Paths inside this repository are derived from each script's own location, never from the caller's working directory. That rule exists because two earlier incidents shipped the API build into the public web root: in both, a shell `cd`'d into one project and then used a relative `./dist/` meant for the other.

## Releases

`pht-deploy-backend.sh` and `pht-deploy-frontend.sh` follow the same sequence:

1. `cd` to the package by absolute path, then assert it is the right package (`package.json` name, and `vite.config.ts` for the frontend).
2. **Branch guard** (`lib/branch-guard.sh`): refuse unless the checkout is on `main`, has no uncommitted changes, and `HEAD` equals a freshly fetched `origin/main`. There is no override flag, so every release can be traced to a pushed commit. A test asserts the guard runs before any build, copy, ssh or curl, and that no skip flag exists.
3. Build, and check the exit status.
4. **Artifact check**: the frontend bundle must be a real Vite build of this page (`lib/frontend-artifact.sh` rejects source maps, env files, backend files, an absolute API base URL, and a missing or altered Content-Security-Policy; a test breaks a build 28 different ways and expects each to be refused). The backend must look like compiled API output.
5. Upload into a new `releases/YYYYMMDD-HHMMSS/` directory. The running code is untouched until the next step.
6. Flip the `current` (frontend) or `dist` (backend) symlink with `ln -sfn` to a temp name and `mv -T` over the old one, so the switch is a single `rename(2)`.
7. Prune old releases, never the live one (`KEEP_RELEASES`, default 5).
8. Verify over HTTP: the frontend compares the bundle hash being served with the one just built; the backend restarts pm2 and requires `/api/health` to return 200.

## Rollback

```bash
api/ops/pht-rollback.sh frontend            # previous release
api/ops/pht-rollback.sh backend 20261014-0930
```

Rollback lists the releases on the server, picks the newest one older than the live one (or the named one), repoints the symlink atomically, restarts the API if needed, and checks the site and `/api/health`. No rebuild is involved.

## Backups

- `pht-backup.sh` runs nightly on the server from cron. It reads credentials from the server's `.env` into a temporary option file (never on the command line), runs `mysqldump`, and only counts the dump as good if it passes `gzip -t`, is above a size floor, contains every required table, and ends with mysqldump's completion marker. Anything else is deleted and logged as a failure, and the script exits non-zero.
- `pht-backup-pull.sh` copies dumps to another machine (`systemd/pht-backup-pull.{service,timer}`, twice daily). It deliberately does not use `rsync --delete`, so a wiped server cannot propagate the deletion to the only off-site copy.

## Tokens

- `pht-mint-token.sh` prints a five-minute admin JWT, signed on the server with the server's secret, for checking an API change by hand. The expiry is fixed; there is no flag to extend it.
- `pht-rotate-token.sh` replaces the single long-lived API token (used by non-browser clients) and prints the new value once. Only its hash is stored.

## Dropping legacy tables

The schema migration only ever adds. Tables left over from an earlier version of the app are removed by hand with `pht-drop-legacy.sql`, and only after `pht-pin-legacy-dump.sh` has copied the latest dump to a location no retention job touches and proved it is complete and recent. The drop script is idempotent and is tested against a real MySQL with the legacy schema in place, with it already gone, and run twice.

## Server setup

`nginx/pht.example.com.conf` is the site configuration (TLS, `/api` proxy to the API's port, security headers, and `root` pointing at the web root's `current` symlink).
