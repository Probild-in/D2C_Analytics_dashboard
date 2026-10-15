import { Router } from "express";
import {
  createSubscription,
  getPlanIdFromRazorpayPlanId,
  getRazorpayKeyId,
  getSubscription,
  verifySubscriptionPaymentSignature,
} from "../integrations/razorpay-api.js";
import { createSupabaseUser, deleteSupabaseUser, EmailAlreadyRegisteredError } from "../lib/supabase-admin.js";
import { slugify, pickLogoColor, generateUniqueClientId } from "../lib/slug.js";
import pool from "../db.js";
import { HttpError } from "../lib/http-error.js";
import { createRateLimiter } from "../middleware/rate-limit.js";

const router = Router();

const SELF_SERVE_PLAN_IDS = ["small", "medium", "large"] as const;
type SelfServePlanId = (typeof SELF_SERVE_PLAN_IDS)[number];

function isSelfServePlanId(value: unknown): value is SelfServePlanId {
  return typeof value === "string" && (SELF_SERVE_PLAN_IDS as readonly string[]).includes(value);
}

router.post("/", createRateLimiter({ max: 10, windowMs: 60 * 60 * 1000, scope: "ip" }), async (req, res, next) => {
  try {
    const { planId, email } = req.body as { planId?: string; email?: string };
    if (planId === "enterprise") {
      throw new HttpError(400, "no_self_serve_enterprise", "Enterprise plans are custom — use the Contact Us form instead.");
    }
    if (!isSelfServePlanId(planId)) {
      throw new HttpError(400, "invalid_plan", "planId must be one of: small, medium, large");
    }
    // Best-effort pre-payment check: stop a known, already-registered email from being
    // charged before finding out it's taken. An account that exists only in Supabase (not
    // yet in team_members) isn't caught here — /complete's createSupabaseUser check
    // remains the authoritative backstop.
    if (typeof email === "string" && email.trim()) {
      const existing = await pool.query("select 1 from team_members where lower(email) = lower($1)", [email.trim()]);
      if ((existing.rowCount ?? 0) > 0) {
        throw new HttpError(409, "email_already_registered", "This email is already registered. Log in instead.");
      }
    }
    const { id } = await createSubscription(planId);
    res.json({ razorpaySubscriptionId: id, razorpayKeyId: getRazorpayKeyId() });
  } catch (err) {
    next(err);
  }
});

interface SignupCompleteBody {
  razorpaySubscriptionId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  planId?: string;
  brandName?: string;
  category?: string;
  ownerName?: string;
  email?: string;
  password?: string;
}

