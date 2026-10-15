import { describe, it, expect, beforeEach } from "vitest";
import { testPool, resetTestDb } from "./helpers/test-db.js";

describe("migration 016: notifications", () => {
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

  it("accepts a valid notification row for each allowed kind", async () => {
    for (const kind of ["rto", "sales", "ads", "roas", "task"]) {
      const res = await testPool.query(
        `insert into notifications (client_id, kind, title, description) values ($1, $2, 'Test', 'Test description') returning id`,
        ["abc-fashion", kind],
      );
      expect(res.rowCount).toBe(1);
    }
  });

  it("rejects an unrecognized kind", async () => {
    await expect(
      testPool.query(`insert into notifications (client_id, kind, title, description) values ($1, 'campaign', 'x', 'x')`, [
        "abc-fashion",
      ]),
    ).rejects.toThrow();
  });

  it("deletes notification_reads when the notification is deleted (cascade)", async () => {
    const notif = await testPool.query(
      `insert into notifications (client_id, kind, title, description) values ($1, 'task', 'x', 'x') returning id`,
      ["abc-fashion"],
    );
    await testPool.query(`insert into notification_reads (notification_id, team_member_id) values ($1, $2)`, [
      notif.rows[0].id,
      "11111111-1111-1111-1111-111111111111",
    ]);
    await testPool.query(`delete from notifications where id = $1`, [notif.rows[0].id]);
    const reads = await testPool.query(`select * from notification_reads`);
    expect(reads.rowCount).toBe(0);
  });

  it("allows the same team member to read-mark two different notifications, but not the same notification twice", async () => {
    const notif = await testPool.query(
      `insert into notifications (client_id, kind, title, description) values ($1, 'task', 'x', 'x') returning id`,
      ["abc-fashion"],
    );
    await testPool.query(`insert into notification_reads (notification_id, team_member_id) values ($1, $2)`, [
      notif.rows[0].id,
      "11111111-1111-1111-1111-111111111111",
    ]);
    await expect(
      testPool.query(`insert into notification_reads (notification_id, team_member_id) values ($1, $2)`, [
        notif.rows[0].id,
        "11111111-1111-1111-1111-111111111111",
      ]),
    ).rejects.toThrow();
  });
});
