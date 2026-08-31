import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(join(__dirname, "../../migrations/001_init_schema.sql"), "utf-8");

export const testPool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

export async function resetTestDb() {
  await testPool.query(`
    drop schema public cascade;
    create schema public;
    create extension if not exists pgcrypto;
  `);
  await testPool.query(migrationSql);
}
