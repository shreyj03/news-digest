import { test, expect } from "../../support/fixtures";

test.describe("POST /api/fetch (\"Refresh my feed\")", () => {
  test("requires a session", async ({ api }) => {
    expect((await api.post("/api/fetch")).status()).toBe(401);
  });

  test("runs ingest and match for the caller and relays their one-line summaries", async ({ makeUser }) => {
    const user = await makeUser();
    const res = await user.api.post("/api/fetch");
    expect(res.status()).toBe(200);
    // The stub scripts (fixtures/ingest-stub) print these; the point is the
    // API shelled out to both steps and passed their last line back.
    expect(await res.json()).toEqual({
      ok: true,
      ingest: "stub ingest: skipped (e2e)",
      match: "stub match: skipped (e2e)",
    });
  });
});
