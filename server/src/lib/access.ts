import type pg from "pg";
import { HttpError } from "./http-error.js";

export async function getAccessibleClientIds(db: pg.Pool, userId: string): Promise<"all" | string[]> {
  const member = await db.query<{ all_client_access: boolean }>(
    "select all_client_access from team_members where id = $1",
    [userId],
  );
  if (member.rowCount === 0) return [];
  if (member.rows[0].all_client_access) return "all";

  const scoped = await db.query<{ client_id: string }>(
    "select client_id from team_member_clients where team_member_id = $1",
    [userId],
  );
  return scoped.rows.map((r) => r.client_id);
}

export async function assertClientAccess(db: pg.Pool, userId: string, clientId: string) {
  const accessible = await getAccessibleClientIds(db, userId);
  if (accessible !== "all" && !accessible.includes(clientId)) {
    throw new HttpError(404, "not_found", "Client not found");
  }
  const client = await db.query("select 1 from clients where id = $1", [clientId]);
  if (client.rowCount === 0) {
    throw new HttpError(404, "not_found", "Client not found");
  }
}

// "all" aggregates every client the caller can see (the agency-wide dashboard view);
// anything else asserts access to that single client. Returns the client ids to query.
export async function resolveClientScope(db: pg.Pool, userId: string, clientId: string): Promise<string[]> {
  if (clientId === "all") {
    const accessible = await getAccessibleClientIds(db, userId);
    return accessible === "all" ? (await db.query<{ id: string }>("select id from clients")).rows.map((r) => r.id) : accessible;
  }
  await assertClientAccess(db, userId, clientId);
  return [clientId];
}
