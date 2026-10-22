import express, { Router } from "express";
import pool from "../db.js";
import { verifyWebhookSignature } from "../integrations/razorpay-api.js";

const router = Router();

router.use(express.raw({ type: "application/json" }));

interface RazorpayWebhookPayload {
  event: string;
  payload: {
    subscription?: { entity: { id: string; current_start?: number; current_end?: number } };
    payment?: { entity: { id: string } };
  };
}

router.post("/", async (req, res, next) => {
  try {
    const rawBody = req.body as Buffer;
    if (!verifyWebhookSignature(rawBody, req.header("x-razorpay-signature"))) {
      res.status(401).send();
      return;
    }

    const event = JSON.parse(rawBody.toString("utf8")) as RazorpayWebhookPayload;
    const subscriptionId = event.payload.subscription?.entity.id;
    if (!subscriptionId) {
      res.status(200).send();
      return;
    }

    const subResult = await pool.query(
      "select id, client_id from subscriptions where gateway_subscription_id = $1 and billing_provider = 'razorpay'",
      [subscriptionId],
    );
    if (subResult.rowCount === 0) {
      // Stale or test-mode webhook with no matching local subscription — nothing to do.
      res.status(200).send();
      return;
    }
    const { id: subscriptionRowId, client_id: clientId } = subResult.rows[0];

    if (event.event === "subscription.charged") {
      const entity = event.payload.subscription!.entity;
      const paymentId = event.payload.payment?.entity.id;
      if (entity.current_start && entity.current_end) {
        await pool.query(
          "update subscriptions set current_period_start = to_timestamp($1), current_period_end = to_timestamp($2), status = 'active' where id = $3",
          [entity.current_start, entity.current_end, subscriptionRowId],
        );
      }
      if (paymentId) {
        const planResult = await pool.query(
          "select p.monthly_fee_inr from subscriptions s join plans p on p.id = s.plan_id where s.id = $1",
          [subscriptionRowId],
        );
        // razorpay_payment_id is the natural idempotency key for a redelivered webhook —
        // if this exact payment was already recorded, this insert is a no-op rather than a
        // duplicate invoice. invoices has no column for it today; add one in this same task
        // rather than guessing at a workaround (see Step 3a below).
        await pool.query(
          `insert into invoices (subscription_id, amount_inr, status, period_start, period_end, razorpay_payment_id)
           values ($1, $2, 'paid', now(), now() + interval '30 days', $3)
           on conflict (razorpay_payment_id) do nothing`,
          [subscriptionRowId, planResult.rows[0]?.monthly_fee_inr, paymentId],
        );
      }
    } else if (event.event === "subscription.halted" || event.event === "payment.failed") {
      await pool.query("update subscriptions set status = 'past_due' where id = $1", [subscriptionRowId]);
    } else if (event.event === "subscription.cancelled") {
      await pool.query("update subscriptions set status = 'canceled' where id = $1", [subscriptionRowId]);
    }
    // Any other event type: 200, no-op — never fail on an event this app doesn't react to.

    void clientId; // reserved for a future per-client notification; not used yet.
    res.status(200).send();
  } catch (err) {
    next(err);
  }
});

export default router;
