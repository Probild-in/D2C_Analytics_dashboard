import type { CredentialsConnector } from "./types.js";
import { CredentialsRejectedError } from "./types.js";
import pool from "../db.js";
import { decryptToken } from "../lib/crypto.js";
import {
  getCarriers,
  getOrderShipmentDetails,
  pushOrderData,
  verifyCredentials,
  ShipwayAuthError,
  type ShipwayCarrier,
} from "./shipway-api.js";
import { mapShipwayStatus } from "./shipway-status.js";

// Same bounds as the Delhivery connector, for the same reason: one tracked order per
// HTTP call, so a large backlog must not make the hourly sync run unbounded.
const MAX_TRACKED_PER_SYNC = 200;
const SYNC_WINDOW_DAYS = 30;

const RECONNECT_MESSAGE = "Shipway rejected the stored username/licence key. Reconnect with current credentials.";

// Matches a Shopify order's tracking_company ("Delhivery Surface", "Bluedart") against
// Shipway's carrier list ("Delhivery", "Blue Dart") — case-insensitive containment in
// either direction, ignoring spaces, since neither side uses the other's exact labels.
export function matchCarrier(trackingCompany: string, carriers: ShipwayCarrier[]): ShipwayCarrier | null {
  const company = trackingCompany.toLowerCase().replace(/\s+/g, "");
  if (!company) return null;
  for (const carrier of carriers) {
    const name = carrier.name.toLowerCase().replace(/\s+/g, "");
    if (!name) continue;
    if (company.includes(name) || name.includes(company)) return carrier;
  }
  return null;
}

export const shipwayConnector: CredentialsConnector = {
  platform: "courier_shipway",
  authType: "credentials",

  async connectWithCredentials(_clientId, credentials) {
    // Whitelist to the two fields this connector uses; anything else is dropped.
    const username = (credentials.username ?? "").trim();
    const licenseKey = (credentials.licenseKey ?? "").trim();
    if (!username || !licenseKey) {
      throw new CredentialsRejectedError("Enter your Shipway username and licence key.");
    }
    // Checked against an endpoint that actually authenticates — /api/carriers answers
    // for junk credentials too, so validating there let bad keys show as "Connected".
    try {
      await verifyCredentials(username, licenseKey);
    } catch (err) {
      if (err instanceof ShipwayAuthError) {
        throw new CredentialsRejectedError(
          "Shipway rejected this username and licence key. Use the API username from Shipway (Settings → API, or your Shipway welcome email) — it may not be your login email.",
        );
      }
      throw err;
    }
    return { externalAccountId: username, accessToken: licenseKey, credentials: { username, licenseKey } };
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
      throw new Error("This Shipway connection has no stored credentials. Reconnect it.");
    }
    const { username, licenseKey } = JSON.parse(decryptToken(conn.credentials)) as {
      username: string;
      licenseKey: string;
    };

    // Candidate orders: any courier (Shipway is courier-agnostic, unlike the Delhivery
    // connector's company filter) with a tracking number, inside the recent window, that
    // either has no shipments row yet or has one this connection owns that isn't
    // terminal. Rows another courier connection owns are left alone.
    const candidates = await pool.query<{
      tracking_number: string;
      tracking_company: string | null;
      shopify_order_id: string;
      order_name: string | null;
      order_date: Date;
    }>(
      `select o.tracking_number, o.tracking_company, o.shopify_order_id, o.order_name, o.order_date
       from shopify_orders o
       left join shipments s on s.client_id = o.client_id and s.awb = o.tracking_number
       where o.client_id = $1
         and o.tracking_number is not null
         and o.order_date >= now() - ($3::int * interval '1 day')
         and (s.awb is null or (s.connection_id = $2 and s.status not in ('Delivered', 'RTO Delivered', 'Cancelled')))
       order by o.order_date desc
       limit $4`,
      [conn.client_id, connectionId, SYNC_WINDOW_DAYS, MAX_TRACKED_PER_SYNC],
    );

    // Fetched once per sync, only needed when an order still has to be pushed.
    let carriers: ShipwayCarrier[] | null = null;
    let recordsSynced = 0;

    for (const {
      tracking_number: awb,
      tracking_company: company,
      shopify_order_id: shopifyOrderId,
      order_name: orderName,
      order_date: orderedAt,
    } of candidates.rows) {
      // Shipway identifies an order by the merchant-facing order number the store (or its
      // Shipway/Shopify integration) pushed — e.g. "1114585" — not by Shopify's internal
      // numeric id. Try the order name first (minus Shopify's "#" prefix), then fall back
      // to the internal id for orders synced before order_name was captured.
      const lookupIds = [...new Set([orderName?.replace(/^#/, "").trim(), shopifyOrderId].filter((v): v is string => !!v))];

      let tracked = null;
      let matchedId = lookupIds[0];
      try {
        for (const candidateId of lookupIds) {
          tracked = await getOrderShipmentDetails(username, licenseKey, candidateId);
          if (tracked) {
            matchedId = candidateId;
            break;
          }
        }
      } catch (err) {
        if (err instanceof ShipwayAuthError) throw new Error(RECONNECT_MESSAGE);
        throw err;
      }

      if (!tracked) {
        // Shipway doesn't know this order yet — push it so tracking starts; it becomes
        // trackable on a later sync. No matching Shipway carrier means it can't be
        // pushed at all; skip without failing the sync.
        try {
          carriers ??= await getCarriers(username, licenseKey);
          const carrier = company ? matchCarrier(company, carriers) : null;
          if (carrier) {
            await pushOrderData(username, licenseKey, { carrierId: carrier.id, awb, orderId: matchedId });
          }
        } catch (err) {
          if (err instanceof ShipwayAuthError) throw new Error(RECONNECT_MESSAGE);
          console.warn(`Shipway: push failed for order ${matchedId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }

      const mapped = mapShipwayStatus(tracked.statusCode);
      if (!mapped) {
        console.warn(`Shipway: unrecognized status code treated as In Transit: ${tracked.statusCode}`);
      }
      await pool.query(
        `insert into shipments (client_id, connection_id, awb, order_ref, courier_name, status, destination_state, ordered_at)
         values ($1, $2, $3, $4, $5, $6, null, $7)
         on conflict (client_id, awb)
         do update set connection_id = excluded.connection_id, order_ref = excluded.order_ref,
           courier_name = excluded.courier_name, status = excluded.status, synced_at = now()`,
        // order_ref is deliberately the Shopify internal id, NOT the id Shipway was
        // looked up by: rto-status.ts joins shipments.order_ref = shopify_orders.
        // shopify_order_id, so storing Shipway's order number here would silently break
        // every RTO metric. destination_state stays null because Shipway's "to" field is
        // a city, and a city in a state column would corrupt geography grouping.
        [conn.client_id, connectionId, awb, shopifyOrderId, company ?? "Shipway", mapped ?? "In Transit", orderedAt],
      );
      recordsSynced++;
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
