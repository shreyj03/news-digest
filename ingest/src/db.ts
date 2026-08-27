import { Pool } from "pg";

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://postgres:newsdev@localhost:5433/news_digest";

// Neon (and most hosted Postgres) requires TLS; the local Docker fallback
// doesn't use or need it. Only reached when DATABASE_URL is actually set.
const ssl = process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined;

export const pool = new Pool({ connectionString, ssl });
