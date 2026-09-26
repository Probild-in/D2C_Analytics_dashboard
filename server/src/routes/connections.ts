import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";
import { connectors } from "../lib/connector-registry.js";
import { signState } from "../lib/state-token.js";
import { normalizeShopDomain } from "../lib/shop-domain.js";
import { saveConnection } from "../lib/connection-store.js";
import { createRateLimiter } from "../middleware/rate-limit.js";
import { CredentialsRejectedError } from "../integrations/types.js";

const router = Router({ mergeParams: true });

// 10 attempts per user per client per 10 minutes: enough for typos, too few for guessing.
const connectLimiter = createRateLimiter({ max: 10, windowMs: 10 * 60 * 1000 });

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    await assertClientAccess(pool, req.auth!.userId, req.params.id);
    const result = await pool.query(
      `select platform, status, external_account_id, last_synced_at, created_at
       from platform_connections where client_id = $1 order by created_at`,
      [req.params.id],
    );
    res.json(
      result.rows.map((r) => ({
        platform: r.platform,
        status: r.status,
        externalAccountId: r.external_account_id,
        lastSyncedAt: r.last_synced_at,
        createdAt: r.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.post("/:platform/authorize", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const platform = req.params.platform;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const connector = connectors[platform];
    if (!connector) {
      throw new HttpError(404, "unknown_platform", `No connector for platform ${platform}`);
    }
    if (connector.authType !== "oauth") {
      throw new HttpError(400, "wrong_auth_type", `${platform} connects with credentials, not OAuth`);
    }

    let shopDomain: string | undefined;
    if (platform === "shopify") {
      const rawShopDomain = (req.body as { shopDomain?: unknown }).shopDomain;
      const normalized = normalizeShopDomain(typeof rawShopDomain === "string" ? rawShopDomain : "");
      if (!normalized) {
        throw new HttpError(
          400,
          "invalid_shop_domain",
          "Enter your Shopify store name, like mystore or mystore.myshopify.com",
        );
      }
      shopDomain = normalized;
    }

    const state = await signState({
      clientId,
      platform,
      teamMemberId: req.auth!.userId,
      shopDomain,
    });
    const authorizeUrl = connector.getAuthUrl(shopDomain ?? clientId, state);
    res.json({ authorizeUrl });
  } catch (err) {
    next(err);
  }
});

router.post("/:platform/connect", requireAuth, connectLimiter, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const platform = req.params.platform;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const connector = connectors[platform];
    if (!connector) {
      throw new HttpError(404, "unknown_platform", `No connector for platform ${platform}`);
    }
    if (connector.authType !== "credentials") {
      throw new HttpError(400, "wrong_auth_type", `${platform} connects through a login redirect, not credentials`);
    }

    const credentials = (req.body as { credentials?: unknown }).credentials;
    if (!isStringMap(credentials)) {
      throw new HttpError(400, "invalid_credentials_payload", "credentials must be an object of text fields");
    }

    let result;
    try {
      result = await connector.connectWithCredentials(clientId, credentials);
    } catch (err) {
      if (err instanceof CredentialsRejectedError) {
        throw new HttpError(400, "credentials_rejected", err.message);
      }
      console.error(`Credential connect failed for ${platform}:`, err);
      throw new HttpError(
        502,
        "provider_unreachable",
        "Couldn't verify these credentials right now. Please try again in a moment.",
      );
    }

    await saveConnection({
      clientId,
      platform,
      externalAccountId: result.externalAccountId,
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      credentials: result.credentials,
      connectedBy: req.auth!.userId,
    });
    res.json({ platform, status: "connected", externalAccountId: result.externalAccountId });
  } catch (err) {
    next(err);
  }
});

router.delete("/:platform", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const platform = req.params.platform;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const connector = connectors[platform];
    if (!connector) {
      throw new HttpError(404, "unknown_platform", `No connector for platform ${platform}`);
    }

    const active = await pool.query(
      "select id from platform_connections where client_id = $1 and platform = $2 and status <> 'disconnected'",
      [clientId, platform],
    );
    if (active.rowCount === 0) {
      throw new HttpError(404, "not_connected", `No active ${platform} connection for this client`);
    }
    for (const row of active.rows) {
      await connector.disconnect(row.id);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
