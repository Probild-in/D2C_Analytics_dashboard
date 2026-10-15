import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion', 'bg-violet-500', 'A'),
     ('xyz-cosmetics', 'XYZ Cosmetics', 'Beauty', 'bg-rose-500', 'X'),
     ('pqr-home', 'PQR Home', 'Home', 'bg-sky-500', 'P')`,
  );
});

describe("migration 015 (team_members.account_type + unique gateway_subscription_id)", () => {
  it("defaults account_type to 'staff' for rows that don't set it", async () => {
    await testPool.query(
      `insert into team_members (id, name, email, role) values ('11111111-1111-1111-1111-111111111111', 'Riya', 'riya@agency.com', 'owner')`,
    );
    const res = await testPool.query("select account_type from team_members");
    expect(res.rows[0].account_type).toBe("staff");
  });

  it("rejects an unknown account_type", async () => {
    await expect(
      testPool.query(
        `insert into team_members (id, name, email, role, account_type) values ('11111111-1111-1111-1111-111111111111', 'Riya', 'riya@agency.com', 'owner', 'admin')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("forbids two subscriptions sharing one gateway_subscription_id, but allows many NULLs", async () => {
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id) values
       ('abc-fashion', 'small', 'active', null),
       ('xyz-cosmetics', 'small', 'active', null)`,
    );
    await testPool.query(
      `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id) values ('pqr-home', 'small', 'active', 'sub_abc123')`,
    );
    await testPool.query("delete from subscriptions where client_id = 'abc-fashion'");
    await expect(
      testPool.query(
        `insert into subscriptions (client_id, plan_id, status, gateway_subscription_id) values ('abc-fashion', 'small', 'active', 'sub_abc123')`,
      ),
    ).rejects.toThrow(/subscriptions_gateway_subscription_id_key/);
  });
});
