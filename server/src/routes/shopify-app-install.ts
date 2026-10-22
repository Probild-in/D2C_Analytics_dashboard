import { Router } from "express";
import pool from "../db.js";
import { getShopifyAppInstallUrl, exchangeShopifyAppCode, getShopInfo } from "../integrations/shopify-app-oauth.js";
import { signState, verifyState } from "../lib/state-token.js";
import { normalizeShopDomain } from "../lib/shop-domain.js";
import { createSupabaseUser, deleteSupabaseUser, generateMagicLink } from "../lib/supabase-admin.js";
import { generateUniqueClientId, pickLogoColor } from "../lib/slug.js";
import { encryptToken, decryptToken } from "../lib/crypto.js";
import { createAppSubscription, getAppSubscription, PLAN_PRICES_USD } from "../integrations/shopify-billing.js";
import { HttpError } from "../lib/http-error.js";

const SELF_SERVE_PLAN_IDS = ["small", "medium", "large"] as const;
type SelfServePlanId = (typeof SELF_SERVE_PLAN_IDS)[number];
function isSelfServePlanId(value: unknown): value is SelfServePlanId {
  return typeof value === "string" && (SELF_SERVE_PLAN_IDS as readonly string[]).includes(value);
}

// 2 hours is a deliberate, documented TTL for both the "subscribe flow" and "billing
// callback" tokens below: long enough that a merchant who takes a while deciding on
// Shopify's own charge-approval screen (or picking a plan) isn't locked out, short enough
// to meaningfully bound exposure versus no expiry at all.
const SUBSCRIBE_FLOW_TOKEN_TTL = "2h";
const BILLING_CALLBACK_TOKEN_TTL = "2h";

const router = Router();

router.get("/install", async (req, res, next) => {
  try {
    const frontendUrl = process.env.FRONTEND_URL;
    const shop = normalizeShopDomain(typeof req.query.shop === "string" ? req.query.shop : "");
    if (!shop) {
      const params = new URLSearchParams({ connection: "error", message: "That doesn't look like a Shopify store." });
      res.redirect(`${frontendUrl}/#/shopify-app/error?${params.toString()}`);
      return;
    }
    const state = await signState({ platform: "shopify-app-store", shopDomain: shop });
    res.redirect(getShopifyAppInstallUrl(shop, state));
  } catch (err) {
    next(err);
  }
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
      // Scoped to the specific store this install is about (I5): a client can have more
      // than one Shopify connection (the extra_shopify_stores plan feature), so filtering
      // on client_id + platform alone would let this update hit an arbitrary other store.
      await pool.query(
        `update platform_connections set access_token = $1, status = 'connected'
         where client_id = $2 and platform = 'shopify'
           and external_account_id = (select shopify_shop_domain from clients where id = $2)`,
        [encryptToken(accessToken), clientId],
      );

      // Returning/already-paying merchant (I2): if this client already has an ACTIVE,
      // Shopify-billed subscription, log them straight back in instead of sending them
      // through the plan picker again — there is no password/OTP login flow in this app,
      // so a magic link is the only way back in.
      const activeSub = await pool.query(
        "select 1 from subscriptions where client_id = $1 and billing_provider = 'shopify' and status = 'active'",
        [clientId],
      );
      if (activeSub.rowCount && activeSub.rowCount > 0) {
        const ownerResult = await pool.query<{ email: string }>(
          "select tm.email from clients c join team_members tm on tm.id = c.owner_id where c.id = $1",
          [clientId],
        );
        if (ownerResult.rowCount && ownerResult.rowCount > 0) {
          const { actionLink } = await generateMagicLink(ownerResult.rows[0].email);
          res.redirect(actionLink);
          return;
        }
      }
      // No active subscription yet (brand new install, or a previous attempt never
      // completed billing) — fall through to the plan-picker redirect below.
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

    // Fresh or not-yet-subscribed client: send them to the plan picker, carrying a signed,
    // short-lived token scoping this specific /subscribe attempt to this specific clientId
    // (C2) — without it, anyone who can guess a clientId could POST /subscribe for ANY
    // client with a Shopify connection, including clients from the separate agency-connect
    // flow or ones on an active Razorpay plan.
    const subscribeToken = await signState({ platform: "shopify-app-store-subscribe", clientId }, SUBSCRIBE_FLOW_TOKEN_TTL);
    const params = new URLSearchParams({ client: clientId, token: subscribeToken });
    res.redirect(`${frontendUrl}/#/shopify-app/plans?${params.toString()}`);
  } catch (err) {
    const params = new URLSearchParams({ connection: "error", message: err instanceof Error ? err.message : "Something went wrong." });
    res.redirect(`${frontendUrl}/#/shopify-app/error?${params.toString()}`);
  }
});

