import { test, expect } from "../../support/fixtures";

test.describe("topics require a session to change", () => {
  test("create, update, and delete all answer 401 without one", async ({ api }) => {
    expect((await api.post("/api/topics", { data: { name: "Nope" } })).status()).toBe(401);
    expect((await api.put("/api/topics/1", { data: { name: "Nope" } })).status()).toBe(401);
    expect((await api.delete("/api/topics/1")).status()).toBe(401);
  });
});

test.describe("creating topics", () => {
  test("fills in keywords from the name when none are given (no AI configured)", async ({ makeUser }) => {
    const user = await makeUser();
    const res = await user.api.post("/api/topics", { data: { name: "The Future of Solar Power" } });

    expect(res.status()).toBe(201);
    const topic = await res.json();
    // Stopwords ("the", "of") dropped; the rest lower-cased.
    expect(topic.keywords).toEqual(["future", "solar", "power"]);
    // The stubbed ingest succeeded, so no "first fetch failed" warning.
    expect(topic).not.toHaveProperty("warning");
  });

  test("keeps the keywords the user typed, trimmed and de-blanked", async ({ makeUser }) => {
    const user = await makeUser();
    const res = await user.api.post("/api/topics", {
      data: { name: "Crypto", keywords: ["  bitcoin ", "", "coinbase", "   "] },
    });
    expect(res.status()).toBe(201);
    expect((await res.json()).keywords).toEqual(["bitcoin", "coinbase"]);
  });

  test("requires a non-blank name", async ({ makeUser }) => {
    const user = await makeUser();
    for (const name of ["", "   ", undefined]) {
      const res = await user.api.post("/api/topics", { data: { name } });
      expect(res.status(), `name=${JSON.stringify(name)}`).toBe(400);
      expect(await res.json()).toEqual({ error: "Topic name is required." });
    }
  });

  test("rejects a duplicate name for the same user with 409", async ({ makeUser }) => {
    const user = await makeUser();
    expect((await user.api.post("/api/topics", { data: { name: "ETFs" } })).status()).toBe(201);
    const dup = await user.api.post("/api/topics", { data: { name: "ETFs" } });
    expect(dup.status()).toBe(409);
    expect(await dup.json()).toEqual({ error: "A topic with that name already exists." });
  });

  test("creates a Google News feed for the topic", async ({ makeUser, db }) => {
    const user = await makeUser();
    const { id } = await (await user.api.post("/api/topics", { data: { name: "US Immigration Law" } })).json();

    const { rows } = await db.query("SELECT url, name FROM feeds WHERE topic_id = $1", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Google News: US Immigration Law");
    expect(rows[0].url).toBe(
      "https://news.google.com/rss/search?q=US%20Immigration%20Law&hl=en-US&gl=US&ceid=US:en"
    );
  });

  test("GET /api/topics lists the caller's topics in creation order", async ({ makeUser }) => {
    const user = await makeUser();
    for (const name of ["Zebra", "Apple", "Mango"]) {
      await user.api.post("/api/topics", { data: { name } });
    }
    const topics = await (await user.api.get("/api/topics")).json();
    expect(topics.map((t: { name: string }) => t.name)).toEqual(["Zebra", "Apple", "Mango"]);
    expect(topics[0]).toEqual(
      expect.objectContaining({ id: expect.any(Number), keywords: ["zebra"], created_at: expect.any(String) })
    );
  });
});

test.describe("updating topics", () => {
  test("changes the name and keywords, and repoints the feed at the new name", async ({ makeUser, db }) => {
    const user = await makeUser();
    const { id } = await (await user.api.post("/api/topics", { data: { name: "Oil" } })).json();

    const res = await user.api.put(`/api/topics/${id}`, { data: { name: "Natural Gas", keywords: ["lng", "pipeline"] } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ id, name: "Natural Gas", keywords: ["lng", "pipeline"] });

    const { rows } = await db.query("SELECT url, name FROM feeds WHERE topic_id = $1", [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Google News: Natural Gas");
    expect(rows[0].url).toContain("q=Natural%20Gas");
  });

  test("validates the id and the name", async ({ makeUser }) => {
    const user = await makeUser();
    const { id } = await (await user.api.post("/api/topics", { data: { name: "Real" } })).json();

    expect((await user.api.put("/api/topics/abc", { data: { name: "X" } })).status()).toBe(400);
    expect((await user.api.put(`/api/topics/${id}`, { data: { name: "  " } })).status()).toBe(400);
    expect((await user.api.put("/api/topics/999999999", { data: { name: "X" } })).status()).toBe(404);
  });

  test("refuses to rename onto another of the user's own topics", async ({ makeUser }) => {
    const user = await makeUser();
    await user.api.post("/api/topics", { data: { name: "First" } });
    const { id } = await (await user.api.post("/api/topics", { data: { name: "Second" } })).json();

    const res = await user.api.put(`/api/topics/${id}`, { data: { name: "First" } });
    expect(res.status()).toBe(409);
  });
});

test.describe("deleting topics", () => {
  test("removes the topic, its feed, and its matches — and only once", async ({ makeUser, db }) => {
    const user = await makeUser();
    const { id } = await (await user.api.post("/api/topics", { data: { name: "Doomed" } })).json();
    const article = await db.query<{ id: number }>(
      "INSERT INTO articles (url, title) VALUES ('https://e2e.test/doomed-' || gen_random_uuid(), 'Doomed headline') RETURNING id"
    );
    await db.query("INSERT INTO topic_articles (topic_id, article_id, score) VALUES ($1, $2, 1)", [id, article.rows[0].id]);

    expect((await user.api.delete(`/api/topics/${id}`)).status()).toBe(204);

    expect((await (await user.api.get("/api/topics")).json())).toEqual([]);
    // ON DELETE CASCADE cleans up everything hanging off the topic.
    expect((await db.query("SELECT 1 FROM feeds WHERE topic_id = $1", [id])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM topic_articles WHERE topic_id = $1", [id])).rowCount).toBe(0);
    // The shared article itself is not the topic's to delete.
    expect((await db.query("SELECT 1 FROM articles WHERE id = $1", [article.rows[0].id])).rowCount).toBe(1);

    expect((await user.api.delete(`/api/topics/${id}`)).status()).toBe(404);
    expect((await user.api.delete("/api/topics/abc")).status()).toBe(400);
    await db.query("DELETE FROM articles WHERE id = $1", [article.rows[0].id]);
  });
});
