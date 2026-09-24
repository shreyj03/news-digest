import fs from "node:fs";
import pg from "pg";
import { API_URL, DEMO_EMAIL, DEMO_PASSWORD, E2E_DB_NAME, E2E_DB_URL, PG_ADMIN_URL, SCHEMA_SQL } from "./env";
import { seedTopic } from "./seed";
import { createPool } from "./db";

// Runs once, after Playwright has already started the API and web servers
// (they only need /health and the Vite root to be up — neither touches the
// DB), and before any test. Rebuilds the throwaway database from the real
// db/schema.sql so every run starts from the same known state, then creates
// the demo account anonymous visitors will see.
export default async function globalSetup(): Promise<void> {
  const admin = new pg.Client({ connectionString: PG_ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Can't reach Postgres at ${PG_ADMIN_URL} (${(err as Error).message}). ` +
        "Start it with `docker start news-postgres` (see README, \"Running locally\"), " +
        "or set E2E_PG_ADMIN_URL."
    );
  }
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [E2E_DB_NAME]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${E2E_DB_NAME}`);
  await admin.end();

  const setup = new pg.Client({ connectionString: E2E_DB_URL });
  await setup.connect();
  await setup.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await setup.query(fs.readFileSync(SCHEMA_SQL, "utf8"));
  await setup.end();

  // Signed up through the real endpoint so the password is hashed by the
  // app itself, exactly like a real account.
  const res = await fetch(`${API_URL}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  if (res.status !== 201) {
    throw new Error(`Couldn't create the demo account: HTTP ${res.status} ${await res.text()}`);
  }
  const { user } = (await res.json()) as { user: { id: number } };

  const db = createPool();
  try {
    await seedTopic(db, {
      userId: user.id,
      name: "Demo Energy",
      keywords: ["nuclear", "reactor", "grid"],
      articles: [
        { title: "Nuclear reactor approved for the grid - Demo Wire", score: 0.9 },
        { title: "Grid operators plan for winter demand - Demo Times", score: 0.5 },
        { title: "Small reactor startup raises new funding - Demo Daily", score: 0.3 },
      ],
    });
  } finally {
    await db.end();
  }
}
