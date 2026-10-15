import { Router } from "express";
import { createSubscription, getRazorpayKeyId } from "../integrations/razorpay-api.js";
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

export default router;
