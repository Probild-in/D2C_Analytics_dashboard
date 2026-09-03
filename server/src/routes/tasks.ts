import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { assertClientAccess, getAccessibleClientIds } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";

const router = Router({ mergeParams: true });

const VALID_STATUSES = ["To Do", "In Progress", "Waiting", "Completed"];
const VALID_PRIORITIES = ["Low", "Medium", "High", "Urgent"];

interface CrmTaskDbRow {
  id: string;
  client_id: string;
  title: string;
  description: string;
  assignee_id: string;
  priority: string;
  status: string;
  due_date: Date;
  tags: string[];
  comments_count: number;
}

interface TaskRow {
  id: string;
  client_id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  due_date: Date;
  tags: string[];
  comments_count: number;
  assignee_name: string;
}

function mapTaskRow(r: TaskRow) {
  return {
    id: r.id,
    clientId: r.client_id,
    title: r.title,
    description: r.description,
    assignee: r.assignee_name,
    priority: r.priority,
    status: r.status,
    // Local-getter extraction, not .toISOString() — due_date is a Postgres `date`
    // column with no time/timezone component (see campaigns.ts's launched_date for
    // the same reasoning and the bug class this avoids).
    dueDate: `${r.due_date.getFullYear()}-${String(r.due_date.getMonth() + 1).padStart(2, "0")}-${String(r.due_date.getDate()).padStart(2, "0")}`,
    comments: r.comments_count,
    tags: r.tags,
  };
}

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    let clientIds: string[];
    if (clientId === "all") {
      const accessible = await getAccessibleClientIds(pool, req.auth!.userId);
      clientIds =
        accessible === "all" ? (await pool.query("select id from clients")).rows.map((r) => r.id) : accessible;
    } else {
      await assertClientAccess(pool, req.auth!.userId, clientId);
      clientIds = [clientId];
    }
    if (clientIds.length === 0) {
      res.json([]);
      return;
    }

    const result = await pool.query(
      `select t.*, tm.name as assignee_name
       from crm_tasks t
       join team_members tm on tm.id = t.assignee_id
       where t.client_id = any($1::text[])
       order by t.due_date asc`,
      [clientIds],
    );
    res.json(result.rows.map((r) => mapTaskRow(r)));
  } catch (err) {
    next(err);
  }
});

router.post("/", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const { title, description, assigneeId, priority, dueDate, tags } = req.body as {
      title?: string;
      description?: string;
      assigneeId?: string;
      priority?: string;
      dueDate?: string;
      tags?: string[];
    };
    if (!title || !title.trim()) {
      throw new HttpError(400, "invalid_title", "title is required");
    }
    if (!assigneeId) {
      throw new HttpError(400, "invalid_assignee", "assigneeId is required");
    }
    if (!priority || !VALID_PRIORITIES.includes(priority)) {
      throw new HttpError(400, "invalid_priority", "priority must be one of Low, Medium, High, Urgent");
    }
    if (!dueDate) {
      throw new HttpError(400, "invalid_due_date", "dueDate is required");
    }

    const assignee = await pool.query("select name from team_members where id = $1", [assigneeId]);
    if (assignee.rowCount === 0) {
      throw new HttpError(400, "invalid_assignee", "assigneeId does not match a real team member");
    }

    const inserted = await pool.query<CrmTaskDbRow>(
      `insert into crm_tasks (client_id, title, description, assignee_id, priority, status, due_date, tags, created_by)
       values ($1, $2, $3, $4, $5, 'To Do', $6, $7, $8)
       returning *`,
      [clientId, title.trim(), description?.trim() ?? "", assigneeId, priority, dueDate, tags ?? [], req.auth!.userId],
    );

    res.status(201).json(mapTaskRow({ ...inserted.rows[0], assignee_name: assignee.rows[0].name }));
  } catch (err) {
    next(err);
  }
});

router.patch("/:taskId", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);
    const taskId = req.params.taskId;

    const { status } = req.body as { status?: string };
    if (!status || !VALID_STATUSES.includes(status)) {
      throw new HttpError(400, "invalid_status", "status must be one of To Do, In Progress, Waiting, Completed");
    }

    const updated = await pool.query<CrmTaskDbRow>(
      `update crm_tasks set status = $1 where id = $2 and client_id = $3 returning *`,
      [status, taskId, clientId],
    );
    if (updated.rowCount === 0) {
      throw new HttpError(404, "not_found", "Task not found");
    }

    const assignee = await pool.query("select name from team_members where id = $1", [updated.rows[0].assignee_id]);
    res.json(mapTaskRow({ ...updated.rows[0], assignee_name: assignee.rows[0].name }));
  } catch (err) {
    next(err);
  }
});

export default router;
