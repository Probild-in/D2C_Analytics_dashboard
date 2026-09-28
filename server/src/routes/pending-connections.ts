import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";
import { readPending, lockPendingForUpdate } from "../lib/pending-connections.js";
import { saveConnection } from "../lib/connection-store.js";
import { assertUnderMetaAccountLimit } from "../integrations/meta.js";

const router = Router();

router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const pending = await readPending(req.params.id);
    if (!pending) {
      throw new HttpError(404, "pending_expired", "This link expired, please connect again.");
    }
    if (pending.clientId) {
      try {
        await assertClientAccess(pool, req.auth!.userId, pending.clientId);
      } catch {
        throw new HttpError(404, "pending_expired", "This link expired, please connect again.");
      }
    }
    res.json({
      platform: pending.platform,
      clientId: pending.clientId,
      // Shopify's install-link claim (plan 5) has no candidates; omit rather than send [].
      ...(pending.payload.candidates ? { candidates: pending.payload.candidates } : {}),
      ...(pending.payload.shop ? { shop: pending.payload.shop } : {}),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/select", requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const pending = await lockPendingForUpdate(client, req.params.id);
    if (!pending) {
      throw new HttpError(404, "pending_expired", "This link expired, please connect again.");
    }
    if (!pending.clientId) {
      // A Shopify-style claim-only row (no client yet) has nothing to "select" — that's
      // the /claim action plan 5 adds, not this one.
      throw new HttpError(400, "wrong_pending_type", "This connection has no account choice to make.");
    }
    try {
      await assertClientAccess(pool, req.auth!.userId, pending.clientId);
    } catch {
      throw new HttpError(404, "pending_expired", "This link expired, please connect again.");
    }

    const externalAccountId = (req.body as { externalAccountId?: unknown }).externalAccountId;
    const candidate = pending.payload.candidates?.find((c) => c.id === externalAccountId);
    if (typeof externalAccountId !== "string" || !candidate) {
      throw new HttpError(400, "invalid_candidate", "That account wasn't one of the ones offered.");
    }

    // Re-check the limit here: handleCallback already checked it once before this pending
    // row was created, but another connection could have landed in the meantime.
    if (pending.platform === "meta") {
      try {
        await assertUnderMetaAccountLimit(pending.clientId);
      } catch (err) {
        throw new HttpError(403, "account_limit", err instanceof Error ? err.message : "Meta account limit reached");
      }
    }

    await saveConnection({
      clientId: pending.clientId,
      platform: pending.platform,
      externalAccountId: candidate.id,
      accessToken: pending.payload.accessToken,
      expiresAt: pending.payload.expiresAt,
      connectedBy: pending.teamMemberId ?? req.auth!.userId,
    });
    await client.query("delete from pending_connections where id = $1", [req.params.id]);
    await client.query("commit");

    res.json({ platform: pending.platform, status: "connected", externalAccountId: candidate.id });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.post("/:id/claim", requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const pending = await lockPendingForUpdate(client, req.params.id);
    if (!pending) {
      throw new HttpError(404, "pending_expired", "This link expired, please connect again.");
    }
    if (pending.clientId) {
      // A row created by Meta's picker (plan 4) already has a client — that's the
      // /select action, not this one.
      throw new HttpError(400, "wrong_pending_type", "This connection already knows its client.");
    }
    if (!pending.payload.shop) {
      // A claim-type row (clientId === null) with no shop in its payload isn't a real
      // Shopify install-link claim — there's nothing to claim. Can't happen through the
      // currently-shipped code paths, but fail loudly rather than saving an empty
      // externalAccountId.
      throw new HttpError(400, "wrong_pending_type", "This connection has no account choice to make.");
    }

    const chosenClientId = (req.body as { clientId?: unknown }).clientId;
    if (typeof chosenClientId !== "string" || !chosenClientId) {
      throw new HttpError(400, "invalid_client", "Choose which client this store belongs to.");
    }
    // Deliberately NOT rewritten to pending_expired: the person on this page already
    // knows the link is real (it loaded and showed a shop domain) — an access failure
    // here means they picked a client they don't have access to, which is worth saying
    // plainly, unlike plan 4's GET/select where the link's very existence must stay
    // undisclosed to an unauthorized prober.
    await assertClientAccess(pool, req.auth!.userId, chosenClientId);

    await saveConnection({
      clientId: chosenClientId,
      platform: pending.platform,
      externalAccountId: pending.payload.shop,
      accessToken: pending.payload.accessToken,
      expiresAt: pending.payload.expiresAt,
      connectedBy: req.auth!.userId,
    });
    await client.query("delete from pending_connections where id = $1", [req.params.id]);
    await client.query("commit");

    res.json({ platform: pending.platform, status: "connected", externalAccountId: pending.payload.shop });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

export default router;
