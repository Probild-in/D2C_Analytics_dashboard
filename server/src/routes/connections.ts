import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";
import { connectors } from "../lib/connector-registry.js";
import { signState } from "../lib/state-token.js";

const router = Router({ mergeParams: true });

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

    const shopDomain = (req.body as { shopDomain?: string }).shopDomain;
    if (platform === "shopify" && !/^[a-z0-9-]+\.myshopify\.com$/.test(shopDomain ?? "")) {
      throw new HttpError(400, "invalid_shop_domain", "shopDomain must be a valid *.myshopify.com domain");
    }

    const state = await signState({
      clientId,
      platform,
      teamMemberId: req.auth!.userId,
      shopDomain: platform === "shopify" ? shopDomain : undefined,
    });
    const authorizeUrl = connector.getAuthUrl(shopDomain ?? clientId, state);
    res.json({ authorizeUrl });
  } catch (err) {
    next(err);
  }
});

export default router;
