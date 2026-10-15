import type pg from "pg";

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

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "client";
}

export function pickLogoColor(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return LOGO_COLORS[hash % LOGO_COLORS.length];
}

export async function generateUniqueClientId(pool: pg.Pool, name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;
  while ((await pool.query("select 1 from clients where id = $1", [candidate])).rowCount! > 0) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  return candidate;
}
