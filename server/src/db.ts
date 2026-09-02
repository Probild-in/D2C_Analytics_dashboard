import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: "-c timezone=UTC" });

export default pool;
