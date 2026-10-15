import crypto from "node:crypto";

// A monthly subscription with no planned end date still needs a total_count —
// Razorpay has no literal "forever" option. 1200 cycles (100 years) is the
// conventional way to express "runs until explicitly cancelled".
const INDEFINITE_TOTAL_COUNT = 1200;

function getCredentials(): { keyId: string; keySecret: string } {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables must be set");
  }
  return { keyId, keySecret };
}

export function getRazorpayKeyId(): string {
  return getCredentials().keyId;
}

function getPlanId(planId: "small" | "medium" | "large"): string {
  const envVar = { small: "RAZORPAY_PLAN_ID_SMALL", medium: "RAZORPAY_PLAN_ID_MEDIUM", large: "RAZORPAY_PLAN_ID_LARGE" }[planId];
  const value = process.env[envVar];
  if (!value) {
    throw new Error(`${envVar} environment variable must be set — create the matching recurring Plan in Razorpay's dashboard first`);
  }
  return value;
}

export async function createSubscription(planId: "small" | "medium" | "large"): Promise<{ id: string }> {
  const { keyId, keySecret } = getCredentials();
  const res = await fetch("https://api.razorpay.com/v1/subscriptions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
    },
    body: JSON.stringify({ plan_id: getPlanId(planId), customer_notify: 1, total_count: INDEFINITE_TOTAL_COUNT }),
  });
  if (!res.ok) {
    throw new Error(`Razorpay subscription creation failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return { id: body.id };
}

export interface RazorpaySubscriptionDetails {
  id: string;
  plan_id: string;
  status: string;
  current_start?: number;
  current_end?: number;
}

export async function getSubscription(subscriptionId: string): Promise<RazorpaySubscriptionDetails> {
  const { keyId, keySecret } = getCredentials();
  const res = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Razorpay subscription ${subscriptionId}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RazorpaySubscriptionDetails;
}

// The inverse of getPlanId: given the Razorpay Plan id actually on a subscription,
// find which of our self-serve plan ids maps to it. Used so /complete trusts what
// Razorpay says the customer paid for, never what the client claims in the request body.
export function getPlanIdFromRazorpayPlanId(razorpayPlanId: string): "small" | "medium" | "large" | null {
  for (const planId of ["small", "medium", "large"] as const) {
    try {
      if (getPlanId(planId) === razorpayPlanId) return planId;
    } catch {
      // that plan's env var isn't configured in this environment — skip it
    }
  }
  return null;
}

// Razorpay's documented formula for verifying a subscription payment: HMAC-SHA256 of
// "<payment_id>|<subscription_id>" keyed with the API secret, hex-encoded, timing-safe
// compared against the signature the client received from Razorpay's own Checkout.
export function verifySubscriptionPaymentSignature(params: {
  razorpayPaymentId: string;
  razorpaySubscriptionId: string;
  razorpaySignature: string;
}): boolean {
  const { keySecret } = getCredentials();
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${params.razorpayPaymentId}|${params.razorpaySubscriptionId}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(params.razorpaySignature, "utf8");
  return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// Razorpay's documented webhook scheme: HMAC-SHA256 of the raw request body, keyed with
// the webhook secret configured when the webhook was registered in Razorpay's dashboard
// (separate from the API key secret above).
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error("RAZORPAY_WEBHOOK_SECRET environment variable must be set");
  }
  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signatureHeader, "utf8");
  return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
}
