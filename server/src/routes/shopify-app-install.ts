import { Router } from "express";
import pool from "../db.js";
import { getShopifyAppInstallUrl, exchangeShopifyAppCode, getShopInfo } from "../integrations/shopify-app-oauth.js";
import { signState, verifyState } from "../lib/state-token.js";
import { normalizeShopDomain } from "../lib/shop-domain.js";
import { createSupabaseUser, deleteSupabaseUser } from "../lib/supabase-admin.js";
import { generateUniqueClientId, pickLogoColor } from "../lib/slug.js";
import { encryptToken } from "../lib/crypto.js";

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
      const dbClient = await pool.connect();
      try {
        await dbClient.query("BEGIN");
        clientId = await generateUniqueClientId(pool, shopInfo.name || shop);
        const logoColor = pickLogoColor(clientId);
        const logoInitial = (shopInfo.name || shop).trim().charAt(0).toUpperCase();

        const user = await createSupabaseUser(shopInfo.email);

        try {
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

export default router;
