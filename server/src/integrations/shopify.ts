import crypto from "node:crypto";
import type { OAuthConnector } from "./types.js";
import pool from "../db.js";
import { decryptToken } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";

const SHOPIFY_SCOPES = "read_orders,read_products,read_customers";
const SHOP_DOMAIN_RE = /^[a-z0-9-]+\.myshopify\.com$/;

// Real-time order sync: Shopify pushes these the instant they happen, instead of
// waiting for the hourly poll (scheduler.ts keeps that poll running too, as a fallback
// for any delivery these webhooks miss — e.g. if this server was briefly down).
// The full Order resource (same shape for all three topics) covers every field
// mapOrderStatus/mapPaymentMethod need, so one handler (upsertShopifyOrder) serves both
// the poller and the webhook route.
export const SHOPIFY_WEBHOOK_TOPICS = ["orders/create", "orders/updated", "orders/cancelled"] as const;

export interface ShopifyOrder {
  id: number;
  created_at: string;
  total_price: string;
  financial_status: string;
  fulfillment_status: string | null;
  cancelled_at: string | null;
  customer: { id: number; first_name: string; last_name: string } | null;
  shipping_address: { city: string; province: string } | null;
  payment_gateway_names: string[];
  line_items: { id: number; title: string; quantity: number; price: string }[];
  fulfillments?: { tracking_company: string | null; tracking_number: string | null }[];
}

// Shopify's core Orders API only exposes financial_status/fulfillment_status/cancelled_at —
// it has no native concept of NDR/RTO/Out-for-Delivery. Those need a courier integration,
// which is explicitly out of scope. This maps what Shopify actually tells us onto the
// closest fit in the existing OrderStatus enum, rather than fabricating granularity we
// don't have.
// Only the first fulfillment's tracking info is captured. A multi-fulfillment order (rare
// for this dashboard's D2C use case) only records the first courier's tracking number —
// accepted gap, not a bug.
function firstFulfillmentTracking(order: ShopifyOrder): { company: string | null; number: string | null } {
  const first = order.fulfillments?.[0];
  return { company: first?.tracking_company ?? null, number: first?.tracking_number ?? null };
}

function mapOrderStatus(order: ShopifyOrder): string {
  if (order.cancelled_at) return "Cancelled";
  if (order.fulfillment_status === "fulfilled") return "Delivered";
  return "Dispatched";
}

function mapPaymentMethod(gatewayNames: string[]): string {
  const isCod = gatewayNames.some((name) => name.toLowerCase().includes("cash") || name.toLowerCase().includes("cod"));
  return isCod ? "COD" : "Prepaid";
}

function getRedirectUri(): string {
  const frontendApiUrl = process.env.PUBLIC_API_URL;
  if (!frontendApiUrl) {
    throw new Error("PUBLIC_API_URL environment variable must be set");
  }
  return `${frontendApiUrl}/api/integrations/shopify/callback`;
}

function getCredentials(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("SHOPIFY_API_KEY and SHOPIFY_API_SECRET environment variables must be set");
  }
  return { apiKey, apiSecret };
}

function getWebhookAddress(): string {
  const apiUrl = process.env.PUBLIC_API_URL;
  if (!apiUrl) {
    throw new Error("PUBLIC_API_URL environment variable must be set");
  }
  return `${apiUrl}/api/webhooks/shopify/orders`;
}

// Verifies a webhook delivery genuinely came from Shopify: HMAC-SHA256 over the raw
// (unparsed) request body, base64-encoded, keyed with our app's API secret — a
// different scheme from the OAuth callback's query-string HMAC above (verifyCallbackHmac),
// per Shopify's own docs for each. Comparison is timing-safe and length-checked first
// since timingSafeEqual throws on mismatched buffer lengths rather than returning false.
export function verifyShopifyWebhookHmac(rawBody: Buffer, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader) return false;
  const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const computedBuf = Buffer.from(computed, "utf8");
  const providedBuf = Buffer.from(hmacHeader, "utf8");
  return computedBuf.length === providedBuf.length && crypto.timingSafeEqual(computedBuf, providedBuf);
}

