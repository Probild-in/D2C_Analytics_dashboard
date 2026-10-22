const SHOPIFY_API_VERSION = "2024-10";

// Shopify's Billing API bills in a currency code per-subscription (`AppSubscriptionLineItemInput`'s
// `appRecurringPricingDetails.price.currencyCode`). Shopify's own guidance (shopify.dev's
// "About billing for your app") recommends billing merchants in their *local* billing currency
// (retrieved via the `shopBillingPreferences` query) for budgeting clarity, and documents INR as
// one of the supported local billing currencies. However:
//   - This app is listed on the public Shopify App Store, so installs can come from merchants in
//     any country, not just India — reusing `plans.monthly_fee_inr` (this codebase's existing
//     Razorpay-channel pricing) directly would charge non-Indian merchants in INR, which Shopify
//     does not require and which would be confusing/wrong for them.
//   - Doing real per-merchant local-currency billing would require an additional
//     `shopBillingPreferences` query this task is not scoped to add, plus a full local-currency
//     price table (avoiding guessed exchange rates, per this plan's own constraint).
//   - USD is confirmed to always be valid for Shopify app billing regardless of the merchant's
//     shop/location (community reports of the REST Billing API silently defaulting non-USD
//     currencies to USD; GraphQL's appSubscriptionCreate accepts USD unconditionally).
// So this integration bills a fixed, explicitly-Shopify-channel USD price list — not a currency
// conversion of the INR Razorpay prices — same resolution the plan's "Known uncertainties"
// section calls for.

// PLACEHOLDER VALUES — not confirmed pricing sign-off. These are a rough USD conversion for
// development/testing only. Replace with real, approved prices before this goes live.
export const PLAN_PRICES_USD: Record<"small" | "medium" | "large", number> = {
  small: 19,
  medium: 39,
  large: 79,
};

const PLAN_NAMES: Record<"small" | "medium" | "large", string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

async function shopifyGraphql(shop: string, accessToken: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Shopify GraphQL request failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  if (body.errors) {
    throw new Error(`Shopify GraphQL request returned errors: ${body.errors.map((e: { message: string }) => e.message).join(", ")}`);
  }
  return body;
}

export async function createAppSubscription(
  shop: string,
  accessToken: string,
  planId: "small" | "medium" | "large",
  returnUrl: string,
): Promise<{ confirmationUrl: string; subscriptionGid: string }> {
  const mutation = `
    mutation AppSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!) {
      appSubscriptionCreate(name: $name, lineItems: $lineItems, returnUrl: $returnUrl) {
        appSubscription { id }
        confirmationUrl
        userErrors { field message }
      }
    }
  `;
  const variables = {
    name: PLAN_NAMES[planId],
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            price: { amount: PLAN_PRICES_USD[planId], currencyCode: "USD" },
            interval: "EVERY_30_DAYS",
          },
        },
      },
    ],
    returnUrl,
  };
  const body = await shopifyGraphql(shop, accessToken, mutation, variables);
  const result = body.data.appSubscriptionCreate;
  if (result.userErrors?.length > 0) {
    throw new Error(`Shopify rejected the subscription: ${result.userErrors.map((e: { message: string }) => e.message).join(", ")}`);
  }
  return { confirmationUrl: result.confirmationUrl, subscriptionGid: result.appSubscription.id };
}

export async function getAppSubscription(shop: string, accessToken: string, subscriptionGid: string): Promise<{ status: string; name: string }> {
  const query = `
    query GetAppSubscription($id: ID!) {
      node(id: $id) {
        ... on AppSubscription { status name }
      }
    }
  `;
  const body = await shopifyGraphql(shop, accessToken, query, { id: subscriptionGid });
  const node = body.data.node;
  if (!node) {
    throw new Error(`Shopify app subscription not found: ${subscriptionGid}`);
  }
  return { status: node.status, name: node.name };
}
