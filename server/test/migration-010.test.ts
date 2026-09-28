import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A')`,
  );
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true)`,
  );
});

describe("migration 010 (pending_connections)", () => {
  it("stores a pending connection with a known client and team member", async () => {
    await testPool.query(
      `insert into pending_connections (platform, client_id, team_member_id, payload, expires_at) values
       ('meta', 'abc-fashion', '11111111-1111-1111-1111-111111111111', 'encrypted-blob', now() + interval '30 minutes')`,
    );
    const res = await testPool.query("select platform, client_id, team_member_id, payload from pending_connections");
    expect(res.rows).toEqual([
      {
        platform: "meta",
        client_id: "abc-fashion",
        team_member_id: "11111111-1111-1111-1111-111111111111",
        payload: "encrypted-blob",
      },
    ]);
  });

  it("allows client_id and team_member_id to both be null", async () => {
    await testPool.query(
      `insert into pending_connections (platform, payload, expires_at) values
       ('shopify', 'encrypted-blob', now() + interval '30 minutes')`,
    );
    const res = await testPool.query("select client_id, team_member_id from pending_connections");
    expect(res.rows).toEqual([{ client_id: null, team_member_id: null }]);
  });

  it("deletes pending rows when the client is deleted", async () => {
    await testPool.query(
      `insert into pending_connections (platform, client_id, payload, expires_at) values
       ('meta', 'abc-fashion', 'encrypted-blob', now() + interval '30 minutes')`,
    );
    await testPool.query("delete from clients where id = 'abc-fashion'");
    expect((await testPool.query("select 1 from pending_connections")).rowCount).toBe(0);
  });
});
