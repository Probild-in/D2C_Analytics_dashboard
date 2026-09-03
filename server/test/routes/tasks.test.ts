import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const SCOPED_ID = "22222222-2222-2222-2222-222222222222";

beforeEach(async () => {
  await resetTestDb();
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access) values
     ('${OWNER_ID}', 'Riya Kapoor', 'riya@agency.com', 'owner', true),
     ('${SCOPED_ID}', 'Aditya Rao', 'aditya@agency.com', 'manager', false)`,
  );
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A'),
     ('xyz-cosmetics', 'XYZ Cosmetics', 'Beauty & Cosmetics', 'bg-rose-500', 'X')`,
  );
  await testPool.query(
    `insert into team_member_clients (team_member_id, client_id) values ('${SCOPED_ID}', 'abc-fashion')`,
  );
});

describe("GET /api/clients/:id/tasks", () => {
  it("404s for a client the user cannot access", async () => {
    const token = signTestJwt({ sub: SCOPED_ID, email: "aditya@agency.com" });
    const res = await request(app).get("/api/clients/xyz-cosmetics/tasks").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns tasks for one client, with the assignee's real name", async () => {
    await testPool.query(
      `insert into crm_tasks (client_id, title, assignee_id, priority, status, due_date, created_by) values
       ('abc-fashion', 'Review creative brief', '${OWNER_ID}', 'High', 'To Do', current_date + 2, '${OWNER_ID}')`,
    );
    const token = signTestJwt({ sub: OWNER_ID, email: "riya@agency.com" });
    const res = await request(app).get("/api/clients/abc-fashion/tasks").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      clientId: "abc-fashion",
      title: "Review creative brief",
      assignee: "Riya Kapoor",
      priority: "High",
      status: "To Do",
      comments: 0,
      tags: [],
    });
  });

  it("clientId=all aggregates tasks across every accessible client", async () => {
    await testPool.query(
      `insert into crm_tasks (client_id, title, assignee_id, priority, status, due_date, created_by) values
       ('abc-fashion', 'Task A', '${OWNER_ID}', 'Low', 'To Do', current_date + 1, '${OWNER_ID}'),
       ('xyz-cosmetics', 'Task B', '${OWNER_ID}', 'Low', 'To Do', current_date + 2, '${OWNER_ID}')`,
    );
    const token = signTestJwt({ sub: OWNER_ID, email: "riya@agency.com" });
    const res = await request(app).get("/api/clients/all/tasks").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.map((t: { title: string }) => t.title).sort()).toEqual(["Task A", "Task B"]);
  });

  it("clientId=all scopes to only the clients a limited team member can access", async () => {
    await testPool.query(
      `insert into crm_tasks (client_id, title, assignee_id, priority, status, due_date, created_by) values
       ('abc-fashion', 'Task A', '${OWNER_ID}', 'Low', 'To Do', current_date + 1, '${OWNER_ID}'),
       ('xyz-cosmetics', 'Task B', '${OWNER_ID}', 'Low', 'To Do', current_date + 2, '${OWNER_ID}')`,
    );
    const token = signTestJwt({ sub: SCOPED_ID, email: "aditya@agency.com" });
    const res = await request(app).get("/api/clients/all/tasks").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.map((t: { title: string }) => t.title)).toEqual(["Task A"]);
  });
});

describe("POST /api/clients/:id/tasks", () => {
  it("creates a task defaulting to To Do status", async () => {
    const token = signTestJwt({ sub: OWNER_ID, email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/tasks")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "New creative review", assigneeId: OWNER_ID, priority: "Medium", dueDate: "2026-09-10", tags: ["creative"] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      clientId: "abc-fashion",
      title: "New creative review",
      assignee: "Riya Kapoor",
      priority: "Medium",
      status: "To Do",
      dueDate: "2026-09-10",
      tags: ["creative"],
    });

    const persisted = await testPool.query("select * from crm_tasks where title = 'New creative review'");
    expect(persisted.rowCount).toBe(1);
  });

  it("rejects an invalid priority", async () => {
    const token = signTestJwt({ sub: OWNER_ID, email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/tasks")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Task", assigneeId: OWNER_ID, priority: "Extreme", dueDate: "2026-09-10" });
    expect(res.status).toBe(400);
  });

  it("rejects an assigneeId that isn't a real team member", async () => {
    const token = signTestJwt({ sub: OWNER_ID, email: "riya@agency.com" });
    const res = await request(app)
      .post("/api/clients/abc-fashion/tasks")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Task", assigneeId: "99999999-9999-9999-9999-999999999999", priority: "Low", dueDate: "2026-09-10" });
    expect(res.status).toBe(400);
  });

  it("404s for a client the user cannot access", async () => {
    const token = signTestJwt({ sub: SCOPED_ID, email: "aditya@agency.com" });
    const res = await request(app)
      .post("/api/clients/xyz-cosmetics/tasks")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Task", assigneeId: OWNER_ID, priority: "Low", dueDate: "2026-09-10" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/clients/:id/tasks/:taskId", () => {
  it("moves a task to a new status", async () => {
    const created = await testPool.query(
      `insert into crm_tasks (client_id, title, assignee_id, priority, status, due_date, created_by) values
       ('abc-fashion', 'Task A', '${OWNER_ID}', 'Low', 'To Do', current_date + 1, '${OWNER_ID}')
       returning id`,
    );
    const token = signTestJwt({ sub: OWNER_ID, email: "riya@agency.com" });
    const res = await request(app)
      .patch(`/api/clients/abc-fashion/tasks/${created.rows[0].id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "In Progress" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("In Progress");
  });

  it("404s for a task that doesn't belong to this client", async () => {
    const created = await testPool.query(
      `insert into crm_tasks (client_id, title, assignee_id, priority, status, due_date, created_by) values
       ('abc-fashion', 'Task A', '${OWNER_ID}', 'Low', 'To Do', current_date + 1, '${OWNER_ID}')
       returning id`,
    );
    const token = signTestJwt({ sub: OWNER_ID, email: "riya@agency.com" });
    const res = await request(app)
      .patch(`/api/clients/xyz-cosmetics/tasks/${created.rows[0].id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "In Progress" });
    expect(res.status).toBe(404);
  });

  it("rejects an invalid status", async () => {
    const created = await testPool.query(
      `insert into crm_tasks (client_id, title, assignee_id, priority, status, due_date, created_by) values
       ('abc-fashion', 'Task A', '${OWNER_ID}', 'Low', 'To Do', current_date + 1, '${OWNER_ID}')
       returning id`,
    );
    const token = signTestJwt({ sub: OWNER_ID, email: "riya@agency.com" });
    const res = await request(app)
      .patch(`/api/clients/abc-fashion/tasks/${created.rows[0].id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "Blocked" });
    expect(res.status).toBe(400);
  });
});
