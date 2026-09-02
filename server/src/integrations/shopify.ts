import type { Connector } from "./types.js";
import pool from "../db.js";
import { decryptToken } from "../lib/crypto.js";

const SHOPIFY_SCOPES = "read_orders,read_products,read_customers";

interface ShopifyOrder {
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
}

// Shopify's core Orders API only exposes financial_status/fulfillment_status/cancelled_at —
// it has no native concept of NDR/RTO/Out-for-Delivery. Those need a courier integration,
// which is explicitly out of scope. This maps what Shopify actually tells us onto the
// closest fit in the existing OrderStatus enum, rather than fabricating granularity we
// don't have.
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

export const shopifyConnector: Connector = {
  platform: "shopify",

  getAuthUrl(shopDomain: string, state: string): string {
    const { apiKey } = getCredentials();
    const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
    url.searchParams.set("client_id", apiKey);
    url.searchParams.set("scope", SHOPIFY_SCOPES);
    url.searchParams.set("redirect_uri", getRedirectUri());
    url.searchParams.set("state", state);
    return url.toString();
  },

  async handleCallback(query: Record<string, string>) {
    const shop = query.shop;
    const code = query.code;
    if (!shop || !code) {
      throw new Error("Shopify callback missing shop or code query parameter");
    }
    const { apiKey, apiSecret } = getCredentials();
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
    });
    if (!res.ok) {
      throw new Error(`Shopify token exchange failed: ${res.status}`);
    }
    const body = (await res.json()) as { access_token: string };
    return { externalAccountId: shop, accessToken: body.access_token };
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
    const res = await fetch(`https://${conn.external_account_id}/admin/api/2024-10/orders.json?${params}`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (!res.ok) {
      throw new Error(`Shopify orders fetch failed: ${res.status}`);
    }
    const body = (await res.json()) as { orders: ShopifyOrder[] };

    let recordsSynced = 0;
    for (const order of body.orders) {
      const status = mapOrderStatus(order);
      const paymentMethod = mapPaymentMethod(order.payment_gateway_names);
      const customerName = order.customer ? `${order.customer.first_name} ${order.customer.last_name}`.trim() : "Guest";

      const orderResult = await pool.query(
        `insert into shopify_orders
           (client_id, connection_id, shopify_order_id, customer_name, order_date, amount, status, payment_method, city, state, shopify_customer_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (connection_id, shopify_order_id)
         do update set customer_name = excluded.customer_name, amount = excluded.amount, status = excluded.status,
           payment_method = excluded.payment_method, city = excluded.city, state = excluded.state
         returning id`,
        [
          conn.client_id,
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
      recordsSynced++;
    }

    await pool.query("update platform_connections set last_synced_at = now() where id = $1", [connectionId]);
    return { recordsSynced };
  },

  async disconnect(connectionId: string) {
    await pool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
  },
};
