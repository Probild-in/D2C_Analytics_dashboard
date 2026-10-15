import cron from "node-cron";
import pool from "./db.js";
import { connectors } from "./lib/connector-registry.js";

export async function runScheduledSyncs(platform: string) {
  const connector = connectors[platform];
  if (!connector) return;

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
      runScheduledSyncs("meta").catch((err) => console.error("Meta scheduled sync failed:", err));
    },
    { noOverlap: true },
  );

  // Same cadence and reasoning as Meta, offset by 3 minutes so the two don't hit the
  // database in the same instant every 15 minutes.
  cron.schedule(
    "3,18,33,48 * * * *",
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
