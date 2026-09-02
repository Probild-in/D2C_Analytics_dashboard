import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";
import { connectors } from "../lib/connector-registry.js";

const router = Router({ mergeParams: true });
const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000;

router.post("/:platform/sync", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    const platform = req.params.platform;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const connector = connectors[platform];
    if (!connector) {
      throw new HttpError(404, "unknown_platform", `No connector for platform ${platform}`);
    }

    const connResult = await pool.query(
      "select id, last_synced_at from platform_connections where client_id = $1 and platform = $2",
      [clientId, platform],
    );
    if (connResult.rowCount === 0) {
      throw new HttpError(404, "not_connected", `No ${platform} connection for this client`);
    }

    const { id, last_synced_at } = connResult.rows[0];
    if (last_synced_at && Date.now() - new Date(last_synced_at).getTime() < MIN_SYNC_INTERVAL_MS) {
      throw new HttpError(429, "sync_rate_limited", "This connection was synced less than 5 minutes ago");
    }

    const result = await connector.sync(id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
