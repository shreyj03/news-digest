import { test, expect } from "../../support/fixtures";
import { dbDate, deleteArticles, seedTopic } from "../../support/seed";

interface FeedTopic {
  id: number;
  name: string;
  stale: boolean;
  recap: string | null;
  articles: { id: number; title: string; score: number; matched: string[]; top_story: boolean; ai_summary: string | null }[];
}

const feedOf = async (user: { api: { get: (u: string) => Promise<{ json(): Promise<unknown> }> } }, query = "") =>
  (await (await user.api.get(`/api/feed${query}`)).json()) as FeedTopic[];

test.describe("GET /api/feed", () => {
  test("orders a topic's matches by score, best first, with the score and AI summary", async ({ makeUser, db }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, {
      userId: user.id,
      name: "Energy",
      keywords: ["nuclear"],
      articles: [
        { title: "Low - Outlet A", score: 0.2 },
        { title: "High - Outlet B", score: 0.9, aiSummary: "A one-sentence summary." },
        { title: "Mid - Outlet C", score: 0.5 },
      ],
    });

    const [topic] = await feedOf(user);
    expect(topic.articles.map((a) => a.title)).toEqual(["High - Outlet B", "Mid - Outlet C", "Low - Outlet A"]);
    expect(topic.articles[0]).toMatchObject({ score: 0.9, ai_summary: "A one-sentence summary." });
    expect(topic.stale).toBe(false);
    await deleteArticles(db, seeded.articleIds);
  });

  test("reports which of the topic's keywords actually matched, on word boundaries", async ({ makeUser, db }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, {
      userId: user.id,
      name: "Funds",
      keywords: ["ETF", "index fund", "bond"],
      articles: [
        { title: "ETF and index fund flows hit a record - Wire", score: 1 },
        // "ETFs" and "bonds" contain the keywords but not as whole words.
        { title: "ETFs and bonds explained - Times", score: 0.5 },
        { title: "Matches only through the snippet - Daily", score: 0.4, summary: "A bond rally continues." },
      ],
    });

    const [topic] = await feedOf(user);
    const byTitle = Object.fromEntries(topic.articles.map((a) => [a.title, a.matched]));
    expect(byTitle["ETF and index fund flows hit a record - Wire"]).toEqual(["ETF", "index fund"]);
    expect(byTitle["ETFs and bonds explained - Times"]).toEqual([]);
    expect(byTitle["Matches only through the snippet - Daily"]).toEqual(["bond"]);
    await deleteArticles(db, seeded.articleIds);
  });

  test("lets no single outlet fill more than 3 slots", async ({ makeUser, db }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, {
      userId: user.id,
      name: "Diversity",
      keywords: ["story"],
      articles: [
        ...[1, 2, 3, 4, 5].map((n) => ({ title: `Same outlet story ${n} - Loud Outlet`, score: 1 - n / 100 })),
        { title: "Other outlet story - Quiet Outlet", score: 0.1 },
      ],
    });

    const [topic] = await feedOf(user);
    const fromLoud = topic.articles.filter((a) => a.title.endsWith("- Loud Outlet"));
    expect(fromLoud).toHaveLength(3);
    // The cap keeps the *best* three, and leaves room for the quieter outlet.
    expect(fromLoud.map((a) => a.score)).toEqual([0.99, 0.98, 0.97]);
    expect(topic.articles.some((a) => a.title.endsWith("- Quiet Outlet"))).toBe(true);
    await deleteArticles(db, seeded.articleIds);
  });

  test("shows the AI recap and flags exactly the top story", async ({ makeUser, db }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, {
      userId: user.id,
      name: "Recapped",
      keywords: ["news"],
      articles: [
        { title: "Minor - Outlet A", score: 0.3 },
        { title: "Major - Outlet B", score: 0.4 },
      ],
      recap: { text: "A quiet day, except for one big story.", topArticleIndex: 1 },
    });

    const [topic] = await feedOf(user);
    expect(topic.recap).toBe("A quiet day, except for one big story.");
    expect(topic.articles.filter((a) => a.top_story).map((a) => a.title)).toEqual(["Major - Outlet B"]);
    await deleteArticles(db, seeded.articleIds);
  });

  test("with nothing matched today, falls back to the newest older matches and says so", async ({ makeUser, db }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, {
      userId: user.id,
      name: "Quiet week",
      keywords: ["quiet"],
      articles: [
        { title: "Three days old - Outlet A", score: 0.5, daysAgo: 3 },
        { title: "Five days old - Outlet B", score: 0.9, daysAgo: 5 },
      ],
      // A recap describes one specific day, so it never rides along on a fallback.
      recap: { text: "Should not appear on a stale card.", topArticleIndex: null },
    });

    const [topic] = await feedOf(user);
    expect(topic.stale).toBe(true);
    expect(topic.recap).toBeNull();
    // Newest first, regardless of score.
    expect(topic.articles.map((a) => a.title)).toEqual(["Three days old - Outlet A", "Five days old - Outlet B"]);
    await deleteArticles(db, seeded.articleIds);
  });

  test("a topic with no matches at all is simply empty, not stale", async ({ makeUser }) => {
    const user = await makeUser();
    await user.api.post("/api/topics", { data: { name: "Brand new" } });
    const [topic] = await feedOf(user);
    expect(topic).toMatchObject({ name: "Brand new", stale: false, recap: null, articles: [] });
  });
});

test.describe("GET /api/feed?date=", () => {
  test("returns exactly the matches published on that day, with no stale fallback", async ({ makeUser, db }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, {
      userId: user.id,
      name: "History",
      keywords: ["history"],
      articles: [
        { title: "Published today - Outlet A", score: 0.5, daysAgo: 0 },
        { title: "Published yesterday - Outlet B", score: 0.5, daysAgo: 1 },
      ],
    });

    const yesterday = await dbDate(db, -1);
    const [topic] = await feedOf(user, `?date=${yesterday}`);
    expect(topic.articles.map((a) => a.title)).toEqual(["Published yesterday - Outlet B"]);
    expect(topic.stale).toBe(false);

    const twoDaysAgo = await dbDate(db, -2);
    const [empty] = await feedOf(user, `?date=${twoDaysAgo}`);
    expect(empty.articles).toEqual([]);
    expect(empty.stale).toBe(false);
    await deleteArticles(db, seeded.articleIds);
  });

  test("accepts today and the 7th day back, refuses anything else", async ({ api, db }) => {
    const ok = [await dbDate(db, 0), await dbDate(db, -6)];
    const bad = [await dbDate(db, -7), await dbDate(db, 1), "2026-13-45", "not-a-date", "2026/09/01", "20260901"];

    for (const date of ok) expect((await api.get(`/api/feed?date=${date}`)).status(), date).toBe(200);
    for (const date of bad) {
      const res = await api.get(`/api/feed?date=${date}`);
      expect(res.status(), date).toBe(400);
      expect((await res.json()).error).toMatch(/within the last 7 days/);
    }
  });
});
