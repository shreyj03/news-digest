import { test, expect } from "../../support/fixtures";
import { deleteArticles, seedTopic } from "../../support/seed";

// Distinct outlets on every headline so the API's "max 3 per outlet" cap
// never trims what these tests are counting.
const energyArticles = [
  { title: "Nuclear plant joins the grid - Outlet 1", score: 1.0, aiSummary: "A new plant now supplies the grid." },
  { title: "Grid demand hits a winter record - Outlet 2", score: 0.8 },
  { title: "Reactor design wins approval - Outlet 3", score: 0.6 },
  { title: "Uranium prices climb again - Outlet 4", score: 0.5 },
  { title: "Utilities weigh new nuclear builds - Outlet 5", score: 0.4 },
  { title: "Storage projects reshape the grid - Outlet 6", score: 0.3 },
  { title: "Small modular reactors explained - Outlet 7", score: 0.2 },
];

test.describe("rendering a topic's matches", () => {
  test("shows headlines, sources, links, AI summary, recap and the top-story badge", async ({ app, db, makeUser }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, {
      userId: user.id,
      name: "Energy",
      keywords: ["nuclear", "grid", "reactor"],
      articles: energyArticles,
      recap: { text: "Nuclear and grid news dominated the day.", topArticleIndex: 1 },
    });
    await app.gotoAs(user);

    const card = app.topic("Energy");
    await expect(card.keywords).toContainText("nuclear · grid · reactor");
    await expect(card.keywords).toContainText("7 matched");
    await expect(card.recap).toHaveText("Nuclear and grid news dominated the day.");
    await expect(card.staleNote).toHaveCount(0);

    // Best match first, as a real link that opens in a new tab.
    const first = card.articles.first();
    const link = first.getByRole("link", { name: "Nuclear plant joins the grid - Outlet 1" });
    await expect(link).toHaveAttribute("href", seeded.articleUrls[0]);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noreferrer/);
    await expect(first.locator(".ai-summary")).toHaveText("A new plant now supplies the grid.");
    await expect(first.locator(".meta")).toContainText("Google News: Energy");

    // Exactly one article carries the badge — the one the recap picked.
    await expect(card.topStoryBadge).toHaveCount(1);
    await expect(card.articles.nth(1).locator(".top-story")).toHaveText("Top story");
    await deleteArticles(db, seeded.articleIds);
  });

  test("shows only the 5 strongest at first, and Show more / Show fewer toggles the rest", async ({ app, db, makeUser }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, { userId: user.id, name: "Energy", keywords: ["nuclear"], articles: energyArticles });
    await app.gotoAs(user);
    const card = app.topic("Energy");

    await expect(card.articles).toHaveCount(5);
    await expect(card.showMoreButton).toHaveText("Show 2 more");

    await card.showMoreButton.click();
    await expect(card.articles).toHaveCount(7);
    await expect(card.showMoreButton).toHaveText("Show fewer");

    await card.showMoreButton.click();
    await expect(card.articles).toHaveCount(5);
    await deleteArticles(db, seeded.articleIds);
  });

  test("signal meters are scaled against the topic's best match and explain themselves", async ({ app, db, makeUser }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, { userId: user.id, name: "Energy", keywords: ["nuclear", "grid"], articles: energyArticles });
    await app.gotoAs(user);
    const meters = app.topic("Energy").meters;

    // Best match is a full 5/5; the exact score stays visible for the curious.
    await expect(meters.nth(0)).toHaveAccessibleName(/^Match strength 5 of 5, score 1\.00\. Matched: nuclear, grid\./);
    await expect(meters.nth(1)).toHaveAccessibleName(/^Match strength 4 of 5, score 0\.80\. Matched: grid\./);
    await expect(meters.nth(0).locator(".meter-bars .lit")).toHaveCount(5);
    await expect(meters.nth(1).locator(".meter-bars .lit")).toHaveCount(4);
    // Nothing in "Reactor design wins approval" hits a *keyword* of this topic.
    await expect(meters.nth(2)).toHaveAccessibleName(/No keyword matched directly/);
    await deleteArticles(db, seeded.articleIds);
  });

  test("falls back to older matches with a note, and says so when a topic has none", async ({ app, db, makeUser }) => {
    const user = await makeUser();
    const old = await seedTopic(db, {
      userId: user.id,
      name: "Old news",
      keywords: ["old"],
      articles: [{ title: "Something from last week - Outlet A", score: 0.5, daysAgo: 3 }],
    });
    await user.api.post("/api/topics", { data: { name: "Nothing yet" } });
    await app.gotoAs(user);

    const stale = app.topic("Old news");
    await expect(stale.staleNote).toHaveText("Nothing matched today — showing the most recent matches.");
    await expect(stale.articles).toHaveCount(1);
    await expect(app.topic("Nothing yet").emptyNote).toHaveText('No matches today yet. Try "Fetch news".');
    await deleteArticles(db, old.articleIds);
  });
});

test.describe("7-day history", () => {
  test("offers today plus the six days before it, today selected first", async ({ app, makeUser }) => {
    const user = await makeUser();
    await app.gotoAs(user);

    await expect(app.datePills).toHaveCount(7);
    await expect(app.datePills.nth(0)).toHaveText("Today");
    await expect(app.datePills.nth(1)).toHaveText("Yesterday");
    await expect(app.datePills.nth(0)).toHaveClass(/active/);
    await expect(app.datePills.nth(1)).not.toHaveClass(/active/);
  });

  test("picking a day shows exactly what matched then, and Today brings the rest back", async ({ app, db, makeUser }) => {
    const user = await makeUser();
    const energy = await seedTopic(db, {
      userId: user.id,
      name: "Energy",
      keywords: ["nuclear"],
      articles: [
        { title: "Published today - Outlet 1", score: 0.9 },
        { title: "Published yesterday - Outlet 2", score: 0.7, daysAgo: 1 },
      ],
    });
    const older = await seedTopic(db, {
      userId: user.id,
      name: "Old news",
      keywords: ["old"],
      articles: [{ title: "Three days ago - Outlet 3", score: 0.5, daysAgo: 3 }],
    });
    await app.gotoAs(user);
    await expect(app.topic("Energy").articles).toHaveCount(1);

    await app.datePills.nth(1).click();
    await expect(app.datePills.nth(1)).toHaveClass(/active/);
    await expect(app.topic("Energy").articles).toHaveCount(1);
    await expect(app.topic("Energy").articles.first()).toContainText("Published yesterday");
    // History never falls back to "most recent": no matches that day is just that.
    await expect(app.topic("Old news").emptyNote).toHaveText("No matches on this day.");
    await expect(app.topic("Old news").staleNote).toHaveCount(0);

    await app.datePills.nth(0).click();
    await expect(app.topic("Energy").articles.first()).toContainText("Published today");
    await expect(app.topic("Old news").staleNote).toBeVisible();
    await deleteArticles(db, [...energy.articleIds, ...older.articleIds]);
  });
});
