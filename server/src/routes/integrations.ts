import { Router } from "express";
import { connectors } from "../lib/connector-registry.js";
import { verifyState } from "../lib/state-token.js";
import { saveConnection } from "../lib/connection-store.js";

const router = Router();

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
    const { externalAccountId, accessToken, refreshToken, expiresAt } = await connector.handleCallback(query, {
      clientId: statePayload.clientId,
    });
    await saveConnection({
      clientId: statePayload.clientId,
      platform,
      externalAccountId,
      accessToken,
      refreshToken,
      expiresAt,
      connectedBy: statePayload.teamMemberId,
    });
    const params = new URLSearchParams({ connection: "success" });
    res.redirect(`${frontendUrl}/#/manage-clients?${params.toString()}`);
  } catch {
    redirectError("Failed to connect — please try again");
  }
});

export default router;
