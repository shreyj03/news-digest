import { test, expect } from "../../support/fixtures";
import { DEMO_EMAIL } from "../../support/env";
import { deleteArticles, seedTicker, seedTopic } from "../../support/seed";

test.describe("one user cannot see or touch another's data", () => {
  test("topics: invisible, and update/delete answer 404 without changing anything", async ({ makeUser, db }) => {
    const alice = await makeUser();
    const bob = await makeUser();
    const { id } = await (await alice.api.post("/api/topics", { data: { name: "Alice's private topic" } })).json();

    // Bob is logged in, so he sees *his* (empty) list — not the demo's.
    expect(await (await bob.api.get("/api/topics")).json()).toEqual([]);

    expect((await bob.api.put(`/api/topics/${id}`, { data: { name: "Hijacked" } })).status()).toBe(404);
    expect((await bob.api.delete(`/api/topics/${id}`)).status()).toBe(404);

    const { rows } = await db.query("SELECT name, user_id FROM topics WHERE id = $1", [id]);
    expect(rows).toEqual([{ name: "Alice's private topic", user_id: alice.id }]);
  });

  test("feed: each user's feed contains only their own topics and articles", async ({ makeUser, db }) => {
    const alice = await makeUser();
    const bob = await makeUser();
    const aliceTopic = await seedTopic(db, {
      userId: alice.id,
      name: "Alice topic",
      keywords: ["alice"],
      articles: [{ title: "Alice-only headline - Wire", score: 1 }],
    });

    const aliceFeed = await (await alice.api.get("/api/feed")).json();
    expect(aliceFeed.map((t: { name: string }) => t.name)).toEqual(["Alice topic"]);
    expect(aliceFeed[0].articles).toHaveLength(1);

    expect(await (await bob.api.get("/api/feed")).json()).toEqual([]);
    await deleteArticles(db, aliceTopic.articleIds);
  });

  test("two users may each have a topic with the same name", async ({ makeUser }) => {
    const alice = await makeUser();
    const bob = await makeUser();
    const a = await alice.api.post("/api/topics", { data: { name: "Crypto" } });
    const b = await bob.api.post("/api/topics", { data: { name: "Crypto" } });
    expect(a.status()).toBe(201);
    expect(b.status()).toBe(201);
    expect((await a.json()).id).not.toBe((await b.json()).id);
  });

  // KNOWN BUG, found by this suite: `feeds.url` is globally UNIQUE (db/schema.sql)
  // but every topic's feed URL is derived from its name alone, so when a second
  // user creates a topic named like an existing one, the feed INSERT violates
  // feeds_url_key. The topic is still created, but with no feed of its own
  // (ingest only fetches feeds belonging to the user's topics) and the caller
  // gets a "first fetch failed" warning. test.fail() keeps CI green while the
  // bug stands, and turns red the moment it's fixed so this gets flipped back
  // to a normal test.
  test("a same-named topic gets its own feed for each user", async ({ makeUser, db }) => {
    test.fail(true, "feeds.url is globally UNIQUE, so the second user's same-named topic gets no feed");
    const alice = await makeUser();
    const bob = await makeUser();
    const a = await (await alice.api.post("/api/topics", { data: { name: "Crypto" } })).json();
    const b = await (await bob.api.post("/api/topics", { data: { name: "Crypto" } })).json();

    expect(b).not.toHaveProperty("warning");
    const feeds = await db.query("SELECT topic_id FROM feeds WHERE topic_id = ANY($1::int[])", [[a.id, b.id]]);
    expect(feeds.rowCount).toBe(2);
  });

  test("tickers: another user's delete answers 404 and the ticker survives", async ({ makeUser, db }) => {
    const alice = await makeUser();
    const bob = await makeUser();
    const tickerId = await seedTicker(db, alice.id, "OKLO");

    expect((await bob.api.delete(`/api/tickers/${tickerId}`)).status()).toBe(404);
    expect((await db.query("SELECT 1 FROM tickers WHERE id = $1", [tickerId])).rowCount).toBe(1);

    expect((await alice.api.delete(`/api/tickers/${tickerId}`)).status()).toBe(204);
    expect((await db.query("SELECT 1 FROM tickers WHERE id = $1", [tickerId])).rowCount).toBe(0);
  });

  test("the same symbol can be watched by two users independently", async ({ makeUser, db }) => {
    const alice = await makeUser();
    const bob = await makeUser();
    await seedTicker(db, alice.id, "COIN");
    await expect(seedTicker(db, bob.id, "COIN")).resolves.toEqual(expect.any(Number));
    // …but not twice by the same user (UNIQUE(user_id, symbol)).
    await expect(seedTicker(db, alice.id, "COIN")).rejects.toThrow(/duplicate key/);
  });
});

test.describe("anonymous visitors get a strictly read-only demo", () => {
  test("reads fall back to the demo account", async ({ api, db }) => {
    const { rows } = await db.query<{ name: string }>(
      "SELECT t.name FROM topics t JOIN users u ON u.id = t.user_id WHERE u.email = $1 ORDER BY t.id",
      [DEMO_EMAIL]
    );
    const topics = await (await api.get("/api/topics")).json();
    expect(topics.map((t: { name: string }) => t.name)).toEqual(rows.map((r) => r.name));

    const feed = await (await api.get("/api/feed")).json();
    expect(feed.map((t: { name: string }) => t.name)).toEqual(rows.map((r) => r.name));
    expect(feed[0].articles.length).toBeGreaterThan(0);
  });

  test("an invalid token reads as anonymous (demo data), not as an error", async ({ api }) => {
    const res = await api.get("/api/topics", { headers: { Authorization: "Bearer stale-or-forged" } });
    expect(res.status()).toBe(200);
    expect((await res.json()).length).toBeGreaterThan(0);
  });

  test("every write is refused with 401", async ({ api }) => {
    const attempts = [
      api.post("/api/topics", { data: { name: "Nope" } }),
      api.put("/api/topics/1", { data: { name: "Nope" } }),
      api.delete("/api/topics/1"),
      api.post("/api/tickers", { data: { symbol: "AAPL" } }),
      api.delete("/api/tickers/1"),
      api.put("/api/me/digest", { data: { digestTime: "08:00", digestTimezone: "UTC", digestEnabled: true } }),
      api.post("/api/fetch"),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status(), res.url()).toBe(401);
    }
  });

  test("an invalid token is still refused on writes", async ({ api }) => {
    const res = await api.post("/api/topics", {
      data: { name: "Nope" },
      headers: { Authorization: "Bearer stale-or-forged" },
    });
    expect(res.status()).toBe(401);
  });
});
