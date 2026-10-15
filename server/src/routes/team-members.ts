import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { isStaffMember } from "../lib/access.js";

const router = Router();

const ROLE_DISPLAY: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  marketer: "Marketer",
  team_member: "Team Member",
};

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const staff = await isStaffMember(pool, req.auth!.userId);
    if (!staff) {
      // A self-serve owner sees only their own row — never the full agency roster,
      // never other tenants' team members or client lists.
      const own = await pool.query(
        `select tm.id, tm.name, tm.email, tm.role, tm.all_client_access,
           coalesce(array_agg(tmc.client_id) filter (where tmc.client_id is not null), '{}') as scoped_clients
         from team_members tm
         left join team_member_clients tmc on tmc.team_member_id = tm.id
         where tm.id = $1
         group by tm.id`,
        [req.auth!.userId],
      );
      res.json(
        own.rows.map((r) => ({
          id: r.id,
          name: r.name,
          email: r.email,
          role: ROLE_DISPLAY[r.role] ?? r.role,
          clients: r.scoped_clients,
        })),
      );
      return;
    }

    const [members, clients] = await Promise.all([
      pool.query(
        `select tm.id, tm.name, tm.email, tm.role, tm.all_client_access,
           coalesce(array_agg(tmc.client_id) filter (where tmc.client_id is not null), '{}') as scoped_clients
         from team_members tm
         left join team_member_clients tmc on tmc.team_member_id = tm.id
         group by tm.id
         order by tm.name`,
      ),
      pool.query("select id from clients"),
    ]);
    const allClientIds = clients.rows.map((r) => r.id);

    res.json(
      members.rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        role: ROLE_DISPLAY[r.role] ?? r.role,
        clients: r.all_client_access ? allClientIds : r.scoped_clients,
      })),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
