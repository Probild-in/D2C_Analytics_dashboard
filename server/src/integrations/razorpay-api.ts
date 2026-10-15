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
