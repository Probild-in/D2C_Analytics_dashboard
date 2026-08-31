import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAccessibleClientIds } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";

const router = Router({ mergeParams: true });

async function assertClientAccess(userId: string, clientId: string) {
  const accessible = await getAccessibleClientIds(pool, userId);
  if (accessible === "all") return;
  if (!accessible.includes(clientId)) {
    throw new HttpError(404, "not_found", "Client not found");
  }
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    await assertClientAccess(req.auth!.userId, req.params.id);
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

export default router;
