# Deploying this project

This is the exact sequence used to deploy to `d2c.probild.in` (systemd + nginx, no containers on that host today). Follow it in order — skipping the migration step is the most common way to end up with a server running new code against an old schema.

**`/etc/d2c.env` must set `NODE_ENV=production`.** This is what turns on every production-only behavior this project relies on: the `CORS_ORIGIN` startup guard described below, the crash-exit behavior on a fatal error, and pino's JSON (rather than pretty-printed) log output. Without it, the server will happily boot in a dev-like mode in production.

**`/etc/d2c.env` must also set `CORS_ORIGIN`** (a comma-separated list of allowed origins) once `NODE_ENV=production` is set — the server refuses to start at all otherwise. On a first deploy of this branch, leaving either of these two variables unset will crash-loop at step 6 below, and the step 7 health check will see a 502 from nginx (the service is down) rather than the documented 503 (the service is up but the DB is unreachable).

1. SSH to the host as the `d2c` user (not root) for everything except the migration step and service restart, which need `/etc/d2c.env` (root-only readable) and `systemctl` (root-only).
2. `cd /var/www/d2c/app && git pull origin main`
3. `npm install && npm run build` (repo root — builds the frontend into `dist/`, served directly by nginx)
4. `cd server && npm install && npm run build` (builds the backend into `server/dist/`)
5. **Migrations — do not skip:** as root, `set -a; source /etc/d2c.env; set +a; cd /var/www/d2c/app/server && npm run migrate up`. Run `npm run migrate up -- --dry-run` first if you want to review the SQL before it runs for real.
6. As root: `systemctl restart d2c-backend`
7. Verify: `curl https://d2c.probild.in/health` should return `{"status":"ok"}` (now DB-aware as of this plan's Task 6 — a 503 here means something in steps 2-6 went wrong, not that the service merely failed to start).

If this project is ever moved to a container-based host, the same seven steps collapse into one `docker build && docker run` — `server/docker-entrypoint.sh` (added in this plan) runs the migration step automatically before starting the server, and `server/Dockerfile`'s final stage installs `node-pg-migrate` as a real (non-dev) dependency so that migration step actually has a binary to run.
