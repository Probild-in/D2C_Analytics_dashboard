import type * as React from "react";
import { Megaphone, Search, ShoppingBag } from "lucide-react";

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

export interface PlatformMeta {
  key: string;
  label: string;
  description: string;
  icon: React.ElementType;
  input?: PlatformInput;
}

export const OAUTH_PLATFORMS: PlatformMeta[] = [
  {
    key: "shopify",
    label: "Shopify",
    description: "Orders, products and customers from the store",
    icon: ShoppingBag,
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
  },
  {
    key: "google",
    label: "Google Ads",
    description: "Campaigns and performance from Google Ads",
    icon: Search,
  },
];
