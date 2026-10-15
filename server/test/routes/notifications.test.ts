import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../../src/index.js";
import { testPool, resetTestDb } from "../helpers/test-db.js";
import { signTestJwt } from "../helpers/test-jwt.js";

const STAFF_ID = "11111111-1111-1111-1111-111111111111";
const SELF_SERVE_ID = "22222222-2222-2222-2222-222222222222";

async function seed() {
  await resetTestDb();
  await testPool.query(
    `insert into clients (id, name, category, logo_color, logo_initial) values
     ('abc-fashion', 'ABC Fashion', 'Fashion & Apparel', 'bg-violet-500', 'A'),
     ('xyz-cosmetics', 'XYZ Cosmetics', 'Beauty & Cosmetics', 'bg-rose-500', 'X')`,
  );
  await testPool.query(
    `insert into team_members (id, name, email, role, all_client_access, account_type) values
     ($1, 'Riya Kapoor', 'riya@agency.com', 'owner', true, 'staff'),
     ($2, 'Amit Rao', 'amit@selfserve.com', 'owner', false, 'self_serve_owner')`,
    [STAFF_ID, SELF_SERVE_ID],
  );
  await testPool.query(`insert into team_member_clients (team_member_id, client_id) values ($1, 'abc-fashion')`, [SELF_SERVE_ID]);
}

function tokenFor(id: string, email: string) {
  return signTestJwt({ sub: id, email });
}

