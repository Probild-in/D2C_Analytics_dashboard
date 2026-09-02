import cron from "node-cron";
import pool from "./db.js";
import { connectors } from "./lib/connector-registry.js";

export async function runScheduledSyncs(platform: string) {
  const connector = connectors[platform];
  if (!connector) return;

  const result = await pool.query(
    "select id from platform_connections where platform = $1 and status = 'connected'",
    [platform],
  );

  for (const row of result.rows) {
    const startedAt = new Date();
    try {
      await connector.sync(row.id);
    } catch (err) {
      await pool.query("update platform_connections set status = 'error' where id = $1", [row.id]);
      await pool.query(
        "insert into sync_logs (connection_id, started_at, finished_at, error) values ($1, $2, now(), $3)",
        [row.id, startedAt, err instanceof Error ? err.message : String(err)],
      );
    }
  }
}

export function startScheduler() {
  // Shopify order data is time-sensitive — hourly.
  cron.schedule("0 * * * *", () => {
    runScheduledSyncs("shopify").catch((err) => console.error("Shopify scheduled sync failed:", err));
  });
}
