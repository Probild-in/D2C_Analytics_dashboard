import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAccessibleClientIds } from "../lib/access.js";

const router = Router();

const SELECT_CLIENTS = `
  select c.*, tm.name as owner_name
  from clients c
  left join team_members tm on tm.id = c.owner_id
`;

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const accessible = await getAccessibleClientIds(pool, req.auth!.userId);
    const rows =
      accessible === "all"
        ? (await pool.query(`${SELECT_CLIENTS} order by c.name`)).rows
        : accessible.length === 0
          ? []
          : (await pool.query(`${SELECT_CLIENTS} where c.id = any($1) order by c.name`, [accessible])).rows;

    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        logoColor: r.logo_color,
        logoInitial: r.logo_initial,
        owner: r.owner_name,
        status: "healthy", // computed status lands with the Shopify integration plan, once real order data exists
      })),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
