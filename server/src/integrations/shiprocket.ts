import type { CredentialsConnector } from "./types.js";
import { CredentialsRejectedError } from "./types.js";
import pool from "../db.js";
import { decryptToken } from "../lib/crypto.js";
import { fetchOrdersPage, shiprocketLogin, ShiprocketAuthError, type ShiprocketOrdersPage } from "./shiprocket-api.js";
import { mapShiprocketStatus } from "./shiprocket-status.js";

const SYNC_WINDOW_DAYS = 30;
const PER_PAGE = 100;
// Hard stop against a runaway pagination loop: 50 pages x 100 orders.
const MAX_PAGES = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const RECONNECT_MESSAGE = "Shiprocket rejected the stored credentials. Reconnect with the API user's current password.";

export const shiprocketConnector: CredentialsConnector = {
  platform: "courier_shiprocket",
  authType: "credentials",

  async connectWithCredentials(_clientId, credentials) {
    // Whitelist the two fields we use; anything else the browser sent is dropped, never stored.
    const email = (credentials.email ?? "").trim().toLowerCase();
    const password = credentials.password ?? "";
    if (!email || !password.trim()) {
      throw new CredentialsRejectedError("Enter both the API user's email and password.");
    }

    let token: string;
    try {
      token = await shiprocketLogin(email, password);
    } catch (err) {
      if (err instanceof ShiprocketAuthError) {
        throw new CredentialsRejectedError(
          "Shiprocket rejected these credentials. Use the API user's email and password (Shiprocket → Settings → API), not your main login.",
        );
      }
      throw err;
    }
    // No expiresAt: every sync logs in fresh, so we never depend on this token's lifetime.
    return { externalAccountId: email, accessToken: token, credentials: { email, password } };
  },

  async sync(connectionId: string) {
    const connResult = await pool.query("select client_id, credentials from platform_connections where id = $1", [connectionId]);
    if (connResult.rowCount === 0) {
      throw new Error(`No connection found for id ${connectionId}`);
    }
    const conn = connResult.rows[0];
    if (!conn.credentials) {
      throw new Error("This Shiprocket connection has no stored credentials. Reconnect it.");
    }
    const { email, password } = JSON.parse(decryptToken(conn.credentials)) as { email: string; password: string };

    let token: string;
    try {
      token = await shiprocketLogin(email, password);
    } catch (err) {
      if (err instanceof ShiprocketAuthError) throw new Error(RECONNECT_MESSAGE);
      throw err;
    }

    // Orders arrive newest first. Non-terminal shipments older than the window are not
    // re-polled: an accepted gap for this version.
    const cutoff = Date.now() - SYNC_WINDOW_DAYS * DAY_MS;
    const unmapped = new Set<string>();
    let recordsSynced = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      let ordersPage: ShiprocketOrdersPage;
      try {
        ordersPage = await fetchOrdersPage(token, page, PER_PAGE);
      } catch (err) {
        if (err instanceof ShiprocketAuthError) throw new Error(RECONNECT_MESSAGE);
        throw err;
      }
      const { orders, totalPages } = ordersPage;

      for (const order of orders) {
        for (const shipment of order.shipments) {
          const rawStatus = shipment.status ?? order.status;
          const mapped = mapShiprocketStatus(rawStatus);
          if (!mapped && rawStatus) unmapped.add(rawStatus);

          await pool.query(
            `insert into shipments
               (client_id, connection_id, awb, order_ref, courier_name, status, destination_state, ordered_at, delivered_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             on conflict (connection_id, awb)
             do update set order_ref = excluded.order_ref, courier_name = excluded.courier_name,
               status = excluded.status, destination_state = excluded.destination_state,
               ordered_at = excluded.ordered_at, delivered_at = excluded.delivered_at, synced_at = now()`,
            [
              conn.client_id,
              connectionId,
              shipment.awb,
              order.orderRef,
              shipment.courier ?? "Unknown courier",
              mapped ?? "In Transit",
              order.state,
              order.createdAt,
              shipment.deliveredAt,
            ],
          );
          recordsSynced++;
        }
      }

      const pageIsEntirelyOld =
        orders.length > 0 && orders.every((o) => o.createdAt !== null && o.createdAt.getTime() < cutoff);
      if (orders.length === 0 || page >= totalPages || pageIsEntirelyOld) break;
    }

    if (unmapped.size > 0) {
      console.warn(`Shiprocket: unrecognized status labels treated as In Transit: ${[...unmapped].join(", ")}`);
    }

    await pool.query(
      "update platform_connections set last_synced_at = now(), status = 'connected' where id = $1 and status <> 'disconnected'",
      [connectionId],
    );
    return { recordsSynced };
  },

  async disconnect(connectionId: string) {
    await pool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
  },
};
