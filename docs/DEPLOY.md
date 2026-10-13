# Deploying this project

This is the exact sequence used to deploy to `d2c.probild.in` (systemd + nginx, no containers on that host today). Follow it in order — skipping the migration step is the most common way to end up with a server running new code against an old schema.

1. SSH to the host as the `d2c` user (not root) for everything except the migration step and service restart, which need `/etc/d2c.env` (root-only readable) and `systemctl` (root-only).
2. `cd /var/www/d2c/app && git pull origin main`
3. `npm install && npm run build` (repo root — builds the frontend into `dist/`, served directly by nginx)
4. `cd server && npm install && npm run build` (builds the backend into `server/dist/`)
5. **Migrations — do not skip:** as root, `set -a; source /etc/d2c.env; set +a; cd /var/www/d2c/app/server && npm run migrate up`. Run `npm run migrate up -- --dry-run` first if you want to review the SQL before it runs for real.
6. As root: `systemctl restart d2c-backend`
7. Verify: `curl https://d2c.probild.in/health` should return `{"status":"ok"}` (now DB-aware as of this plan's Task 6 — a 503 here means something in steps 2-6 went wrong, not that the service merely failed to start).

If this project is ever moved to a container-based host, the same five steps collapse into one `docker build && docker run` — `server/docker-entrypoint.sh` (added in this plan) runs the migration step automatically before starting the server.
