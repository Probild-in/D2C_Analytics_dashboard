import pool from "../db.js";
import { encryptToken, decryptToken } from "./crypto.js";

const EXPIRES_IN_MINUTES = 30;

export interface PendingPayload {
  accessToken: string;
  expiresAt?: Date;
  candidates?: { id: string; label: string }[];
  // Shopify's install-link claim (plan 5) only.
  shop?: string;
}

export interface PendingRow {
  platform: string;
  clientId: string | null;
  teamMemberId: string | null;
  payload: PendingPayload;
}

// Both nullable: Meta's ad-account picker knows both up front; Shopify's install-link
// claim (plan 5) knows neither until the user picks a client.
export async function createPending(
  platform: string,
  clientId: string | null,
  teamMemberId: string | null,
  payload: PendingPayload,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into pending_connections (platform, client_id, team_member_id, payload, expires_at)
     values ($1, $2, $3, $4, now() + interval '${EXPIRES_IN_MINUTES} minutes')
     returning id`,
    [platform, clientId, teamMemberId, encryptToken(JSON.stringify(payload))],
  );
  return result.rows[0].id;
}

// Returns null for a missing OR expired row — deliberately not distinguished (see the
// spec's error-handling section: a stale link should never confirm it was once valid).
// Does not delete an expired row; the caller (the route) owns deletion after a successful
// select/claim, and a separate sweep can clean up abandoned expired rows.
export async function readPending(id: string): Promise<PendingRow | null> {
  const result = await pool.query(
    `select platform, client_id, team_member_id, payload
     from pending_connections
     where id = $1 and expires_at > now()`,
    [id],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    platform: row.platform,
    clientId: row.client_id,
    teamMemberId: row.team_member_id,
    payload: JSON.parse(decryptToken(row.payload)) as PendingPayload,
  };
}

export async function deletePending(id: string): Promise<void> {
  await pool.query("delete from pending_connections where id = $1", [id]);
}