describe("GET /api/notifications", () => {
  beforeEach(seed);

  it("requires authentication", async () => {
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(401);
  });

  it("staff with all_client_access sees notifications across every client, most recent first", async () => {
    await testPool.query(
      `insert into notifications (client_id, kind, title, description, created_at) values
       ('abc-fashion', 'task', 'Older', 'd', now() - interval '1 hour'),
       ('xyz-cosmetics', 'rto', 'Newer', 'd', now())`,
    );
    const res = await request(app).get("/api/notifications").set("Authorization", `Bearer ${tokenFor(STAFF_ID, "riya@agency.com")}`);
    expect(res.status).toBe(200);
    expect(res.body.map((n: { title: string }) => n.title)).toEqual(["Newer", "Older"]);
    expect(res.body[0]).toMatchObject({ clientId: "xyz-cosmetics", clientName: "XYZ Cosmetics", kind: "rto", read: false });
  });

  it("a self-serve owner sees only their own client's notifications", async () => {
    await testPool.query(
      `insert into notifications (client_id, kind, title, description) values
       ('abc-fashion', 'task', 'Mine', 'd'),
       ('xyz-cosmetics', 'rto', 'Not mine', 'd')`,
    );
    const res = await request(app).get("/api/notifications").set("Authorization", `Bearer ${tokenFor(SELF_SERVE_ID, "amit@selfserve.com")}`);
    expect(res.status).toBe(200);
    expect(res.body.map((n: { title: string }) => n.title)).toEqual(["Mine"]);
  });

  it("marks a notification read for the caller once POST /:id/read is called, without affecting other callers", async () => {
    const notif = await testPool.query(
      `insert into notifications (client_id, kind, title, description) values ('abc-fashion', 'task', 'x', 'd') returning id`,
    );
    const id = notif.rows[0].id;
    const staffToken = tokenFor(STAFF_ID, "riya@agency.com");
    const selfServeToken = tokenFor(SELF_SERVE_ID, "amit@selfserve.com");

    const markRes = await request(app).post(`/api/notifications/${id}/read`).set("Authorization", `Bearer ${staffToken}`);
    expect(markRes.status).toBe(200);

    const staffList = await request(app).get("/api/notifications").set("Authorization", `Bearer ${staffToken}`);
    expect(staffList.body.find((n: { id: string }) => n.id === id).read).toBe(true);

    const selfServeList = await request(app).get("/api/notifications").set("Authorization", `Bearer ${selfServeToken}`);
    expect(selfServeList.body.find((n: { id: string }) => n.id === id).read).toBe(false);
  });

  it("marking the same notification read twice does not error", async () => {
    const notif = await testPool.query(
      `insert into notifications (client_id, kind, title, description) values ('abc-fashion', 'task', 'x', 'd') returning id`,
    );
    const token = tokenFor(STAFF_ID, "riya@agency.com");
    await request(app).post(`/api/notifications/${notif.rows[0].id}/read`).set("Authorization", `Bearer ${token}`);
    const second = await request(app).post(`/api/notifications/${notif.rows[0].id}/read`).set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(200);
  });

  it("404s marking read a notification for a client the caller can't access", async () => {
    const notif = await testPool.query(
      `insert into notifications (client_id, kind, title, description) values ('xyz-cosmetics', 'task', 'x', 'd') returning id`,
    );
    const res = await request(app)
      .post(`/api/notifications/${notif.rows[0].id}/read`)
      .set("Authorization", `Bearer ${tokenFor(SELF_SERVE_ID, "amit@selfserve.com")}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/notifications/stream", () => {
  beforeEach(seed);

  // NOTE on these two tests (adapted from the brief): the brief's version built the
  // request with `request(app).get(...)...` and held the resulting (thenable) Request
  // object in a variable without awaiting or calling `.end()` on it before the 50ms
  // sleep + publishNotification() call. Superagent/supertest (the versions actually
  // installed here: superagent 10.3.0, supertest 7.2.2) don't open the underlying
  // connection until something pulls on the request (`.then()`/`await` or an explicit
  // `.end()` callback) — so in this codebase's installed versions, that pattern never
  // actually connects the stream until *after* publishNotification() already ran,
  // and the notification is missed (verified by reproducing it: the route's own
  // subscribe callback never fired before the publish). Each test below instead calls
  // `.end()` explicitly, which superagent's Node client starts synchronously, to
  // guarantee the SSE connection is live before the 50ms sleep / publish. The
  // assertions also read the locally-accumulated `received` chunks rather than
  // `res.text`/`res.body`, since those aren't populated by superagent for a custom
  // `.parse()` callback outside of the default text/json content types. None of this
  // changes what's being verified: that the stream delivers (or doesn't deliver)
  // notifications scoped to the caller's accessible clients.
  it("delivers a notification published for an accessible client", async () => {
    // The real insert-then-publish happens inside Task 4's task routes and Task 6's
    // scheduler job — this task owns only the stream's delivery/filtering behavior, so
    // it calls publishNotification directly rather than going through either of those.
    const { publishNotification } = await import("../../src/lib/notification-bus.js");
    const token = tokenFor(SELF_SERVE_ID, "amit@selfserve.com");
    const received: string[] = [];
    let resolveStream!: (text: string) => void;
    const streamPromise = new Promise<string>((resolve) => {
      resolveStream = resolve;
    });
    const req = request(app)
      .get("/api/notifications/stream")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        res.on("data", (chunk) => {
          received.push(chunk.toString());
          if (received.join("").includes("Mine, for real")) {
            res.destroy();
            cb(null, received.join(""));
            resolveStream(received.join(""));
          }
        });
      });
    // `.end()` (rather than letting `await`/`.then()` lazily kick the request off) opens
    // the connection synchronously, so it's guaranteed live before the 50ms sleep below.
    // We resolve `streamPromise` ourselves from the data handler above rather than from
    // this callback: destroying the response mid-stream surfaces as a connection error
    // here, which is expected (we end the stream deliberately) and not a real failure.
    req.end(() => {});
    await new Promise((r) => setTimeout(r, 50));
    publishNotification({
      id: "n-y",
      clientId: "abc-fashion",
      clientName: "ABC Fashion",
      kind: "task",
      title: "Mine, for real",
      description: "d",
      createdAt: new Date().toISOString(),
    });
    const text = await streamPromise;
    expect(text).toContain("Mine, for real");
  });

  it("never delivers a notification published for a client the caller can't access", async () => {
    const { publishNotification } = await import("../../src/lib/notification-bus.js");
    const token = tokenFor(SELF_SERVE_ID, "amit@selfserve.com");
    const received: string[] = [];
    let resolveStream!: (text: string) => void;
    const streamPromise = new Promise<string>((resolve) => {
      resolveStream = resolve;
    });
    const req = request(app)
      .get("/api/notifications/stream")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        res.on("data", (chunk) => received.push(chunk.toString()));
        setTimeout(() => {
          res.destroy();
          cb(null, received.join(""));
          resolveStream(received.join(""));
        }, 200);
      });
    req.end(() => {});
    await new Promise((r) => setTimeout(r, 50));
    publishNotification({ id: "n-x", clientId: "xyz-cosmetics", clientName: "XYZ Cosmetics", kind: "rto", title: "Not mine", description: "d", createdAt: new Date().toISOString() });
    const text = await streamPromise;
    expect(text).not.toContain("Not mine");
  });
});
