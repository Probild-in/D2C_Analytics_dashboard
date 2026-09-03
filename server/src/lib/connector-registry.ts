import type { Connector } from "../integrations/types.js";
import { shopifyConnector } from "../integrations/shopify.js";
import { metaConnector } from "../integrations/meta.js";
import { googleConnector } from "../integrations/google.js";

export const connectors: Record<string, Connector> = {
  shopify: shopifyConnector,
  meta: metaConnector,
  google: googleConnector,
};
