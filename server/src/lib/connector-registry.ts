import type { Connector } from "../integrations/types.js";
import { shopifyConnector } from "../integrations/shopify.js";

export const connectors: Record<string, Connector> = {
  shopify: shopifyConnector,
};
