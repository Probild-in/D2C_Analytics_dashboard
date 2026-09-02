import { Router } from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getAccessibleClientIds, assertClientAccess } from "../lib/access.js";
import { HttpError } from "../lib/http-error.js";

const router = Router();

const SELECT_CLIENTS = `
  select c.*, tm.name as owner_name
  from clients c
  left join team_members tm on tm.id = c.owner_id
`;

const LOGO_COLORS = [
  "bg-violet-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-orange-500",
  "bg-emerald-500",
  "bg-blue-500",
  "bg-pink-500",
  "bg-amber-500",
];

function pickLogoColor(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return LOGO_COLORS[hash % LOGO_COLORS.length];
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "client";
}

async function generateUniqueClientId(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  while ((await pool.query("select 1 from clients where id = $1", [candidate])).rowCount! > 0) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  return candidate;
}

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

router.post("/", requireAuth, async (req, res, next) => {
  try {
    const { name, category } = req.body as { name?: string; category?: string };
    if (!name || !name.trim()) {
      throw new HttpError(400, "invalid_name", "name is required");
    }
    if (!category || !category.trim()) {
      throw new HttpError(400, "invalid_category", "category is required");
    }

    const id = await generateUniqueClientId(name);
    const logoColor = pickLogoColor(id);
    const logoInitial = name.trim().charAt(0).toUpperCase();

    await pool.query(
      `insert into clients (id, name, category, logo_color, logo_initial, owner_id)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, name.trim(), category.trim(), logoColor, logoInitial, req.auth!.userId],
    );
    // Grants access to the creator even if they aren't an all_client_access
    // team member — otherwise a scoped user would immediately lose sight of
    // the client they just made. A no-op for all_client_access users.
    await pool.query(
      `insert into team_member_clients (team_member_id, client_id) values ($1, $2)
       on conflict do nothing`,
      [req.auth!.userId, id],
    );

    const created = await pool.query(`${SELECT_CLIENTS} where c.id = $1`, [id]);
    const r = created.rows[0];
    res.status(201).json({
      id: r.id,
      name: r.name,
      category: r.category,
      logoColor: r.logo_color,
      logoInitial: r.logo_initial,
      owner: r.owner_name,
      status: "healthy",
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireAuth, async (req, res, next) => {
  try {
    const clientId = req.params.id;
    await assertClientAccess(pool, req.auth!.userId, clientId);

    const { name, category } = req.body as { name?: string; category?: string };
    if (name !== undefined && !name.trim()) {
      throw new HttpError(400, "invalid_name", "name cannot be empty");
    }
    if (category !== undefined && !category.trim()) {
      throw new HttpError(400, "invalid_category", "category cannot be empty");
    }

    await pool.query(
      `update clients set name = coalesce($2, name), category = coalesce($3, category) where id = $1`,
      [clientId, name?.trim(), category?.trim()],
    );

    const updated = await pool.query(`${SELECT_CLIENTS} where c.id = $1`, [clientId]);
    const r = updated.rows[0];
    res.json({
      id: r.id,
      name: r.name,
      category: r.category,
      logoColor: r.logo_color,
      logoInitial: r.logo_initial,
      owner: r.owner_name,
      status: "healthy",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
