import type { CredentialsConnector } from "./types.js";
import { CredentialsRejectedError } from "./types.js";
import pool from "../db.js";
import { decryptToken } from "../lib/crypto.js";
import { trackShipment, DelhiveryAuthError } from "./delhivery-api.js";
import { mapDelhiveryStatus } from "./delhivery-status.js";

// Bounds one hourly sync's work — Delhivery has no confirmed bulk endpoint, so this
// connector tracks one AWB per HTTP call; without a cap a client with a large backlog of
// Delhivery-flagged Shopify orders could make the hourly sync run very long.
const MAX_TRACKED_PER_SYNC = 200;
const TERMINAL_STATUSES = new Set(["Delivered", "RTO Delivered", "Cancelled"]);

const RECONNECT_MESSAGE = "Delhivery rejected the stored API token. Reconnect with a current token.";

export const delhiveryConnector: CredentialsConnector = {
  platform: "courier_delhivery",
  authType: "credentials",

  async connectWithCredentials(_clientId, credentials) {
    // Whitelist to just the one field this connector uses; anything else is dropped.
    const token = (credentials.token ?? "").trim();
    if (!token) {
      throw new CredentialsRejectedError("Enter your Delhivery API token.");
    }
    // Deliberately does NOT call Delhivery here: no endpoint is confirmed to validate a
    // token against (see the module header in delhivery-api.ts). The token is accepted as
    // entered; the first sync reveals whether it works and puts the connection in `error`
    // if not — the same outcome a live check would have produced, one cycle later.
    // externalAccountId is a fixed label, not derived from the token: unlike Shiprocket's
    // email or Shopify's shop domain, a Delhivery API token carries no human-readable
    // account identifier to show in the UI.
    return { externalAccountId: "delhivery-token", accessToken: token, credentials: { token } };
  },

  async sync(connectionId: string) {
    const connResult = await pool.query("select client_id, credentials from platform_connections where id = $1", [
      connectionId,
    ]);
    if (connResult.rowCount === 0) {
      throw new Error(`No connection found for id ${connectionId}`);
    }
    const conn = connResult.rows[0];
    if (!conn.credentials) {
      throw new Error("This Delhivery connection has no stored credentials. Reconnect it.");
    }
    const { token } = JSON.parse(decryptToken(conn.credentials)) as { token: string };

    // Discover candidate AWBs: Shopify orders for this client whose tracking company looks
    // like Delhivery, that either have no shipments row yet or whose existing row isn't
    // terminal — never AWBs synced by a different courier connection.
    const candidates = await pool.query<{ tracking_number: string; shopify_order_id: string }>(
      `select o.tracking_number, o.shopify_order_id
       from shopify_orders o
       left join shipments s on s.client_id = o.client_id and s.awb = o.tracking_number
       where o.client_id = $1
         and o.tracking_company ilike '%delhivery%'
         and o.tracking_number is not null
         and (s.awb is null or s.status not in ('Delivered', 'RTO Delivered', 'Cancelled'))
       order by o.order_date desc
       limit $2`,
      [conn.client_id, MAX_TRACKED_PER_SYNC],
    );

    const unmapped = new Set<string>();
    let recordsSynced = 0;

    for (const { tracking_number: awb, shopify_order_id: orderRef } of candidates.rows) {
      let tracked;
      try {
        tracked = await trackShipment(token, awb);
      } catch (err) {
        if (err instanceof DelhiveryAuthError) throw new Error(RECONNECT_MESSAGE);
        throw err;
      }
      if (!tracked) continue; // AWB not (yet) recognized by Delhivery — try again next sync

      const mapped = mapDelhiveryStatus(tracked.status);
      if (!mapped && tracked.status) unmapped.add(tracked.status);

      await pool.query(
        `insert into shipments (client_id, connection_id, awb, order_ref, courier_name, status, destination_state, ordered_at)
         values ($1, $2, $3, $4, 'Delhivery', $5, $6, now())
         on conflict (client_id, awb)
         do update set connection_id = excluded.connection_id, order_ref = excluded.order_ref,
           status = excluded.status, destination_state = excluded.destination_state, synced_at = now()`,
        [conn.client_id, connectionId, tracked.awb, orderRef, mapped ?? "In Transit", tracked.destinationState],
      );
      recordsSynced++;
    }

    if (unmapped.size > 0) {
      console.warn(`Delhivery: unrecognized status labels treated as In Transit: ${[...unmapped].join(", ")}`);
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