// Subscribes this shop to real-time order webhooks, called right after a successful
// OAuth connect. Lists existing webhooks first and only creates the ones missing at our
// address — re-running this on every reconnect must not create duplicate subscriptions
// (Shopify doesn't dedupe for you; a duplicate means every order gets pushed twice).
// Failure here is non-fatal: it's logged and swallowed so a Shopify API hiccup doesn't
// block the connect itself — the hourly poll still covers this store either way.
export async function registerWebhooks(shop: string, accessToken: string): Promise<void> {
  try {
    const address = getWebhookAddress();
    const listRes = await fetch(`https://${shop}/admin/api/2024-10/webhooks.json?address=${encodeURIComponent(address)}`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (!listRes.ok) {
      throw new Error(`Shopify webhooks list failed: ${listRes.status} ${await listRes.text()}`);
    }
    const { webhooks } = (await listRes.json()) as { webhooks: { topic: string }[] };
    const existingTopics = new Set(webhooks.map((w) => w.topic));

    for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
      if (existingTopics.has(topic)) continue;
      const createRes = await fetch(`https://${shop}/admin/api/2024-10/webhooks.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ webhook: { topic, address, format: "json" } }),
      });
      if (!createRes.ok) {
        throw new Error(`Shopify webhook create failed for topic ${topic}: ${createRes.status} ${await createRes.text()}`);
      }
    }
  } catch (err) {
    logger.error(err, `Failed to register Shopify webhooks for ${shop}`);
  }
}

// Shared by the hourly poll (sync, below) and the real-time webhook route — both see the
// same full Order resource shape, so both upsert it identically.
export async function upsertShopifyOrder(clientId: string, connectionId: string, order: ShopifyOrder): Promise<string> {
  const status = mapOrderStatus(order);
  const paymentMethod = mapPaymentMethod(order.payment_gateway_names);
  const customerName = order.customer ? `${order.customer.first_name} ${order.customer.last_name}`.trim() : "Guest";
  const { company: trackingCompany, number: trackingNumber } = firstFulfillmentTracking(order);

  const orderResult = await pool.query(
    `insert into shopify_orders
       (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, city, state, shopify_customer_id, tracking_number, tracking_company)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (connection_id, shopify_order_id)
     do update set customer_name = excluded.customer_name, amount = excluded.amount, status = excluded.status,
       payment_method = excluded.payment_method, city = excluded.city, state = excluded.state,
       tracking_number = excluded.tracking_number, tracking_company = excluded.tracking_company
     returning id`,
    [
      clientId,
      connectionId,
      String(order.id),
      customerName,
      order.created_at,
      Math.round(parseFloat(order.total_price)),
      status,
      paymentMethod,
      order.shipping_address?.city ?? null,
      order.shipping_address?.province ?? null,
      order.customer ? String(order.customer.id) : null,
      trackingNumber,
      trackingCompany,
    ],
  );
  const orderId = orderResult.rows[0].id;

  for (const item of order.line_items) {
    await pool.query(
      `insert into shopify_order_line_items (order_id, shopify_line_item_id, product_name, quantity, price)
       values ($1, $2, $3, $4, $5)
       on conflict (order_id, shopify_line_item_id)
       do update set product_name = excluded.product_name, quantity = excluded.quantity, price = excluded.price`,
      [orderId, String(item.id), item.title, item.quantity, Math.round(parseFloat(item.price))],
    );
  }

  return orderId;
}

// Shopify's REST Admin API paginates via a `Link` response header rather than page
// numbers/offsets (order results aren't stably offsettable). Extracts the `rel="next"`
// URL, or null once there are no more pages.
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  if (!match) return null;
  const urlMatch = match.match(/<([^>]+)>/);
  return urlMatch ? urlMatch[1] : null;
}

// Verifies the callback query genuinely came from Shopify, per Shopify's documented
// algorithm: HMAC-SHA256 over the sorted, `&`-joined `key=value` pairs of every query
// param EXCEPT hmac/signature, keyed with our app's API secret, compared timing-safe.
function verifyCallbackHmac(query: Record<string, string>, secret: string): boolean {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("&");
  const computed = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const computedBuf = Buffer.from(computed, "utf8");
  const providedBuf = Buffer.from(hmac, "utf8");
  return computedBuf.length === providedBuf.length && crypto.timingSafeEqual(computedBuf, providedBuf);
}

export const shopifyConnector: OAuthConnector = {
  platform: "shopify",
  authType: "oauth",

  getAuthUrl(shopDomain: string, state: string): string {
    const { apiKey } = getCredentials();
    const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
    url.searchParams.set("client_id", apiKey);
    url.searchParams.set("scope", SHOPIFY_SCOPES);
    url.searchParams.set("redirect_uri", getRedirectUri());
    url.searchParams.set("state", state);
    return url.toString();
  },

  async handleCallback(query: Record<string, string>, _context: { clientId: string }) {
    const shop = query.shop;
    const code = query.code;
    if (!shop || !code) {
      throw new Error("Shopify callback missing shop or code query parameter");
    }
    if (!SHOP_DOMAIN_RE.test(shop)) {
      throw new Error("Shopify callback shop parameter is not a valid *.myshopify.com domain");
    }
    const { apiKey, apiSecret } = getCredentials();
    if (!verifyCallbackHmac(query, apiSecret)) {
      throw new Error("Shopify callback failed HMAC verification");
    }
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    });
    if (!res.ok) {
      throw new Error(`Shopify token exchange failed: ${res.status}`);
    }
    const body = (await res.json()) as { access_token: string };
    await registerWebhooks(shop, body.access_token);
    return { type: "connected", externalAccountId: shop, accessToken: body.access_token };
  },

  async sync(connectionId: string) {
    const connResult = await pool.query(
      "select client_id, access_token, external_account_id, last_synced_at from platform_connections where id = $1",
      [connectionId],
    );
    if (connResult.rowCount === 0) {
      throw new Error(`No connection found for id ${connectionId}`);
    }
    const conn = connResult.rows[0];
    const accessToken = decryptToken(conn.access_token);

    const params = new URLSearchParams({ status: "any", limit: "250" });
    if (conn.last_synced_at) {
      params.set("updated_at_min", new Date(conn.last_synced_at).toISOString());
    }

    let nextUrl: string | null = `https://${conn.external_account_id}/admin/api/2024-10/orders.json?${params}`;
    let recordsSynced = 0;

    while (nextUrl) {
      const res: Response = await fetch(nextUrl, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });
      if (!res.ok) {
        throw new Error(`Shopify orders fetch failed: ${res.status}`);
      }
      const body = (await res.json()) as { orders: ShopifyOrder[] };
      nextUrl = parseNextLink(res.headers.get("link"));

      for (const order of body.orders) {
        await upsertShopifyOrder(conn.client_id, connectionId, order);
        recordsSynced++;
      }
    }

    await pool.query("update platform_connections set last_synced_at = now(), status = 'connected' where id = $1 and status <> 'disconnected'", [connectionId]);
    return { recordsSynced };
  },

  async disconnect(connectionId: string) {
    await pool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
  },
};
