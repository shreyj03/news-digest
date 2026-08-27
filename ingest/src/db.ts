import { Pool } from "pg";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://postgres:newsdev@localhost:5433/news_digest";

export const pool = new Pool({ connectionString });
