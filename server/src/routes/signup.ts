import { Router } from "express";
import { createSubscription, getRazorpayKeyId, verifySubscriptionPaymentSignature } from "../integrations/razorpay-api.js";
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
    const { planId } = req.body as { planId?: string };
    if (planId === "enterprise") {
      throw new HttpError(400, "no_self_serve_enterprise", "Enterprise plans are custom — use the Contact Us form instead.");
    }
    if (!isSelfServePlanId(planId)) {
      throw new HttpError(400, "invalid_plan", "planId must be one of: small, medium, large");
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
    const { razorpaySubscriptionId, razorpayPaymentId, razorpaySignature, planId, brandName, category, ownerName, email, password } = body;

    if (!razorpaySubscriptionId || !razorpayPaymentId || !razorpaySignature) {
      throw new HttpError(400, "missing_payment_fields", "Missing Razorpay payment fields");
    }
    if (!isSelfServePlanId(planId)) {
      throw new HttpError(400, "invalid_plan", "planId must be one of: small, medium, large");
    }
    if (!brandName?.trim() || !category?.trim() || !ownerName?.trim() || !email?.trim() || !password) {
      throw new HttpError(400, "missing_fields", "brandName, category, ownerName, email, and password are all required");
    }
    if (!verifySubscriptionPaymentSignature({ razorpayPaymentId, razorpaySubscriptionId, razorpaySignature })) {
      throw new HttpError(400, "invalid_signature", "Could not verify this payment with Razorpay");
    }

    let supabaseUserId: string;
    try {
      const user = await createSupabaseUser(email.trim(), password);
      supabaseUserId = user.id;
    } catch (err) {
      if (err instanceof EmailAlreadyRegisteredError) {
        throw new HttpError(409, "email_already_registered", err.message);
      }
      throw err;
    }

    const planResult = await pool.query("select monthly_fee_inr from plans where id = $1", [planId]);
    const monthlyFeeInr = planResult.rows[0]?.monthly_fee_inr;

    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");
      const clientId = await generateUniqueClientId(pool, brandName.trim());
      const logoColor = pickLogoColor(clientId);
      const logoInitial = brandName.trim().charAt(0).toUpperCase();

      await dbClient.query(
        `insert into team_members (id, name, email, role, all_client_access) values ($1, $2, $3, 'owner', false)`,
        [supabaseUserId, ownerName.trim(), email.trim()],
      );
      await dbClient.query(
        `insert into clients (id, name, category, logo_color, logo_initial, owner_id) values ($1, $2, $3, $4, $5, $6)`,
        [clientId, brandName.trim(), category.trim(), logoColor, logoInitial, supabaseUserId],
      );
      await dbClient.query(`insert into team_member_clients (team_member_id, client_id) values ($1, $2)`, [supabaseUserId, clientId]);
      const subResult = await dbClient.query(
        `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id) values ($1, $2, 'active', $3) returning id`,
        [clientId, planId, razorpaySubscriptionId],
      );
      await dbClient.query(
        `insert into invoices (subscription_id, amount_inr, status, period_start, period_end)
         values ($1, $2, 'paid', now(), now() + interval '30 days')`,
        [subResult.rows[0].id, monthlyFeeInr],
      );
      await dbClient.query("COMMIT");
    } catch (err) {
      await dbClient.query("ROLLBACK");
      await deleteSupabaseUser(supabaseUserId);
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
