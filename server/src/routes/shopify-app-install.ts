import { Router } from "express";
import pool from "../db.js";
import { getShopifyAppInstallUrl, exchangeShopifyAppCode, getShopInfo } from "../integrations/shopify-app-oauth.js";
import { signState, verifyState } from "../lib/state-token.js";
import { normalizeShopDomain } from "../lib/shop-domain.js";
import { createSupabaseUser, deleteSupabaseUser, generateMagicLink } from "../lib/supabase-admin.js";
import { generateUniqueClientId, pickLogoColor } from "../lib/slug.js";
import { encryptToken, decryptToken } from "../lib/crypto.js";
import { createAppSubscription, getAppSubscription } from "../integrations/shopify-billing.js";
import { HttpError } from "../lib/http-error.js";

const SELF_SERVE_PLAN_IDS = ["small", "medium", "large"] as const;
type SelfServePlanId = (typeof SELF_SERVE_PLAN_IDS)[number];
function isSelfServePlanId(value: unknown): value is SelfServePlanId {
  return typeof value === "string" && (SELF_SERVE_PLAN_IDS as readonly string[]).includes(value);
}

const router = Router();

router.get("/install", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL;
  const shop = normalizeShopDomain(typeof req.query.shop === "string" ? req.query.shop : "");
  if (!shop) {
    const params = new URLSearchParams({ connection: "error", message: "That doesn't look like a Shopify store." });
    res.redirect(`${frontendUrl}/#/shopify-app/error?${params.toString()}`);
    return;
  }
  const state = await signState({ platform: "shopify-app-store", shopDomain: shop });
  res.redirect(getShopifyAppInstallUrl(shop, state));
});

