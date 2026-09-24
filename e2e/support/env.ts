import path from "node:path";

export const ROOT = path.resolve(__dirname, "..", "..");

// Deliberately different from the dev servers' 3001/5173 so a running dev
// environment (the SessionStart hook auto-starts one) never collides with,
// or gets its data touched by, a test run.
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3101);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5273);
export const API_URL = `http://localhost:${API_PORT}`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

// Admin connection to the same Postgres the dev setup uses (docker
// `news-postgres`, port 5433), used only to create/reset the throwaway
// e2e database below — tests never touch `news_digest`.
export const PG_ADMIN_URL =
  process.env.E2E_PG_ADMIN_URL ?? "postgres://postgres:newsdev@localhost:5433/postgres";
export const E2E_DB_NAME = "news_digest_e2e";

// sslmode=disable because api/src/db.ts turns TLS on whenever DATABASE_URL
// is set (it's built for Neon), and a local/CI Postgres container has none.
export const E2E_DB_URL = (() => {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${E2E_DB_NAME}`;
  url.searchParams.set("sslmode", "disable");
  return url.toString();
})();

export const FETCH_SECRET = "e2e-fetch-secret";
export const DEMO_EMAIL = "demo@e2e.test";
export const DEMO_PASSWORD = "demo-password-123";

// Must match AUTH_TOKEN_KEY in web/src/App.tsx.
export const AUTH_TOKEN_KEY = "news-digest-auth-token";

export const SCHEMA_SQL = path.join(ROOT, "db", "schema.sql");
export const INGEST_STUB_DIR = path.join(ROOT, "e2e", "fixtures", "ingest-stub");