// Public, unauthenticated plan listing for the Shopify App Store plan picker (I3) — mirrors
// public-plans.ts's query/response-shaping style, but reports the USD prices this app
// actually charges Shopify merchants (shopify-billing.ts's PLAN_PRICES_USD), not the INR
// figures Razorpay-billed clients see.
router.get("/plans", async (_req, res, next) => {
  try {
    const result = await pool.query<{ id: "small" | "medium" | "large"; name: string; order_limit: number | null }>(
      "select id, name, order_limit from plans where id in ('small', 'medium', 'large') order by monthly_fee_inr",
    );
    res.json(
      result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        orderLimit: r.order_limit,
        priceUsd: PLAN_PRICES_USD[r.id],
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.post("/:clientId/subscribe", async (req, res, next) => {
  try {
    const { clientId } = req.params;
    const { planId, token } = req.body as { planId?: string; token?: string };
    if (!isSelfServePlanId(planId)) {
      throw new HttpError(400, "invalid_plan", "planId must be one of: small, medium, large");
    }

    // C2: this endpoint is public and clientId is a guessable slug — the signed token
    // (minted only by /callback's redirect to the plan picker) is what actually proves
    // this request is for a client that just legitimately completed the Shopify install
    // flow, scoped to this exact clientId.
    let tokenValid = false;
    if (token) {
      try {
        const payload = await verifyState(token);
        tokenValid = payload.platform === "shopify-app-store-subscribe" && payload.clientId === clientId;
      } catch {
        tokenValid = false;
      }
    }
    if (!tokenValid) {
      throw new HttpError(401, "invalid_token", "This link has expired or is invalid. Please reinstall the app from Shopify to try again.");
    }

    // Defense in depth: even a leaked/forged-somehow token still can't touch a client that
    // isn't actually an App-Store-provisioned Shopify client.
    const clientResult = await pool.query<{ shopify_shop_domain: string | null }>(
      "select shopify_shop_domain from clients where id = $1",
      [clientId],
    );
    if (clientResult.rowCount === 0 || !clientResult.rows[0].shopify_shop_domain) {
      throw new HttpError(404, "not_found", "No Shopify-connected client found for this id");
    }

    // Refuse to touch a client that's billed through a different channel (e.g. an agency
    // client on an active Razorpay plan who separately connected Shopify for data sync).
    const existingSubResult = await pool.query<{ billing_provider: string }>(
      "select billing_provider from subscriptions where client_id = $1",
      [clientId],
    );
    if ((existingSubResult.rowCount ?? 0) > 0 && existingSubResult.rows[0].billing_provider === "razorpay") {
      throw new HttpError(409, "billing_provider_conflict", "This client is billed through a different channel and cannot be switched here.");
    }

    // I5: a client can have more than one Shopify connection (extra_shopify_stores) —
    // scope this lookup to the specific store this App-Store flow is about, not whichever
    // platform_connections row happens to sort first.
    const connResult = await pool.query<{ external_account_id: string; access_token: string }>(
      `select external_account_id, access_token from platform_connections
       where client_id = $1 and platform = 'shopify'
         and external_account_id = (select shopify_shop_domain from clients where id = $1)`,
      [clientId],
    );
    if (connResult.rowCount === 0) {
      throw new HttpError(404, "not_found", "No Shopify connection for this client");
    }
    const shop = connResult.rows[0].external_account_id;
    const accessToken = decryptToken(connResult.rows[0].access_token);

    // Separate, billing-scoped token embedded in the returnUrl (C1) — proves to
    // /billing-callback that the redirect it's about to receive really did originate from
    // a /subscribe call for this exact clientId, not a guessed-clientId request forged by
    // an attacker.
    const billingToken = await signState({ platform: "shopify-app-store-billing", clientId }, BILLING_CALLBACK_TOKEN_TTL);
    const returnUrl = `${process.env.PUBLIC_API_URL}/api/shopify-app/billing-callback?client=${clientId}&token=${encodeURIComponent(billingToken)}`;

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
    // C1: this endpoint is public and clientId is a guessable slug. Without the signed
    // token below, anyone who can guess a clientId could hit this endpoint directly and,
    // if that client's subscription happened to read ACTIVE, be handed a magic link that
    // logs them in as that merchant. The token (minted only by /subscribe, scoped to this
    // exact clientId) is what actually blocks that: forging one requires
    // STATE_SIGNING_SECRET, which is never exposed to any client.
    const token = typeof req.query.token === "string" ? req.query.token : undefined;
    if (!token) {
      throw new Error("Missing billing token");
    }
    let payload;
    try {
      payload = await verifyState(token);
    } catch {
      throw new Error("Invalid or expired billing token");
    }
    if (payload.platform !== "shopify-app-store-billing" || payload.clientId !== clientId) {
      throw new Error("Billing token does not match this client");
    }

    // REMOVED: the old fallback to whatever gateway_subscription_id currently sits in the
    // DB row when charge_id is absent. That fallback WAS the vulnerability — it let a
    // request with no charge_id at all ride on whatever subscription state happened to be
    // stored, with no proof the requester was ever involved in approving anything. The GID
    // to check is now always derived from Shopify's own charge_id.
    const chargeId = typeof req.query.charge_id === "string" ? req.query.charge_id : undefined;
    if (!chargeId) {
      throw new Error("Missing charge_id");
    }
    const subscriptionGid = `gid://shopify/AppSubscription/${chargeId}`;

    const subResult = await pool.query<{ email: string }>(
      `select tm.email from subscriptions s
       join clients c on c.id = s.client_id join team_members tm on tm.id = c.owner_id
       where s.client_id = $1 and s.billing_provider = 'shopify'`,
      [clientId],
    );
    if (subResult.rowCount === 0) {
      throw new Error("No pending Shopify subscription for this client");
    }
    const { email } = subResult.rows[0];

    // I5: scope to the specific store this App-Store billing flow is about.
    const connResult = await pool.query<{ external_account_id: string; access_token: string }>(
      `select external_account_id, access_token from platform_connections
       where client_id = $1 and platform = 'shopify'
         and external_account_id = (select shopify_shop_domain from clients where id = $1)`,
      [clientId],
    );
    if (connResult.rowCount === 0) {
      throw new Error("No Shopify connection for this client");
    }
    const shop = connResult.rows[0].external_account_id;
    const accessToken = decryptToken(connResult.rows[0].access_token);

    const { status } = await getAppSubscription(shop, accessToken, subscriptionGid);
    if (status !== "ACTIVE") {
      // Mint a fresh subscribe-flow token so the merchant can retry picking a plan — this
      // request already proved its legitimacy via the billing token + charge_id checks
      // above, so re-minting here is safe, not a new trust decision. Without this, the
      // plan picker's choose() (which now requires a token) would silently no-op on a
      // decline, leaving a declined merchant with no way to retry short of uninstalling.
      const retryToken = await signState({ platform: "shopify-app-store-subscribe", clientId }, SUBSCRIBE_FLOW_TOKEN_TTL);
      const params = new URLSearchParams({ client: clientId, billing: "declined", token: retryToken });
      res.redirect(`${frontendUrl}/#/shopify-app/plans?${params.toString()}`);
      return;
    }

    // Atomic status transition: only flips a still-PENDING row, so a lost race or a
    // merchant double-clicking / Shopify redelivering the callback can't clobber a row an
    // earlier hit already activated. If this returns 0 rows, that's fine — the token +
    // charge_id checks above already proved this request is legitimate, so we still
    // proceed to the magic link rather than hard-failing.
    await pool.query(
      "update subscriptions set status = 'active', gateway_subscription_id = $2 where client_id = $1 and status = 'pending' returning id",
      [clientId, subscriptionGid],
    );

    const { actionLink } = await generateMagicLink(email);
    res.redirect(actionLink);
  } catch (err) {
    const params = new URLSearchParams({ connection: "error", message: err instanceof Error ? err.message : "Something went wrong." });
    res.redirect(`${frontendUrl}/#/shopify-app/error?${params.toString()}`);
  }
});

export default router;
