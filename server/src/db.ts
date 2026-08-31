import pg from "pg";

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString });

export default pool;
