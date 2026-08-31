import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAccessibleClientIds } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";

const router = Router({ mergeParams: true });

async function assertClientAccess(userId: string, clientId: string) {
  const accessible = await getAccessibleClientIds(pool, userId);
  if (accessible === "all") return;
  if (!accessible.includes(clientId)) {
    throw new HttpError(404, "not_found", "Client not found");
  }
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(req.auth!.userId, clientId);

    const subResult = await pool.query(
      `select s.*, p.name as plan_name, p.order_limit, p.monthly_fee_inr, p.included_meta_accounts, p.included_google_accounts
       from subscriptions s join plans p on p.id = s.plan_id where s.client_id = $1`,
      [clientId],
    );

    if (subResult.rowCount === 0) {
      const plans = await pool.query("select * from plans order by monthly_fee_inr");
      res.json({ plan: null, subscription: null, overOrderLimit: false, availablePlans: plans.rows });
      return;
    }

    const sub = subResult.rows[0];
    const orderCount = await pool.query(
      `select count(*)::int as count from shopify_orders
       where client_id = $1 and order_date >= $2`,
      [clientId, sub.current_period_start],
    );

    res.json({
      plan: {
        id: sub.plan_id,
        name: sub.plan_name,
        orderLimit: sub.order_limit,
        monthlyFeeInr: sub.monthly_fee_inr,
        includedMetaAccounts: sub.included_meta_accounts,
        includedGoogleAccounts: sub.included_google_accounts,
      },
      subscription: {
        status: sub.status,
        currentPeriodStart: sub.current_period_start,
        currentPeriodEnd: sub.current_period_end,
        extraShopifyStores: sub.extra_shopify_stores,
        extraMetaAccounts: sub.extra_meta_accounts,
        extraGoogleAccounts: sub.extra_google_accounts,
      },
      overOrderLimit: sub.order_limit !== null && orderCount.rows[0].count > sub.order_limit,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
