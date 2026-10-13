import crypto from "node:crypto";
import cron from "node-cron";
import pool from "./db.js";
import { connectors } from "./lib/connector-registry.js";

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
        console.error(`Sync failed for connection ${row.id}:`, err);
        try {
          await pool.query("update platform_connections set status = 'error' where id = $1 and status <> 'disconnected'", [row.id]);
          await pool.query(
            "insert into sync_logs (connection_id, started_at, finished_at, error) values ($1, $2, now(), $3)",
            [row.id, startedAt, errorMessage],
          );
        } catch (recoveryErr) {
          console.error(`Failed to record sync failure for connection ${row.id}:`, recoveryErr);
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

export function startScheduler() {
  // Shopify order data is time-sensitive — hourly. noOverlap prevents a slow run
  // (e.g. a large historical backlog during onboarding) from double-firing.
  cron.schedule(
    "0 * * * *",
    () => {
      runScheduledSyncs("shopify").catch((err) => console.error("Shopify scheduled sync failed:", err));
    },
    { noOverlap: true },
  );

  // Meta's Insights API updates less frequently than Shopify's order stream and is far
  // more rate-limit-sensitive (this connector's sync makes 3 API calls per campaign, plus
  // 1 per ad) — 6-hourly keeps well clear of Meta's per-app rate limits even for a client
  // with dozens of active campaigns.
  cron.schedule(
    "0 */6 * * *",
    () => {
      runScheduledSyncs("meta").catch((err) => console.error("Meta scheduled sync failed:", err));
    },
    { noOverlap: true },
  );

  // Same 6-hourly cadence as Meta — Google Ads' own reporting also lags, and its API has
  // per-developer-token rate limits this schedule stays well clear of.
  cron.schedule(
    "0 */6 * * *",
    () => {
      runScheduledSyncs("google").catch((err) => console.error("Google scheduled sync failed:", err));
    },
    { noOverlap: true },
  );

  // Courier statuses change through the day and Shiprocket's list endpoint is cheap, so sync
  // hourly like Shopify, offset to minute 15 so the two don't hit the database together.
  cron.schedule(
    "15 * * * *",
    () => {
      runScheduledSyncs("courier_shiprocket").catch((err) => console.error("Shiprocket scheduled sync failed:", err));
    },
    { noOverlap: true },
  );

  // Same hourly cadence, offset to minute 30 so Shopify (:00), Shiprocket (:15) and
  // Delhivery (:30) don't hit the database in the same minute.
  cron.schedule(
    "30 * * * *",
    () => {
      runScheduledSyncs("courier_delhivery").catch((err) => console.error("Delhivery scheduled sync failed:", err));
    },
    { noOverlap: true },
  );
}