router.post("/complete", createRateLimiter({ max: 10, windowMs: 60 * 60 * 1000, scope: "ip" }), async (req, res, next) => {
  try {
    const body = req.body as SignupCompleteBody;
    // body.planId is deliberately NOT read: the plan is derived from what Razorpay says
    // this subscription was created for (below), never from the client's claim.
    const { razorpaySubscriptionId, razorpayPaymentId, razorpaySignature, brandName, category, ownerName, email, password } = body;

    if (!razorpaySubscriptionId || !razorpayPaymentId || !razorpaySignature) {
      throw new HttpError(400, "missing_payment_fields", "Missing Razorpay payment fields");
    }
    if (!brandName?.trim() || !category?.trim() || !ownerName?.trim() || !email?.trim() || !password) {
      throw new HttpError(400, "missing_fields", "brandName, category, ownerName, email, and password are all required");
    }
    if (!verifySubscriptionPaymentSignature({ razorpayPaymentId, razorpaySubscriptionId, razorpaySignature })) {
      throw new HttpError(400, "invalid_signature", "Could not verify this payment with Razorpay");
    }

    // Replay guard: the signature only binds payment id to subscription id, so a valid
    // signed triple could otherwise be resubmitted to provision any number of accounts.
    // The unique constraint on subscriptions.gateway_subscription_id (migration 015) is
    // the race-proof backstop for concurrent replays; this check is the fast path.
    const alreadyUsed = await pool.query("select 1 from subscriptions where gateway_subscription_id = $1", [razorpaySubscriptionId]);
    if ((alreadyUsed.rowCount ?? 0) > 0) {
      throw new HttpError(409, "payment_already_processed", "This payment has already been used to set up an account.");
    }

    let subscriptionDetails;
    try {
      subscriptionDetails = await getSubscription(razorpaySubscriptionId);
    } catch {
      throw new HttpError(502, "razorpay_unreachable", "Could not verify this subscription with Razorpay. Please try again.");
    }
    const verifiedPlanId = getPlanIdFromRazorpayPlanId(subscriptionDetails.plan_id);
    if (!verifiedPlanId) {
      throw new HttpError(400, "invalid_plan", "This subscription's plan could not be verified.");
    }
    if (!["authenticated", "active"].includes(subscriptionDetails.status)) {
      throw new HttpError(400, "payment_not_confirmed", "This payment has not been confirmed by Razorpay yet.");
    }
    const planId = verifiedPlanId; // every subsequent use of planId uses THIS, never the request body's

    const normalizedEmail = email.trim().toLowerCase();

    let supabaseUserId: string;
    try {
      const user = await createSupabaseUser(normalizedEmail, password);
      supabaseUserId = user.id;
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) {
        throw new HttpError(409, "email_already_registered", err.message);
      }
      throw err;
    }

    const planResult = await pool.query("select monthly_fee_inr from plans where id = $1", [planId]);
    const monthlyFeeInr = planResult.rows[0]?.monthly_fee_inr;

    // Use Razorpay's own billing period, falling back only if it didn't supply one.
    const periodStart = subscriptionDetails.current_start ? new Date(subscriptionDetails.current_start * 1000) : new Date();
    const periodEnd = subscriptionDetails.current_end
      ? new Date(subscriptionDetails.current_end * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");
      const clientId = await generateUniqueClientId(pool, brandName.trim());
      const logoColor = pickLogoColor(clientId);
      const logoInitial = brandName.trim().charAt(0).toUpperCase();

      // account_type = 'self_serve_owner' is what keeps this customer out of the
      // staff-only routes (full team roster, direct plan assignment, extra brands).
      await dbClient.query(
        `insert into team_members (id, name, email, role, all_client_access, account_type) values ($1, $2, $3, 'owner', false, 'self_serve_owner')`,
        [supabaseUserId, ownerName.trim(), normalizedEmail],
      );
      await dbClient.query(
        `insert into clients (id, name, category, logo_color, logo_initial, owner_id) values ($1, $2, $3, $4, $5, $6)`,
        [clientId, brandName.trim(), category.trim(), logoColor, logoInitial, supabaseUserId],
      );
      await dbClient.query(`insert into team_member_clients (team_member_id, client_id) values ($1, $2)`, [supabaseUserId, clientId]);
      const subResult = await dbClient.query(
        `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, current_period_start, current_period_end)
         values ($1, $2, 'active', $3, $4, $5) returning id`,
        [clientId, planId, razorpaySubscriptionId, periodStart, periodEnd],
      );
      // razorpay_payment_id (migration 014, unique) makes a later webhook redelivery of
      // this same first charge a genuine no-op rather than a duplicate paid invoice.
      await dbClient.query(
        `insert into invoices (subscription_id, amount_inr, status, period_start, period_end, razorpay_payment_id)
         values ($1, $2, 'paid', $3, $4, $5)`,
        [subResult.rows[0].id, monthlyFeeInr, periodStart, periodEnd, razorpayPaymentId],
      );
      await dbClient.query("COMMIT");
    } catch (err) {
      await dbClient.query("ROLLBACK");
      await deleteSupabaseUser(supabaseUserId);
      // A concurrent replay of the same subscription id that slipped past the fast-path
      // check above loses here, on the unique constraint — report it the same way.
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23505" && pgErr.constraint === "subscriptions_gateway_subscription_id_key") {
        throw new HttpError(409, "payment_already_processed", "This payment has already been used to set up an account.");
      }
      throw err;
    } finally {
      dbClient.release();
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
