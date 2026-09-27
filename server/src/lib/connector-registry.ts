import type { Connector } from "../integrations/types.js";
import { shopifyConnector } from "../integrations/shopify.js";
import { metaConnector } from "../integrations/meta.js";
import { googleConnector } from "../integrations/google.js";
import { shiprocketConnector } from "../integrations/shiprocket.js";
import { delhiveryConnector } from "../integrations/delhivery.js";

export const connectors: Record<string, Connector> = {
  shopify: shopifyConnector,
  meta: metaConnector,
  google: googleConnector,
  courier_shiprocket: shiprocketConnector,
  courier_delhivery: delhiveryConnector,
};
