import pool from "../db.js";
import { encryptToken } from "./crypto.js";

export interface SaveConnectionInput {
  clientId: string;
  platform: string;
  externalAccountId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  // Encrypted as one JSON blob into platform_connections.credentials.
  credentials?: Record<string, string>;
  connectedBy: string;
}

// The one place a successful connect (OAuth callback or credentials form) is persisted.
// Reconnecting the same external account updates the existing row instead of duplicating it.
export async function saveConnection(input: SaveConnectionInput): Promise<void> {
  await pool.query(
    `insert into platform_connections
       (client_id, platform, status, access_token, refresh_token, token_expires_at, external_account_id, credentials, connected_by)
     values ($1, $2, 'connected', $3, $4, $5, $6, $7, $8)
     on conflict (client_id, platform, external_account_id)
     do update set status = 'connected', access_token = excluded.access_token,
       refresh_token = excluded.refresh_token, token_expires_at = excluded.token_expires_at,
       credentials = excluded.credentials`,
    [
      input.clientId,
      input.platform,
      encryptToken(input.accessToken),
      input.refreshToken ? encryptToken(input.refreshToken) : null,
      input.expiresAt ?? null,
      input.externalAccountId,
      input.credentials ? encryptToken(JSON.stringify(input.credentials)) : null,
      input.connectedBy,
    ],
  );
}
