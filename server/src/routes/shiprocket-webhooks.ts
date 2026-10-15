import { Router } from "express";
import pool from "../db.js";
import { parseWebhookEvent } from "../integrations/shiprocket-api.js";
import { upsertShiprocketShipment } from "../integrations/shiprocket.js";

const router = Router();

// Shiprocket's webhook system has no documented signature/HMAC mechanism — the connectionId
// in the URL itself (an unguessable UUID, configured in Shiprocket's dashboard under
// Settings > API > Webhooks) is the only practical safeguard their system supports.
// Shiprocket also supports an optional `x-api-key` header, checked here if configured.
router.post("/:connectionId/orders", async (req, res, next) => {
  try {
    const expectedKey = process.env.SHIPROCKET_WEBHOOK_API_KEY;
    if (expectedKey && req.header("x-api-key") !== expectedKey) {
      res.status(401).send();
      return;
    }

    const event = parseWebhookEvent(req.body);
    if (!event) {
      res.status(400).send();
      return;
    }

    const connResult = await pool.query(
      "select client_id from platform_connections where id = $1 and platform = 'courier_shiprocket' and status <> 'disconnected'",
      [req.params.connectionId],
    );
    if (connResult.rowCount === 0) {
      res.status(404).send();
      return;
    }
    const clientId = connResult.rows[0].client_id;

    // Best-effort enrichment: fill in the real order date from the matched Shopify order,
    // same as the poll path does, so this shipment sorts correctly in the sales trend
    // immediately rather than waiting for the next poll to backfill it.
    let createdAt: Date | null = null;
    if (event.orderRef) {
      const orderResult = await pool.query(
        "select order_date from shopify_orders where client_id = $1 and shopify_order_id = $2",
        [clientId, event.orderRef],
      );
      createdAt = orderResult.rows[0]?.order_date ?? null;
    }

    await upsertShiprocketShipment(
      clientId,
      req.params.connectionId,
      { awb: event.awb, courier: event.courier, status: event.status, deliveredAt: event.deliveredAt },
      { orderRef: event.orderRef, status: event.status, state: event.destinationState, createdAt },
    );

    res.status(200).send();
  } catch (err) {
    next(err);
  }
});

export default router;
