import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into platform_connections (id, client_id, platform, status, external_account_id) values
     ('55555555-5555-5555-5555-555555555555', 'abc-fashion', 'meta', 'connected', 'act_123')`,
  );
  await testPool.query(
    `insert into campaigns (id, client_id, connection_id, external_campaign_id, name, status) values
     ('66666666-6666-6666-6666-666666666666', 'abc-fashion', '55555555-5555-5555-5555-555555555555', 'camp_1', 'Diwali Sale', 'active')`,
  );
  await testPool.query(
    `insert into meta_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, results) values
     ('abc-fashion', '55555555-5555-5555-5555-555555555555', 'camp_1', 'Diwali Sale', current_date, 500, 10000, 250, 12),
     ('abc-fashion', '55555555-5555-5555-5555-555555555555', 'camp_1', 'Diwali Sale', current_date - 1, 300, 6000, 150, 8)`,
  );
  await testPool.query(
    `insert into campaign_creatives (id, campaign_id, external_creative_id, name, format, headline, cta, thumbnail_url, status, spend, impressions, clicks, results, hook_rate, launched_date) values
     ('77777777-7777-7777-7777-777777777777', '66666666-6666-6666-6666-666666666666', 'creative_1', 'Diwali Carousel', 'CAROUSEL', '50% Off', 'SHOP_NOW', 'https://cdn.example.com/x.jpg', 'active', 120, 3000, 80, 4, 32.5, '2026-08-15')`,
  );
});

describe("GET /api/clients/:id/campaigns", () => {
  it("returns campaigns with metrics summed across all synced days", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/campaigns?platform=meta")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: "66666666-6666-6666-6666-666666666666",
      name: "Diwali Sale",
      status: "Active",
      spend: 800,
      impressions: 16000,
      clicks: 400,
      results: 20,
      roas: 0,
    });
    expect(res.body[0].ctr).toBeCloseTo((400 / 16000) * 100, 1);
  });

  it("404s for a client the user cannot access", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('22222222-2222-2222-2222-222222222222', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
    );
    const token = signTestJwt({ sub: "22222222-2222-2222-2222-222222222222", email: "scoped@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/campaigns?platform=meta")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/clients/:id/campaigns/:campaignId/creatives", () => {
  it("returns creatives for the campaign", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .get("/api/clients/abc-fashion/campaigns/66666666-6666-6666-6666-666666666666/creatives")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      name: "Diwali Carousel",
      format: "CAROUSEL",
      thumbnailUrl: "https://cdn.example.com/x.jpg",
      status: "Active",
      hookRate: 32.5,
      holdRate: null,
      roas: 0,
      launchedDate: "2026-08-15",
    });
  });
});

describe("GET/POST /api/clients/:id/campaigns/:campaignId/notes", () => {
  it("returns an empty array with no notes, then the created note after posting", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const listBefore = await request(app)
      .get("/api/clients/abc-fashion/campaigns/66666666-6666-6666-6666-666666666666/notes")
      .set("Authorization", `Bearer ${token}`);
    expect(listBefore.status).toBe(200);
    expect(listBefore.body).toEqual([]);

    const created = await request(app)
      .post("/api/clients/abc-fashion/campaigns/66666666-6666-6666-6666-666666666666/notes")
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Great CTR this week, let's scale budget." });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ author: "Riya Kapoor", message: "Great CTR this week, let's scale budget." });

    const listAfter = await request(app)
      .get("/api/clients/abc-fashion/campaigns/66666666-6666-6666-6666-666666666666/notes")
      .set("Authorization", `Bearer ${token}`);
    expect(listAfter.body).toHaveLength(1);
  });

  it("400s for an empty note body", async () => {
    const token = signTestJwt({ sub: "11111111-1111-1111-1111-111111111111", email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/campaigns/66666666-6666-6666-6666-666666666666/notes")
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "   " });
    expect(res.status).toBe(400);
  });
});
