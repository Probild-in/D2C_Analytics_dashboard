import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { createPending, readPending, deletePending } from "../../src/lib/pending-connections.js";

beforeEach(async () => {
  await resetTestDb();
  process.env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
  );
});

describe("createPending / readPending", () => {
  it("round-trips a payload with client and team member known (Meta's case)", async () => {
    const id = await createPending("meta", "abc-fashion", "11111111-1111-1111-1111-111111111111", {
      accessToken: "secret-token",
      candidates: [{ id: "act_1", label: "Main" }],
    });
    const row = await readPending(id);
    expect(row).toEqual({
      platform: "meta",
      clientId: "abc-fashion",
      teamMemberId: "11111111-1111-1111-1111-111111111111",
      payload: { accessToken: "secret-token", candidates: [{ id: "act_1", label: "Main" }] },
    });
  });

  it("round-trips a payload with client and team member both null (Shopify's install-link case)", async () => {
    const id = await createPending("shopify", null, null, { accessToken: "secret-token", shop: "abc.myshopify.com" });
    const row = await readPending(id);
    expect(row).toEqual({
      platform: "shopify",
      clientId: null,
      teamMemberId: null,
      payload: { accessToken: "secret-token", shop: "abc.myshopify.com" },
    });
  });

  it("never stores the access token in plaintext", async () => {
    const id = await createPending("meta", "abc-fashion", "11111111-1111-1111-1111-111111111111", {
      accessToken: "very-secret-token-value",
    });
    const raw = await testPool.query("select payload from pending_connections where id = $1", [id]);
    expect(raw.rows[0].payload).not.toContain("very-secret-token-value");
  });

  it("returns null for an unknown id", async () => {
    expect(await readPending("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("returns null for an expired row without deleting it (deletion is the caller's job)", async () => {
    const id = await createPending("meta", "abc-fashion", "11111111-1111-1111-1111-111111111111", { accessToken: "x" });
    await testPool.query("update pending_connections set expires_at = now() - interval '1 minute' where id = $1", [id]);
    expect(await readPending(id)).toBeNull();
    expect((await testPool.query("select 1 from pending_connections where id = $1", [id])).rowCount).toBe(1);
  });
});

describe("deletePending", () => {
  it("removes the row", async () => {
    const id = await createPending("meta", "abc-fashion", "11111111-1111-1111-1111-111111111111", { accessToken: "x" });
    await deletePending(id);
    expect(await readPending(id)).toBeNull();
    expect((await testPool.query("select 1 from pending_connections where id = $1", [id])).rowCount).toBe(0);
  });

  it("is a no-op for an id that doesn't exist", async () => {
    await expect(deletePending("00000000-0000-0000-0000-000000000000")).resolves.toBeUndefined();
  });
});
