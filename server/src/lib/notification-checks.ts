import type pg from "pg";
import { ORDER_RTO_CTES_SINGLE_CLIENT } from "./rto-status.js";
import { publishNotification } from "./notification-bus.js";
import { logger } from "./logger.js";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Returns the [start, end) instant range (as real UTC Date objects, safe to bind as
// timestamptz query params) for the IST calendar day `daysAgo` days before today.
// daysAgo=0 is today, daysAgo=1 is yesterday, daysAgo=8 is the same weekday one week
// before yesterday. IST has no DST, so a fixed +5:30 offset is exact, unlike most
// timezones — see server/src/lib/sql-dates.ts for the equivalent SQL-side convention
// this mirrors.
export function getIstDayBoundaries(daysAgo: number): { start: Date; end: Date } {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const istMidnightTodayUtcMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - IST_OFFSET_MS;
  const start = new Date(istMidnightTodayUtcMs - daysAgo * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

const DEDUP_WINDOW = "interval '20 hours'";

async function alreadyAlertedRecently(pool: pg.Pool, clientId: string, kind: string): Promise<boolean> {
  const result = await pool.query(
    `select 1 from notifications where client_id = $1 and kind = $2 and created_at > now() - ${DEDUP_WINDOW}`,
    [clientId, kind],
  );
  return (result.rowCount ?? 0) > 0;
}

async function insertAndPublish(
  pool: pg.Pool,
  clientId: string,
  clientName: string,
  kind: "rto" | "sales" | "ads" | "roas",
  title: string,
  description: string,
) {
  const inserted = await pool.query(
    `insert into notifications (client_id, kind, title, description) values ($1, $2, $3, $4) returning id, created_at`,
    [clientId, kind, title, description],
  );
  publishNotification({
    id: inserted.rows[0].id,
    clientId,
    clientName,
    kind,
    title,
    description,
    createdAt: inserted.rows[0].created_at.toISOString(),
  });
}

async function checkRto(pool: pg.Pool, clientId: string, clientName: string, yesterday: { start: Date; end: Date }) {
  if (await alreadyAlertedRecently(pool, clientId, "rto")) return;
  const result = await pool.query<{ total: string; rto: string }>(
    `with ${ORDER_RTO_CTES_SINGLE_CLIENT}
     select count(*) as total, count(*) filter (where is_rto) as rto
     from order_rto
     join shopify_orders o on o.id = order_rto.order_id
     where o.order_date >= $2 and o.order_date < $3`,
    [clientId, yesterday.start, yesterday.end],
  );
  const total = Number(result.rows[0]?.total ?? 0);
  const rto = Number(result.rows[0]?.rto ?? 0);
  if (total === 0) return;
  const rtoPercent = (rto / total) * 100;
  if (rtoPercent >= 15) {
    await insertAndPublish(pool, clientId, clientName, "rto", "RTO alert", `RTO rate hit ${rtoPercent.toFixed(1)}% yesterday — critical threshold is 15%.`);
  } else if (rtoPercent >= 8) {
    await insertAndPublish(pool, clientId, clientName, "rto", "RTO alert", `RTO rate hit ${rtoPercent.toFixed(1)}% yesterday — attention threshold is 8%.`);
  }
}

async function checkSalesDip(
  pool: pg.Pool,
  clientId: string,
  clientName: string,
  yesterday: { start: Date; end: Date },
  weekBefore: { start: Date; end: Date },
) {
  if (await alreadyAlertedRecently(pool, clientId, "sales")) return;
  const [y, w] = await Promise.all([
    pool.query<{ count: string }>("select count(*) as count from shopify_orders where client_id = $1 and order_date >= $2 and order_date < $3", [
      clientId,
      yesterday.start,
      yesterday.end,
    ]),
    pool.query<{ count: string }>("select count(*) as count from shopify_orders where client_id = $1 and order_date >= $2 and order_date < $3", [
      clientId,
      weekBefore.start,
      weekBefore.end,
    ]),
  ]);
  const yesterdayCount = Number(y.rows[0].count);
  const weekBeforeCount = Number(w.rows[0].count);
  if (weekBeforeCount === 0) return; // nothing to meaningfully compare against
  const dipPercent = ((weekBeforeCount - yesterdayCount) / weekBeforeCount) * 100;
  if (dipPercent >= 20) {
    await insertAndPublish(
      pool,
      clientId,
      clientName,
      "sales",
      "Sales dip detected",
      `Orders dropped ${dipPercent.toFixed(0)}% yesterday compared to the same day last week.`,
    );
  }
}

async function getAdSpend(pool: pg.Pool, clientId: string, range: { start: Date; end: Date }): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `select coalesce(
       (select sum(spend) from meta_campaign_metrics where client_id = $1 and metric_date >= $2::date and metric_date < $3::date), 0
     ) + coalesce(
       (select sum(spend) from google_campaign_metrics where client_id = $1 and metric_date >= $2::date and metric_date < $3::date), 0
     ) as total`,
    [clientId, range.start, range.end],
  );
  return Number(result.rows[0].total);
}

async function checkAdSpendAnomaly(pool: pg.Pool, clientId: string, clientName: string, yesterday: { start: Date; end: Date }) {
  if (await alreadyAlertedRecently(pool, clientId, "ads")) return;
  const yesterdaySpend = await getAdSpend(pool, clientId, yesterday);
  if (yesterdaySpend === 0) return;
  // Trailing 7 complete days before yesterday (daysAgo=2..8), not including yesterday itself.
  const trailingStart = getIstDayBoundaries(8).start;
  const trailingEnd = getIstDayBoundaries(2).end;
  const trailingTotal = await getAdSpend(pool, clientId, { start: trailingStart, end: trailingEnd });
  const trailingAverage = trailingTotal / 7;
  if (trailingAverage === 0) return;
  const changePercent = ((yesterdaySpend - trailingAverage) / trailingAverage) * 100;
  if (Math.abs(changePercent) >= 25) {
    const direction = changePercent > 0 ? "increased" : "decreased";
    await insertAndPublish(
      pool,
      clientId,
      clientName,
      "ads",
      "Ad spend anomaly",
      `Ad spend ${direction} ${Math.abs(changePercent).toFixed(0)}% yesterday compared to the trailing 7-day average.`,
    );
  }
}

async function checkBlendedRoas(pool: pg.Pool, clientId: string, clientName: string, yesterday: { start: Date; end: Date }) {
  if (await alreadyAlertedRecently(pool, clientId, "roas")) return;
  const adSpend = await getAdSpend(pool, clientId, yesterday);
  if (adSpend === 0) return;
  const netSalesResult = await pool.query<{ net_sales: string }>(
    `select coalesce(sum(amount) filter (where status <> 'Cancelled'), 0) as net_sales
     from shopify_orders where client_id = $1 and order_date >= $2 and order_date < $3`,
    [clientId, yesterday.start, yesterday.end],
  );
  const netSales = Number(netSalesResult.rows[0].net_sales);
  const roas = netSales / adSpend;
  if (roas < 3.0) {
    await insertAndPublish(
      pool,
      clientId,
      clientName,
      "roas",
      "Blended ROAS below target",
      `Blended ROAS fell to ${roas.toFixed(1)}x yesterday, below the 3.0x target.`,
    );
  }
}

export async function runDailyNotificationChecks(pool: pg.Pool): Promise<void> {
  const yesterday = getIstDayBoundaries(1);
  const weekBefore = getIstDayBoundaries(8);
  const clients = await pool.query<{ id: string; name: string }>("select id, name from clients");
  for (const { id: clientId, name: clientName } of clients.rows) {
    try {
      await checkRto(pool, clientId, clientName, yesterday);
      await checkSalesDip(pool, clientId, clientName, yesterday, weekBefore);
      await checkAdSpendAnomaly(pool, clientId, clientName, yesterday);
      await checkBlendedRoas(pool, clientId, clientName, yesterday);
    } catch (err) {
      // One client's bad data must not stop every other client's checks from running.
      logger.error(err, `Daily notification checks failed for client ${clientId}`);
    }
  }
}
