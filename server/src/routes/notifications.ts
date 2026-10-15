import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAccessibleClientIds } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";
import { subscribeToNotifications, type PublishedNotification } from "../lib/notification-bus.js";

const router = Router();

interface NotificationRow {
  id: string;
  client_id: string;
  client_name: string;
  kind: string;
  title: string;
  description: string;
  created_at: Date;
  read: boolean;
}

function mapRow(r: NotificationRow) {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    kind: r.kind,
    title: r.title,
    description: r.description,
    createdAt: r.created_at.toISOString(),
    read: r.read,
  };
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const accessible = await getAccessibleClientIds(pool, req.auth!.userId);
    if (accessible !== "all" && accessible.length === 0) {
      res.json([]);
      return;
    }
    const result = await pool.query<NotificationRow>(
      `select n.id, n.client_id, c.name as client_name, n.kind, n.title, n.description, n.created_at,
         (nr.notification_id is not null) as read
       from notifications n
       join clients c on c.id = n.client_id
       left join notification_reads nr on nr.notification_id = n.id and nr.team_member_id = $1
       where $2::text[] is null or n.client_id = any($2::text[])
       order by n.created_at desc
       limit 50`,
      [req.auth!.userId, accessible === "all" ? null : accessible],
    );
    res.json(result.rows.map(mapRow));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/read", requireAuth, async (req, res, next) => {
  try {
    const notifId = req.params.id;
    const notif = await pool.query<{ client_id: string }>("select client_id from notifications where id = $1", [notifId]);
    if (notif.rowCount === 0) {
      throw new HttpError(404, "not_found", "Notification not found");
    }
    const accessible = await getAccessibleClientIds(pool, req.auth!.userId);
    if (accessible !== "all" && !accessible.includes(notif.rows[0].client_id)) {
      throw new HttpError(404, "not_found", "Notification not found");
    }
    await pool.query(
      `insert into notification_reads (notification_id, team_member_id) values ($1, $2) on conflict do nothing`,
      [notifId, req.auth!.userId],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/stream", requireAuth, async (req, res, next) => {
  try {
    // Access is checked once, at connect time — a deliberate trade-off documented in
    // the spec: a team member's scope changing mid-connection is a known, acceptable
    // staleness window (the same class as every other access check in this app, none
    // of which re-verify mid-request either), not a gap introduced by this feature.
    const accessible = await getAccessibleClientIds(pool, req.auth!.userId);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // nginx buffers proxied responses by default, which would silently defeat SSE's
      // "live" delivery in production (docs/DEPLOY.md: this app sits behind nginx) —
      // this header tells nginx to pass bytes through immediately instead.
      "X-Accel-Buffering": "no",
    });
    res.write(":ok\n\n");

    const unsubscribe = subscribeToNotifications((notification: PublishedNotification) => {
      if (accessible !== "all" && !accessible.includes(notification.clientId)) return;
      res.write(`data: ${JSON.stringify(notification)}\n\n`);
    });

    // Keeps the connection alive through any intermediary (nginx, a load balancer) that
    // closes idle connections, and lets the browser detect a dead connection and
    // reconnect sooner than its own default timeout would.
    const heartbeat = setInterval(() => res.write(":heartbeat\n\n"), 20000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (err) {
    next(err);
  }
});

export default router;
