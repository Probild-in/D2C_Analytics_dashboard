import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "../../migrations");
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

export const testPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

export async function resetTestDb() {
  await testPool.query(`
    drop schema public cascade;
    create schema public;
    create extension if not exists pgcrypto;
  `);
  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    await testPool.query(sql);
  }
}
