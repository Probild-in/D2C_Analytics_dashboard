import express, { Router } from "express";
import pool from "../db.js";
import { verifyShopifyWebhookHmac, upsertShopifyOrder, type ShopifyOrder } from "../integrations/shopify.js";

const router = Router();

function getWebhookSecret(): string {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error("SHOPIFY_API_SECRET environment variable must be set");
  }
  return secret;
}

// Shopify's HMAC verification needs the raw, unparsed request body — this router is
// mounted in index.ts ahead of the global express.json() parser, and applies its own
// express.raw() here so req.body is a Buffer, not a parsed object.
router.use(express.raw({ type: "application/json" }));

router.post("/orders", async (req, res, next) => {
  try {
    const rawBody = req.body as Buffer;
    const hmacHeader = req.header("x-shopify-hmac-sha256");
    const shopDomain = req.header("x-shopify-shop-domain");

    if (!verifyShopifyWebhookHmac(rawBody, hmacHeader, getWebhookSecret())) {
      res.status(401).send();
      return;
    }
    if (!shopDomain) {
      res.status(400).send();
      return;
    }

    const connResult = await pool.query(
      "select id, client_id from platform_connections where platform = 'shopify' and external_account_id = $1 and status <> 'disconnected'",
      [shopDomain],
    );
    if (connResult.rowCount === 0) {
      // Most likely a stale subscription left behind by a store we're no longer
      // connected to. Shopify auto-disables a webhook after enough consecutive
      // non-2xx responses, which is the right outcome for an orphaned one.
      res.status(404).send();
      return;
    }

    const { id: connectionId, client_id: clientId } = connResult.rows[0];
    const order = JSON.parse(rawBody.toString("utf8")) as ShopifyOrder;
    await upsertShopifyOrder(clientId, connectionId, order);
    await pool.query("update platform_connections set last_synced_at = now() where id = $1", [connectionId]);
    res.status(200).send();
  } catch (err) {
    next(err);
  }
});

export default router;
