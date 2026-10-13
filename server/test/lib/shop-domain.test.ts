import { describe, it, expect } from "vitest";
import { normalizeShopDomain } from "../../src/lib/shop-domain.js";

describe("normalizeShopDomain", () => {
  it.each([
    ["mystore", "mystore.myshopify.com"],
    ["MyStore", "mystore.myshopify.com"],
    ["  mystore  ", "mystore.myshopify.com"],
    ["my-store-2", "my-store-2.myshopify.com"],
    ["mystore.myshopify.com", "mystore.myshopify.com"],
    ["MyStore.MyShopify.com", "mystore.myshopify.com"],
    ["https://mystore.myshopify.com", "mystore.myshopify.com"],
    ["https://mystore.myshopify.com/admin/products", "mystore.myshopify.com"],
    ["mystore.myshopify.com/admin", "mystore.myshopify.com"],
    ["admin.shopify.com/store/mystore", "mystore.myshopify.com"],
    ["https://admin.shopify.com/store/mystore/products?x=1", "mystore.myshopify.com"],
    // Fully uppercase domain: confirms normalization lowercases the whole host, not just
    // the handle portion (actual behavior of the `raw = input.trim().toLowerCase()` step).
    ["MYSTORE.MYSHOPIFY.COM", "mystore.myshopify.com"],
    // Leading/trailing slash: these are NOT rejected. The WHATWG URL parser collapses the
    // extra slash into the authority/path separator before `.hostname` is read, so both
    // resolve to the same legitimate host rather than being treated as hostile input.
    // Verified directly: `new URL("https:///mystore.myshopify.com").hostname` ===
    // "mystore.myshopify.com". This is current, confirmed behavior, not an assumption.
    ["/mystore.myshopify.com", "mystore.myshopify.com"],
    ["mystore.myshopify.com/", "mystore.myshopify.com"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeShopDomain(input)).toBe(expected);
  });

  it.each([
    [""],
    ["   "],
    ["my store"],
    ["https://evil.example.com"],
    ["evil.com/mystore.myshopify.com"],
    ["mystore.myshopify.com.evil.com"],
    ["mystore.myshopify.com@evil.com"],
    ["-mystore"],
    ["shopify.com"],
    // Embedded whitespace inside the domain itself (not just leading/trailing, which
    // .trim() already handles) — neither HANDLE_RE nor the URL-hostname path accepts it.
    ["my store.myshopify.com"],
    ["mystore .myshopify.com"],
    // HTML/script injection characters: `<`, `>`, `(`, `)` are not valid in a bare handle
    // and make `new URL(...)` either throw or produce a hostname that fails SHOP_DOMAIN_RE.
    ["<script>alert(1)</script>"],
    ["mystore<script>.myshopify.com"],
    // Non-Shopify domain impersonating a Shopify one via a path segment: the real host is
    // evil.com, with "x.myshopify.com" just a path component. `new URL(...).hostname` is
    // "evil.com" (which fails SHOP_DOMAIN_RE), so this is correctly rejected — confirmed
    // directly, not assumed.
    ["evil.com/x.myshopify.com"],
  ])("rejects %j", (input) => {
    expect(normalizeShopDomain(input)).toBeNull();
  });
});
