import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveClientScope } from "../lib/access.js";

const router = Router({ mergeParams: true });

const RTO_STATUSES = "('RTO Initiated', 'RTO Delivered')";

router.get("/summary", requireAuth, async (req, res, next) => {
  try {
    const clientIds = await resolveClientScope(pool, req.auth!.userId, req.params.id);
    const days = Math.max(1, Math.min(730, Number(req.query.days) || 30));

    const [connected, byStatus, byCourier] = await Promise.all([
      pool.query(
        `select exists (
           select 1 from platform_connections
           where client_id = any($1::text[]) and left(platform, 8) = 'courier_' and status = 'connected'
         ) as connected`,
        [clientIds],
      ),
      pool.query(
        `select status, count(*)::int as count
         from shipments
         where client_id = any($1::text[]) and ordered_at >= now() - ($2::int * interval '1 day')
         group by status`,
        [clientIds, days],
      ),
      pool.query(
        `select
           courier_name as name,
           count(*)::int as orders,
           (count(*) filter (where status = 'Delivered'))::int as delivered,
           (count(*) filter (where status in ${RTO_STATUSES}))::int as rto,
           (count(*) filter (where status = 'NDR'))::int as ndr,
           avg(extract(epoch from (delivered_at - ordered_at)) / 86400)
             filter (where status = 'Delivered' and delivered_at is not null) as avg_days
         from shipments
         where client_id = any($1::text[]) and ordered_at >= now() - ($2::int * interval '1 day')
         group by courier_name
         order by orders desc, courier_name`,
        [clientIds, days],
      ),
    ]);

    const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

    res.json({
      connected: connected.rows[0].connected as boolean,
      statusCounts: Object.fromEntries(byStatus.rows.map((r) => [r.status, r.count])),
      couriers: byCourier.rows.map((r) => ({
        name: r.name,
        orders: r.orders,
        delivered: r.delivered,
        rtoPercent: percent(r.rto, r.orders),
        ndrPercent: percent(r.ndr, r.orders),
        avgDeliveryDays: r.avg_days === null ? null : Math.round(Number(r.avg_days) * 10) / 10,
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
