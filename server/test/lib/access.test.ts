import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { getAccessibleClientIds } from "../../src/lib/access.js";

describe("getAccessibleClientIds", () => {
  beforeEach(async () => {
    await resetTestDb();
    await testPool.query(
      `insert into team_members (id, name, email, role, all_client_access) values
       ('11111111-1111-1111-1111-111111111111', 'Riya Kapoor', 'riya@agency.com', 'owner', true),
       ('22222222-2222-2222-2222-222222222222', 'Aditya Rao', 'aditya@agency.com', 'manager', false)`,
    );
    await testPool.query(
      `insert into clients (id, name, category, logo_color, logo_initial) values
       ('abc-fashion', 'ABC Fashion', 'Fashion', 'bg-violet-500', 'A'),
       ('xyz-cosmetics', 'XYZ Cosmetics', 'Beauty', 'bg-rose-500', 'X')`,
    );
    await testPool.query(
      `insert into team_member_clients (team_member_id, client_id) values
       ('22222222-2222-2222-2222-222222222222', 'abc-fashion')`,
    );
  });

  it("returns 'all' for a user with all_client_access", async () => {
    const result = await getAccessibleClientIds(testPool, "11111111-1111-1111-1111-111111111111");
    expect(result).toBe("all");
  });

  it("returns only assigned client ids for a scoped user", async () => {
    const result = await getAccessibleClientIds(testPool, "22222222-2222-2222-2222-222222222222");
    expect(result).toEqual(["abc-fashion"]);
  });

  it("returns an empty array for an unknown user", async () => {
    const result = await getAccessibleClientIds(testPool, "33333333-3333-3333-3333-333333333333");
    expect(result).toEqual([]);
  });
});
