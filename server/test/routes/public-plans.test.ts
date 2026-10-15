import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { resetTestDb } from "../helpers/test-db.js";

describe("GET /api/plans", () => {
  it("returns every seeded plan with no authentication required", async () => {
    await resetTestDb();
    const res = await request(app).get("/api/plans");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);
    const small = res.body.find((p: { id: string }) => p.id === "small");
    expect(small).toMatchObject({
      id: "small",
      name: "Small",
      orderLimit: 300,
      monthlyFeeInr: 1499,
      includedMetaAccounts: 1,
      includedGoogleAccounts: 1,
      extraMetaAccountPriceInr: 499,
      extraGoogleAccountPriceInr: 499,
      extraShopifyStorePriceInr: 999,
    });
  });

  it("orders plans by monthly fee, cheapest first", async () => {
    await resetTestDb();
    const res = await request(app).get("/api/plans");
    expect(res.body.map((p: { id: string }) => p.id)).toEqual(["small", "medium", "large", "enterprise"]);
  });
});
