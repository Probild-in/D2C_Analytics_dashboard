import { Router } from "express";
import { connectors } from "../lib/connector-registry.js";
import { signState, verifyState } from "../lib/state-token.js";
import { saveConnection } from "../lib/connection-store.js";
import { createPending } from "../lib/pending-connections.js";
import { normalizeShopDomain } from "../lib/shop-domain.js";

const router = Router();

router.get("/shopify/install", async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL;
  const shop = normalizeShopDomain(typeof req.query.shop === "string" ? req.query.shop : "");
  if (!shop) {
    const params = new URLSearchParams({
      connection: "error",
      message: "That doesn't look like a Shopify store. Check the link and try again.",
    });
    res.redirect(`${frontendUrl}/#/manage-clients?${params.toString()}`);
    return;
  }

  const connector = connectors.shopify;
  if (connector.authType !== "oauth") {
    const params = new URLSearchParams({
      connection: "error",
      message: "Shopify connections are temporarily unavailable. Please try again later.",
    });
    res.redirect(`${frontendUrl}/#/manage-clients?${params.toString()}`);
    return;
  }
  const state = await signState({ platform: "shopify", shopDomain: shop });
  res.redirect(connector.getAuthUrl(shop, state));
});

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
  if (connector.authType !== "oauth") {
    redirectError("This platform does not use OAuth");
    return;
  }

  try {
    const result = await connector.handleCallback(query, { clientId: statePayload.clientId });

    if (result.type === "connected") {
      await saveConnection({
        clientId: statePayload.clientId,
        platform,
        externalAccountId: result.externalAccountId,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        connectedBy: statePayload.teamMemberId,
      });
      const params = new URLSearchParams({ connection: "success" });
      res.redirect(`${frontendUrl}/#/manage-clients?${params.toString()}`);
      return;
    }

    // type === "pending": the client and team member are already known from the state
    // token (this is Meta's multi-account case, not Shopify's install-link claim, which
    // has neither — plan 5 creates its own pending rows directly, not through this route).
    const pendingId = await createPending(platform, statePayload.clientId, statePayload.teamMemberId, {
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
      candidates: result.candidates,
    });
    const params = new URLSearchParams({ pending: pendingId });
    res.redirect(`${frontendUrl}/#/connect/pick-accounts?${params.toString()}`);
  } catch {
    redirectError("Failed to connect — please try again");
  }
});

export default router;