router.get("/callback", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL;
  try {
    const { shop, accessToken } = await exchangeShopifyAppCode(req.query as Record<string, string>);
    await verifyState(req.query.state as string); // throws if the state is missing/expired/tampered

    // Reinstall: reuse the existing client rather than provisioning a duplicate.
    const existing = await pool.query<{ id: string }>("select id from clients where shopify_shop_domain = $1", [shop]);
    let clientId: string;
    if (existing.rowCount && existing.rowCount > 0) {
      clientId = existing.rows[0].id;
      // Refresh the stored access token (Shopify may have reissued one on reinstall).
      await pool.query(
        `update platform_connections set access_token = $1, status = 'connected' where client_id = $2 and platform = 'shopify'`,
        [encryptToken(accessToken), clientId],
      );
    } else {
      const shopInfo = await getShopInfo(shop, accessToken);
      const user = await createSupabaseUser(shopInfo.email);

      const dbClient = await pool.connect();
      try {
        await dbClient.query("BEGIN");
        clientId = await generateUniqueClientId(pool, shopInfo.name || shop);
        const logoColor = pickLogoColor(clientId);
        const logoInitial = (shopInfo.name || shop).trim().charAt(0).toUpperCase();

        await dbClient.query(
          `insert into team_members (id, name, email, role, all_client_access, account_type) values ($1, $2, $3, 'owner', false, 'self_serve_owner')`,
          [user.id, shopInfo.name || shop, shopInfo.email],
        );
        await dbClient.query(
          `insert into clients (id, name, category, logo_color, logo_initial, owner_id, shopify_shop_domain) values ($1, $2, 'Uncategorized', $3, $4, $5, $6)`,
          [clientId, shopInfo.name || shop, logoColor, logoInitial, user.id, shop],
        );
        await dbClient.query(`insert into team_member_clients (team_member_id, client_id) values ($1, $2)`, [user.id, clientId]);
        await dbClient.query(
          `insert into platform_connections (client_id, platform, external_account_id, access_token, status, connected_by) values ($1, 'shopify', $2, $3, 'connected', $4)`,
          [clientId, shop, encryptToken(accessToken), user.id],
        );
        await dbClient.query("COMMIT");
      } catch (err) {
        await dbClient.query("ROLLBACK");
        await deleteSupabaseUser(user.id);
        // A concurrent callback for the same brand-new shop that raced this one and won
        // can make this transaction fail on ANY of several unique constraints, depending
        // on exactly how the two requests interleave:
        //   - team_members.email (both flows read the same shop.email from Shopify; this
        //     insert runs FIRST and is the most likely one to collide, since the winner's
        //     row, once committed, makes every later attempt to insert that same email a
        //     duplicate — regardless of each attempt's own distinct Supabase user id)
        //   - clients.id (generateUniqueClientId's own existence check is a plain,
        //     unlocked SELECT — two concurrent callers can both compute the same
        //     candidate slug before either commits)
        //   - clients.shopify_shop_domain (the dedup column itself)
        // Matching on a specific constraint name is fragile here because which one fires
        // first depends on insert order and timing, not on which race actually happened.
        // Instead: on ANY unique-violation in this block, re-look-up the client by
        // shopify_shop_domain — if the winner's row is there, adopt its id rather than
        // erroring; if it isn't (a genuine, unrelated conflict), rethrow.
        const pgErr = err as { code?: string };
        if (pgErr.code === "23505") {
          const winner = await pool.query<{ id: string }>("select id from clients where shopify_shop_domain = $1", [shop]);
          if (winner.rowCount && winner.rowCount > 0) {
            clientId = winner.rows[0].id;
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      } finally {
        dbClient.release();
      }
    }

    const params = new URLSearchParams({ client: clientId });
    res.redirect(`${frontendUrl}/#/shopify-app/plans?${params.toString()}`);
  } catch (err) {
    const params = new URLSearchParams({ connection: "error", message: err instanceof Error ? err.message : "Something went wrong." });
    res.redirect(`${frontendUrl}/#/shopify-app/error?${params.toString()}`);
  }
});

router.post("/:clientId/subscribe", async (req, res, next) => {
  try {
    const { clientId } = req.params;
    const { planId } = req.body as { planId?: string };
    if (!isSelfServePlanId(planId)) {
      throw new HttpError(400, "invalid_plan", "planId must be one of: small, medium, large");
    }
    const connResult = await pool.query<{ external_account_id: string; access_token: string }>(
      `select external_account_id, access_token from platform_connections where client_id = $1 and platform = 'shopify'`,
      [clientId],
    );
    if (connResult.rowCount === 0) {
      throw new HttpError(404, "not_found", "No Shopify connection for this client");
    }
    const shop = connResult.rows[0].external_account_id;
    const accessToken = decryptToken(connResult.rows[0].access_token);
    const returnUrl = `${process.env.PUBLIC_API_URL}/api/shopify-app/billing-callback?client=${clientId}`;

    const { confirmationUrl, subscriptionGid } = await createAppSubscription(shop, accessToken, planId, returnUrl);

    // Accepted risk: if createAppSubscription succeeds above but this upsert then fails
    // (e.g. a transient DB error), the Shopify-side charge object exists with no local
    // record of it. Low real-world impact because confirmationUrl is only returned to the
    // caller AFTER this query succeeds (see res.json below) — if we throw here instead,
    // the merchant's browser never receives the confirmation link, so the charge can never
    // actually be approved and no money can move. Not fixed with retry/rollback logic here;
    // see this file's billing-callback handler for how a drifted gateway_subscription_id
    // (e.g. from a second /subscribe call overwriting this row before the first charge is
    // approved) is corrected using Shopify's own charge_id as the source of truth.
    await pool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id, billing_provider) values ($1, $2, 'pending', $3, 'shopify')
       on conflict (client_id) do update set plan_id = excluded.plan_id, status = 'pending', gateway_subscription_id = excluded.gateway_subscription_id, billing_provider = 'shopify'`,
      [clientId, planId, subscriptionGid],
    );

    res.json({ confirmationUrl });
  } catch (err) {
    next(err);
  }
});

router.get("/billing-callback", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL;
  const clientId = req.query.client as string;
  try {
    const subResult = await pool.query<{ gateway_subscription_id: string; email: string }>(
      `select s.gateway_subscription_id, tm.email from subscriptions s
       join clients c on c.id = s.client_id join team_members tm on tm.id = c.owner_id
       where s.client_id = $1 and s.billing_provider = 'shopify'`,
      [clientId],
    );
    if (subResult.rowCount === 0) {
      throw new Error("No pending Shopify subscription for this client");
    }
    const { gateway_subscription_id: storedSubscriptionGid, email } = subResult.rows[0];

    const connResult = await pool.query<{ external_account_id: string; access_token: string }>(
      `select external_account_id, access_token from platform_connections where client_id = $1 and platform = 'shopify'`,
      [clientId],
    );
    if (connResult.rowCount === 0) {
      throw new Error("No Shopify connection for this client");
    }
    const shop = connResult.rows[0].external_account_id;
    const accessToken = decryptToken(connResult.rows[0].access_token);

    // Shopify appends its own charge_id to the returnUrl on redirect — that, not whatever
    // gateway_subscription_id currently sits in the DB row, is the source of truth for WHICH
    // charge was just approved/declined. The row can drift to point at a DIFFERENT charge (e.g.
    // a second /subscribe call overwrote it before this first charge was approved), so when
    // charge_id is present we check THAT specific charge rather than trusting the stored one.
    // Fall back to the stored gateway_subscription_id only if charge_id is absent.
    const chargeId = typeof req.query.charge_id === "string" ? req.query.charge_id : undefined;
    const subscriptionGid = chargeId ? `gid://shopify/AppSubscription/${chargeId}` : storedSubscriptionGid;

    const { status } = await getAppSubscription(shop, accessToken, subscriptionGid);
    if (status !== "ACTIVE") {
      const params = new URLSearchParams({ client: clientId, billing: "declined" });
      res.redirect(`${frontendUrl}/#/shopify-app/plans?${params.toString()}`);
      return;
    }

    // Correct the stored row to point at whichever charge Shopify actually just approved,
    // even if it had drifted to a different (still-pending) charge via the race above.
    await pool.query("update subscriptions set status = 'active', gateway_subscription_id = $2 where client_id = $1", [clientId, subscriptionGid]);

    const { actionLink } = await generateMagicLink(email);
    res.redirect(actionLink);
  } catch (err) {
    const params = new URLSearchParams({ connection: "error", message: err instanceof Error ? err.message : "Something went wrong." });
    res.redirect(`${frontendUrl}/#/shopify-app/error?${params.toString()}`);
  }
});

export default router;
