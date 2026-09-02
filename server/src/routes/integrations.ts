import { Router } from "express";
import pool from "../db.js";
import { connectors } from "../lib/connector-registry.js";
import { verifyState } from "../lib/state-token.js";
import { encryptToken } from "../lib/crypto.js";

const router = Router();

router.get("/:platform/callback", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL;
  const platform = req.params.platform;
  const query = req.query as Record<string, string>;

  const redirectError = (message: string) => {
    const params = new URLSearchParams({ connection: "error", message });
    res.redirect(`${frontendUrl}/#/manage-clients?${params.toString()}`);
  };

  let statePayload;
  try {
    statePayload = await verifyState(query.state);
  } catch {
    redirectError("Invalid or expired connection request");
    return;
  }

  if (statePayload.platform !== platform) {
    redirectError("Platform mismatch");
    return;
  }

  if (statePayload.shopDomain && query.shop !== statePayload.shopDomain) {
    redirectError("Shop domain mismatch");
    return;
  }

  const connector = connectors[platform];
  if (!connector) {
    redirectError("Unknown platform");
    return;
  }

  try {
    const { externalAccountId, accessToken, refreshToken, expiresAt } = await connector.handleCallback(query, {
      clientId: statePayload.clientId,
    });
    await pool.query(
      `insert into platform_connections
         (client_id, platform, status, access_token, refresh_token, token_expires_at, external_account_id, connected_by)
       values ($1, $2, 'connected', $3, $4, $5, $6, $7)
       on conflict (client_id, platform, external_account_id)
       do update set status = 'connected', access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, token_expires_at = excluded.token_expires_at`,
      [
        statePayload.clientId,
        platform,
        encryptToken(accessToken),
        refreshToken ? encryptToken(refreshToken) : null,
        expiresAt ?? null,
        externalAccountId,
        statePayload.teamMemberId,
      ],
    );
    const params = new URLSearchParams({ connection: "success" });
    res.redirect(`${frontendUrl}/#/manage-clients?${params.toString()}`);
  } catch {
    redirectError("Failed to connect — please try again");
  }
});

export default router;
