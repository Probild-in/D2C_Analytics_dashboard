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
  ])("rejects %j", (input) => {
    expect(normalizeShopDomain(input)).toBeNull();
  });
});
