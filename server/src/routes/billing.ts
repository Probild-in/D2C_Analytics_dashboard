import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";
import { stubPaymentGateway } from "../integrations/payment-gateway.js";

const router = Router({ mergeParams: true });

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);

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
       where client_id = $1 and order_date >= $2 and order_date < $3`,
      [clientId, sub.current_period_start, sub.current_period_end],
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

router.post("/", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const { planId } = req.body as { planId?: string };
    const plan = await pool.query("select * from plans where id = $1", [planId]);
    if (plan.rowCount === 0) {
      throw new HttpError(400, "invalid_plan", `No plan with id ${planId}`);
    }

    // Check if subscription already exists for this client
    const existingSubResult = await pool.query(
      "select plan_id from subscriptions where client_id = $1",
      [clientId],
    );
    const existingPlanId = (existingSubResult.rowCount ?? 0) > 0 ? existingSubResult.rows[0].plan_id : null;

    const { gatewayCustomerId } = await stubPaymentGateway.createSubscription(clientId, planId!);

    const subResult = await pool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_customer_id)
       values ($1, $2, 'active', $3)
       on conflict (client_id) do update set plan_id = excluded.plan_id, status = 'active'
       returning *`,
      [clientId, planId, gatewayCustomerId],
    );
    const subscription = subResult.rows[0];

    // Only insert a new invoice if:
    // 1. No subscription existed before (genuinely new), OR
    // 2. A subscription existed but the plan_id has changed (real plan change)
    if (existingPlanId === null || existingPlanId !== planId) {
      await pool.query(
        `insert into invoices (subscription_id, amount_inr, status, period_start, period_end)
         values ($1, $2, 'pending', $3, $4)`,
        [subscription.id, plan.rows[0].monthly_fee_inr, subscription.current_period_start, subscription.current_period_end],
      );
    }

    res.status(201).json({ subscription: { status: subscription.status, planId: subscription.plan_id } });
  } catch (err) {
    next(err);
  }
});

export default router;
