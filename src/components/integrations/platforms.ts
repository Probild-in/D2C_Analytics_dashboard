import type * as React from "react";
import { Megaphone, Search, ShoppingBag, Truck } from "lucide-react";

export interface Connection {
  platform: string;
  status: "connected" | "disconnected" | "error";
  externalAccountId: string;
  lastSyncedAt: string | null;
}

// Some OAuth platforms need one piece of input before the redirect (Shopify: which store).
export interface PlatformInput {
  placeholder: string;
  helper: string;
  // Field name the backend's /authorize endpoint expects in the JSON body.
  bodyKey: string;
}

// One field of a credentials form. `name` is the key sent to the backend's /connect endpoint.
export interface CredentialField {
  name: string;
  label: string;
  type: "text" | "email" | "password";
  placeholder?: string;
}

export interface PlatformMeta {
  key: string;
  label: string;
  description: string;
  icon: React.ElementType;
  authType: "oauth" | "credentials";
  // oauth platforms that need input before the redirect
  input?: PlatformInput;
  // credentials platforms: the form to show
  fields?: CredentialField[];
  // credentials platforms: help text shown above the form
  helper?: string;
}

export const PLATFORMS: PlatformMeta[] = [
  {
    key: "shopify",
    label: "Shopify",
    description: "Orders, products and customers from the store",
    icon: ShoppingBag,
    authType: "oauth",
    input: {
      placeholder: "yourstore",
      helper: "Just the store name is fine, e.g. mystore. Pasting the admin URL works too.",
      bodyKey: "shopDomain",
    },
  },
  {
    key: "meta",
    label: "Meta Ads",
    description: "Campaigns and creatives from Meta Business Manager",
    icon: Megaphone,
    authType: "oauth",
  },
  {
    key: "google",
    label: "Google Ads",
    description: "Campaigns and performance from Google Ads",
    icon: Search,
    authType: "oauth",
  },
  {
    key: "courier_shiprocket",
    label: "Shiprocket",
    description: "Shipments, delivery status, NDR and RTO by courier",
    icon: Truck,
    authType: "credentials",
    helper:
      "Create a separate API user in Shiprocket (Settings → API → Create API User) and enter its email and password here. Your main Shiprocket login won't work.",
    fields: [
      { name: "email", label: "API user email", type: "email", placeholder: "api-user@yourbrand.com" },
      { name: "password", label: "API user password", type: "password" },
    ],
  },
  {
    key: "courier_delhivery",
    label: "Delhivery",
    description: "Shipments, delivery status, NDR and RTO by courier",
    icon: Truck,
    authType: "credentials",
    helper:
      "Paste your Delhivery API token (from the Delhivery portal). Delhivery has no bulk order list, so shipments are matched from the tracking numbers your Shopify orders already carry — connect Shopify first for this to find anything.",
    fields: [{ name: "token", label: "API token", type: "password" }],
  },
];

// A client can have several rows per platform over time (reconnects, old disconnects).
// Show the live one; otherwise the broken one; otherwise the most recent.
export function pickConnection(connections: Connection[], platform: string): Connection | undefined {
  const forPlatform = connections.filter((c) => c.platform === platform);
  return (
    forPlatform.find((c) => c.status === "connected") ??
    forPlatform.find((c) => c.status === "error") ??
    forPlatform[forPlatform.length - 1]
  );
}
