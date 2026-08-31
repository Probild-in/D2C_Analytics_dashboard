import type pg from "pg";

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
