import crypto from "node:crypto";
import cron from "node-cron";
import pool from "./db.js";
import { connectors } from "./lib/connector-registry.js";
import { logger } from "./lib/logger.js";

// Postgres advisory locks take a bigint key. Hash the platform name down to a stable
// 32-bit int (advisory locks accept a single bigint or two ints — one int is enough
// here, collisions across our ~5 platform names are not a practical concern).
export function hashPlatformToLockKey(platform: string): number {
  const hash = crypto.createHash("sha256").update(platform).digest();
  return hash.readInt32BE(0);
}

export async function runScheduledSyncs(platform: string) {
  const connector = connectors[platform];
  if (!connector) return;

  const lockKey = hashPlatformToLockKey(platform);
  const lockClient = await pool.connect();
  let acquired = false;
  try {
    const { rows } = await lockClient.query("select pg_try_advisory_lock($1) as acquired", [lockKey]);
    acquired = rows[0].acquired;
    if (!acquired) {
      // Another process (or an overlapping run somehow) already holds this platform's
      // lock — skip this tick entirely rather than wait; the next scheduled tick will
      // try again.
      return;
    }

    // 'error' connections are included so a transient failure (e.g. a brief Shopify
    // outage) self-heals on the next hourly run instead of requiring a human to
    // trigger a manual sync — each connection's own try/catch below still isolates
    // a connection that's genuinely still broken from affecting its neighbors.
    const result = await pool.query(
      "select id from platform_connections where platform = $1 and status in ('connected', 'error')",
      [platform],
    );

    for (const row of result.rows) {
      const startedAt = new Date();
      try {
        await connector.sync(row.id);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(err, `Sync failed for connection ${row.id}:`);
        try {
          await pool.query("update platform_connections set status = 'error' where id = $1 and status <> 'disconnected'", [row.id]);
          await pool.query(
            "insert into sync_logs (connection_id, started_at, finished_at, error) values ($1, $2, now(), $3)",
            [row.id, startedAt, errorMessage],
          );
        } catch (recoveryErr) {
          logger.error(recoveryErr, `Failed to record sync failure for connection ${row.id}:`);
        }
      }
    }
  } finally {
    if (acquired) {
      await lockClient.query("select pg_advisory_unlock($1)", [lockKey]);
    }
    lockClient.release();
  }
}

export async function sweepExpiredPendingConnections() {
  const result = await pool.query("delete from pending_connections where expires_at < now()");
  if (result.rowCount && result.rowCount > 0) {
    logger.info(`Swept ${result.rowCount} expired pending_connections row(s)`);
  }
}

export function startScheduler() {
  // Shopify order data is time-sensitive — hourly. noOverlap prevents a slow run
  // (e.g. a large historical backlog during onboarding) from double-firing.
  cron.schedule(
    "0 * * * *",
    () => {
      runScheduledSyncs("shopify").catch((err) => logger.error(err, "Shopify scheduled sync failed:"));
    },
    { noOverlap: true },
  );

  // Neither Meta nor Google Ads has a webhook/push mechanism for spend/performance data —
  // both are poll-only reporting APIs, so this is as close to real-time as either platform
  // allows. 15 minutes was chosen deliberately over something tighter: Google Ads' API quota
  // on this app's access tier is a shared daily budget across every connected client's
  // account (not per-client), and this connector makes ~2 calls per campaign per run (one
  // for metrics, one for ads) — at 5-minute intervals, an agency with even a modest total
  // campaign count across all its clients would exhaust the daily quota partway through the
  // day and Google Ads sync would start failing for everyone until the next day's reset.
  // 15 minutes (96 runs/day) keeps a comfortable safety margin as more clients connect.
  cron.schedule(
    "*/15 * * * *",
    () => {
      runScheduledSyncs("meta").catch((err) => logger.error(err, "Meta scheduled sync failed:"));
    },
    { noOverlap: true },
  );

  // Same cadence and reasoning as Meta, offset by 3 minutes so the two don't hit the
  // database in the same instant every 15 minutes.
  cron.schedule(
    "3,18,33,48 * * * *",
    () => {
      runScheduledSyncs("google").catch((err) => logger.error(err, "Google scheduled sync failed:"));
    },
    { noOverlap: true },
  );

  // Courier statuses change through the day and Shiprocket's list endpoint is cheap, so sync
  // hourly like Shopify, offset to minute 15 so the two don't hit the database together.
  cron.schedule(
    "15 * * * *",
    () => {
      runScheduledSyncs("courier_shiprocket").catch((err) => logger.error(err, "Shiprocket scheduled sync failed:"));
    },
    { noOverlap: true },
  );

  // Same hourly cadence, offset to minute 30 so Shopify (:00), Shiprocket (:15) and
  // Delhivery (:30) don't hit the database in the same minute.
  cron.schedule(
    "30 * * * *",
    () => {
      runScheduledSyncs("courier_delhivery").catch((err) => logger.error(err, "Delhivery scheduled sync failed:"));
    },
    { noOverlap: true },
  );

  // Pending connections expire after 30 minutes (see pending-connections.ts); sweeping
  // once a day is more than frequent enough to keep the table from growing unbounded —
  // expired rows are already excluded from every read path (readPending/lockPendingForUpdate
  // both filter on expires_at), so this is pure cleanup, not a correctness requirement.
  cron.schedule(
    "0 3 * * *",
    () => {
      sweepExpiredPendingConnections().catch((err) => logger.error(err, "Pending-connections sweep failed:"));
    },
    { noOverlap: true },
  );
}
