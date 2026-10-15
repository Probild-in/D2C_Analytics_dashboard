import { Router } from "express";
import pool from "../db.js";
import { upsertDelhiveryShipment } from "../integrations/delhivery.js";

const router = Router();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

// Confirmed payload shape (Delhivery's own webhook docs):
// { "Shipment": { "Status": { "Status": "...", "StatusDateTime": "..." }, "ReferenceNo": "...", "AWB": "..." } }
// Delhivery's webhook system has no documented signature/HMAC mechanism — the connectionId
// in the URL itself (an unguessable UUID, configured when registering with Delhivery) is
// the only practical safeguard their system supports.
router.post("/:connectionId/orders", async (req, res, next) => {
  try {
    const body = req.body as unknown;
    const shipment = isRecord(body) && isRecord(body.Shipment) ? body.Shipment : null;
    const status = shipment && isRecord(shipment.Status) ? shipment.Status : null;

    const awb = shipment ? asString(shipment.AWB) : null;
    if (!awb) {
      res.status(400).send();
      return;
    }

    const connResult = await pool.query(
      "select client_id from platform_connections where id = $1 and platform = 'courier_delhivery' and status <> 'disconnected'",
      [req.params.connectionId],
    );
    if (connResult.rowCount === 0) {
      // Stale/orphaned webhook registration — nothing to do. 404 rather than 200 so this
      // surfaces instead of silently accepting events for a connection that no longer exists.
      res.status(404).send();
      return;
    }
    const clientId = connResult.rows[0].client_id;
    const orderRef = asString(shipment?.ReferenceNo);
    const statusDateTime = status ? asString(status.StatusDateTime) : null;

    // Best-effort enrichment: fill in the real order date from the matched Shopify order,
    // same as the poll path does, so this shipment sorts correctly in the sales trend
    // immediately rather than waiting for the next poll to backfill it.
    let orderedAt: Date | null = null;
    if (orderRef) {
      const orderResult = await pool.query(
        "select order_date from shopify_orders where client_id = $1 and shopify_order_id = $2",
        [clientId, orderRef],
      );
      orderedAt = orderResult.rows[0]?.order_date ?? null;
    }
    if (!orderedAt && statusDateTime) {
      const parsed = new Date(statusDateTime);
      orderedAt = Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    await upsertDelhiveryShipment(clientId, req.params.connectionId, {
      awb,
      orderRef,
      status: status ? asString(status.Status) : null,
      destinationState: status ? asString(status.StatusLocation) : null,
      orderedAt,
    });

    res.status(200).send();
  } catch (err) {
    next(err);
  }
});

export default router;
