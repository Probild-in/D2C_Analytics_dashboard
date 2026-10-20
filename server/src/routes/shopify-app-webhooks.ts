import express, { Router } from "express";
import crypto from "node:crypto";
import pool from "../db.js";
import { logger } from "../lib/logger.js";
import { deleteSupabaseUser } from "../lib/supabase-admin.js";

const router = Router();
router.use(express.raw({ type: "application/json" }));

function verifyWebhookHmac(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const secret = process.env.SHOPIFY_APP_STORE_CLIENT_SECRET;
  if (!secret) {
    throw new Error("SHOPIFY_APP_STORE_CLIENT_SECRET environment variable must be set");
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(signatureHeader, "utf8");
  return expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf);
}

router.post("/shop/redact", async (req, res, next) => {
  try {
    if (!verifyWebhookHmac(req.body as Buffer, req.header("x-shopify-hmac-sha256"))) {
      res.status(401).send();
      return;
    }
    const payload = JSON.parse((req.body as Buffer).toString("utf8")) as { shop_domain: string };

    // clients.owner_id -> team_members.id points the OPPOSITE direction from every other
    // FK referencing clients, so deleting the clients row below (which does cascade
    // everything that references IT: subscriptions, platform_connections,
    // team_member_clients, shopify_orders, etc.) does NOT remove the owner's own
    // team_members row or their Supabase auth account. Left alone, that's both a GDPR gap
    // (the owner's own PII survives a redact request) and a reinstall-breaking bug: Task
    // 5's install flow creates a brand-new team_members row keyed on the shop owner's
    // email on every fresh install, and if that email's old row is still sitting around
    // from a previous uninstall, the reinstall's insert collides on the unique email
    // constraint with no surviving clients row for the race-recovery logic to adopt.
    //
    // Single transaction so a failure partway through (e.g. the team_members delete)
    // can't leave the clients row gone but the owner row dangling in an inconsistent
    // state — same discipline as shopify-app-install.ts's own provisioning transaction.
    let ownerIdToPurge: string | null = null;
    const dbClient = await pool.connect();
    try {
      await dbClient.query("BEGIN");

      const clientResult = await dbClient.query<{ owner_id: string | null }>(
        "select owner_id from clients where shopify_shop_domain = $1",
        [payload.shop_domain],
      );
      const ownerId = clientResult.rows[0]?.owner_id ?? null;

      await dbClient.query("delete from clients where shopify_shop_domain = $1", [payload.shop_domain]);

      if (ownerId) {
        // Only ever remove the owner's team_members row when they are a self-serve
        // Shopify-App-Store owner with no remaining access to any other real client.
        // This guard must never fire for a genuine staff account (account_type =
        // 'staff', possibly with all_client_access = true or several
        // team_member_clients rows for other agency clients) — both conditions are
        // checked explicitly rather than assumed from context.
        const ownerResult = await dbClient.query<{ account_type: string }>(
          "select account_type from team_members where id = $1",
          [ownerId],
        );
        const remainingResult = await dbClient.query<{ count: number }>(
          "select count(*)::int as count from team_member_clients where team_member_id = $1",
          [ownerId],
        );
        // Defensive third check: today, an owner's team_members row can only ever be
        // clients.owner_id for the single client row just deleted above, so this count
        // should always be 0 by the time we get here. But nothing in the schema enforces
        // that one-owner-per-client-row invariant, and a future feature (e.g. an admin
        // "transfer ownership" flow) could let one team_members row end up as owner_id for
        // more than one clients row. Checking it explicitly — rather than trusting that
        // invariant to hold forever — means this guard can't delete an owner who still
        // legitimately owns another live client.
        const stillOwnsAnotherClientResult = await dbClient.query<{ count: number }>(
          "select count(*)::int as count from clients where owner_id = $1",
          [ownerId],
        );
        const isSelfServeOwner = ownerResult.rows[0]?.account_type === "self_serve_owner";
        const hasNoOtherClientAccess = (remainingResult.rows[0]?.count ?? 0) === 0;
        const ownsNoOtherClient = (stillOwnsAnotherClientResult.rows[0]?.count ?? 0) === 0;
        if (isSelfServeOwner && hasNoOtherClientAccess && ownsNoOtherClient) {
          await dbClient.query("delete from team_members where id = $1", [ownerId]);
          ownerIdToPurge = ownerId;
        }
      }

      await dbClient.query("COMMIT");
    } catch (err) {
      await dbClient.query("ROLLBACK");
      throw err;
    } finally {
      dbClient.release();
    }

    // Best-effort and deliberately outside the DB transaction: deleteSupabaseUser already
    // swallows its own errors (see supabase-admin.ts), and the DB-side redaction must not
    // be rolled back just because the external Supabase call has trouble.
    if (ownerIdToPurge) {
      await deleteSupabaseUser(ownerIdToPurge);
    }

    res.status(200).send();
  } catch (err) {
    next(err);
  }
});

router.post("/customers/data-request", async (req, res, next) => {
  try {
    if (!verifyWebhookHmac(req.body as Buffer, req.header("x-shopify-hmac-sha256"))) {
      res.status(401).send();
      return;
    }
    const payload = JSON.parse((req.body as Buffer).toString("utf8")) as { shop_domain: string; customer?: { id?: number } };
    // This app stores no customer data beyond what's embedded in synced shopify_orders rows
    // (customer_name, city, state — no separate customer record). There is nothing further
    // to export beyond what Shopify itself already has; acknowledge the request.
    logger.info(payload, "Shopify customers/data_request webhook received");
    res.status(200).send();
  } catch (err) {
    next(err);
  }
});

router.post("/customers/redact", async (req, res, next) => {
  try {
    if (!verifyWebhookHmac(req.body as Buffer, req.header("x-shopify-hmac-sha256"))) {
      res.status(401).send();
      return;
    }
    const payload = JSON.parse((req.body as Buffer).toString("utf8")) as { shop_domain: string; customer?: { id?: number } };
    logger.info(payload, "Shopify customers/redact webhook received");
    // No separate customer PII table to redact against for this data model today — flagged
    // explicitly, same discipline as this session's other best-effort external-payload
    // handlers, rather than silently claiming full compliance with no real redaction logic.
    res.status(200).send();
  } catch (err) {
    next(err);
  }
});

router.post("/app-subscriptions-update", async (req, res, next) => {
  try {
    if (!verifyWebhookHmac(req.body as Buffer, req.header("x-shopify-hmac-sha256"))) {
      res.status(401).send();
      return;
    }
    const payload = JSON.parse((req.body as Buffer).toString("utf8")) as {
      app_subscription: { admin_graphql_api_id: string; status: string };
    };
    const statusMap: Record<string, string> = { ACTIVE: "active", CANCELLED: "canceled", EXPIRED: "canceled", FROZEN: "past_due" };
    const newStatus = statusMap[payload.app_subscription.status];
    if (!newStatus) {
      res.status(200).send();
      return;
    }
    // billing_provider = 'shopify' is the load-bearing filter: without it, a gateway_subscription_id
    // string that happens to collide with a Razorpay-billed row's value would update the
    // wrong subscription.
    await pool.query(
      "update subscriptions set status = $1 where gateway_subscription_id = $2 and billing_provider = 'shopify'",
      [newStatus, payload.app_subscription.admin_graphql_api_id],
    );
    res.status(200).send();
  } catch (err) {
    next(err);
  }
});

export default router;
