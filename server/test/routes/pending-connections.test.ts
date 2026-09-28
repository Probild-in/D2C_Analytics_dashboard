import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";
import { createPending } from "../../src/lib/pending-connections.js";

const RIYA = "11111111-1111-1111-1111-111111111111";
const SCOPED = "22222222-2222-2222-2222-222222222222";
const token = () => signTestJwt({ sub: RIYA, email: "riya@agency.com" });

beforeEach(async () => {
  await resetTestDb();
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('${RIYA}', 'Riya Kapoor', 'riya@agency.com', 'owner', true),
     ('${SCOPED}', 'Scoped User', 'scoped@agency.com', 'team_member', false)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into plans (id, name, monthly_fee_inr, included_meta_accounts, included_google_accounts) values
     ('starter', 'Starter', 5000, 1, 1)`,
  );
  await testPool.query(
    `insert into subscriptions (client_id, plan_id, status) values ('abc-fashion', 'starter', 'active')`,
  );
});

describe("GET /api/connections/pending/:id", () => {
  it("returns the platform and candidates without the access token", async () => {
    const id = await createPending("meta", "abc-fashion", RIYA, {
      accessToken: "very-secret",
      candidates: [{ id: "act_1", label: "Main" }, { id: "act_2", label: "Retargeting" }],
    });
    const res = await request(app).get(`/api/connections/pending/${id}`).set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      platform: "meta",
      clientId: "abc-fashion",
      candidates: [{ id: "act_1", label: "Main" }, { id: "act_2", label: "Retargeting" }],
    });
    expect(JSON.stringify(res.body)).not.toContain("very-secret");
  });

  it("404s for an unknown or expired id", async () => {
    const res = await request(app)
      .get("/api/connections/pending/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("pending_expired");
  });

  it("404s for a user who cannot access the pending row's client", async () => {
    const id = await createPending("meta", "abc-fashion", RIYA, { accessToken: "x", candidates: [] });
    const res = await request(app)
      .get(`/api/connections/pending/${id}`)
      .set("Authorization", `Bearer ${signTestJwt({ sub: SCOPED, email: "scoped@agency.com" })}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/connections/pending/:id/select", () => {
  it("creates the connection with the chosen account and deletes the pending row", async () => {
    const id = await createPending("meta", "abc-fashion", RIYA, {
      accessToken: "chosen-token",
      candidates: [{ id: "act_1", label: "Main" }, { id: "act_2", label: "Retargeting" }],
    });
    const res = await request(app)
      .post(`/api/connections/pending/${id}/select`)
      .set("Authorization", `Bearer ${token()}`)
      .send({ externalAccountId: "act_2" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platform: "meta", status: "connected", externalAccountId: "act_2" });
    const conn = await testPool.query("select platform, external_account_id from platform_connections");
    expect(conn.rows).toEqual([{ platform: "meta", external_account_id: "act_2" }]);
    expect((await testPool.query("select 1 from pending_connections where id = $1", [id])).rowCount).toBe(0);
  });

  it("400s for an externalAccountId that wasn't one of the candidates", async () => {
    const id = await createPending("meta", "abc-fashion", RIYA, {
      accessToken: "x",
      candidates: [{ id: "act_1", label: "Main" }],
    });
    const res = await request(app)
      .post(`/api/connections/pending/${id}/select`)
      .set("Authorization", `Bearer ${token()}`)
      .send({ externalAccountId: "act_999" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_candidate");
    expect((await testPool.query("select 1 from platform_connections")).rowCount).toBe(0);
  });

  it("404s for an unknown or expired id", async () => {
    const res = await request(app)
      .post("/api/connections/pending/00000000-0000-0000-0000-000000000000/select")
      .set("Authorization", `Bearer ${token()}`)
      .send({ externalAccountId: "act_1" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("pending_expired");
  });

  it("enforces the Meta account limit at select time", async () => {
    await testPool.query(
      `insert into platform_connections (client_id, platform, status, external_account_id) values
       ('abc-fashion', 'meta', 'connected', 'act_existing')`,
    );
    const id = await createPending("meta", "abc-fashion", RIYA, {
      accessToken: "x",
      candidates: [{ id: "act_1", label: "Main" }],
    });
    const res = await request(app)
      .post(`/api/connections/pending/${id}/select`)
      .set("Authorization", `Bearer ${token()}`)
      .send({ externalAccountId: "act_1" });
    expect(res.status).toBe(403);
    expect((await testPool.query("select 1 from pending_connections where id = $1", [id])).rowCount).toBe(1);
  });

  it("404s for a user who cannot access the pending row's client", async () => {
    const id = await createPending("meta", "abc-fashion", RIYA, { accessToken: "x", candidates: [{ id: "act_1", label: "Main" }] });
    const res = await request(app)
      .post(`/api/connections/pending/${id}/select`)
      .set("Authorization", `Bearer ${signTestJwt({ sub: SCOPED, email: "scoped@agency.com" })}`)
      .send({ externalAccountId: "act_1" });
    expect(res.status).toBe(404);
  });
});
