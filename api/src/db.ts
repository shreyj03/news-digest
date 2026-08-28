import { Pool, types } from "pg";

// pg's default DATE (OID 1082) parser returns a JS Date object at midnight
// UTC — every DATE column in this app (users.last_fetch_date,
// users.last_digest_sent_date) is compared against plain "YYYY-MM-DD"
// strings (from Intl-computed local dates, from ::date-cast query params),
// and a Date object is never === a string with the same value. Overriding
// the parser to keep the raw "YYYY-MM-DD" text pg already received from
// Postgres fixes that at the source instead of remembering to ::text-cast
// every query that touches a DATE column.
types.setTypeParser(1082, (value) => value);

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://postgres:newsdev@localhost:5433/news_digest";

// Neon (and most hosted Postgres) requires TLS; the local Docker fallback
// doesn't use or need it. Only reached when DATABASE_URL is actually set.
const ssl = process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined;

export const pool = new Pool({ connectionString, ssl });
