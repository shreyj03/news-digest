import { test, expect } from "../../support/fixtures";
import { DEMO_EMAIL } from "../../support/env";

test.describe("health and demo account", () => {
  test("GET /health answers 200 without touching the database", async ({ api }) => {
    const res = await api.get("/health");
    expect(res.status()).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  test("anonymous GET /api/topics serves the demo account's data", async ({ api, db }) => {
    const res = await api.get("/api/topics");
    expect(res.status()).toBe(200);
    const topics = (await res.json()) as { name: string }[];

    const { rows } = await db.query<{ name: string }>(
      "SELECT t.name FROM topics t JOIN users u ON u.id = t.user_id WHERE u.email = $1 ORDER BY t.id",
      [DEMO_EMAIL]
    );
    expect(topics.map((t) => t.name)).toEqual(rows.map((r) => r.name));
    expect(topics.length).toBeGreaterThan(0);
  });
});
