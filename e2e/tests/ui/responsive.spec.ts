import { test, expect } from "../../support/fixtures";
import { deleteArticles, seedTopic } from "../../support/seed";
import type { NewsDigestPage } from "../../pages/NewsDigestPage";
import type { Db } from "../../support/db";

async function seedTwoTopics(app: NewsDigestPage, db: Db, user: { id: number; token: string }) {
  const one = await seedTopic(db, {
    userId: user.id,
    name: "Energy",
    keywords: ["nuclear"],
    articles: [{ title: "Nuclear plant joins the grid - Outlet 1", score: 1 }],
  });
  const two = await seedTopic(db, {
    userId: user.id,
    name: "Markets",
    keywords: ["stocks"],
    articles: [{ title: "Stocks rally as rates hold - Outlet 2", score: 1 }],
  });
  await app.gotoAs(user);
  await expect(app.topicSections).toHaveCount(2);
  return [...one.articleIds, ...two.articleIds];
}

const box = async (locator: import("@playwright/test").Locator) => {
  const b = await locator.boundingBox();
  if (!b) throw new Error("element has no bounding box (not rendered?)");
  return b;
};

test.describe("desktop layout", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("topics sit side by side, with the ticker panel to their right", async ({ app, db, makeUser }) => {
    const user = await makeUser();
    const articleIds = await seedTwoTopics(app, db, user);

    const [a, b, panel] = [await box(app.topicAt(0).root), await box(app.topicAt(1).root), await box(app.tickersPanel)];
    expect(Math.abs(a.y - b.y), "same row").toBeLessThan(2);
    expect(b.x, "second column").toBeGreaterThan(a.x + a.width - 1);
    expect(panel.x, "sidebar beside the content").toBeGreaterThanOrEqual(b.x + b.width - 1);
    await deleteArticles(db, articleIds);
  });
});

test.describe("phone layout @mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("stacks everything in one column with no sideways scrolling", async ({ app, page, db, makeUser }) => {
    const user = await makeUser();
    const articleIds = await seedTwoTopics(app, db, user);

    const [a, b, panel, addTopic] = [
      await box(app.topicAt(0).root),
      await box(app.topicAt(1).root),
      await box(app.tickersPanel),
      await box(app.addTopicSection),
    ];
    expect(Math.abs(a.x - b.x), "same column").toBeLessThan(2);
    expect(b.y, "second topic below the first").toBeGreaterThanOrEqual(a.y + a.height - 1);
    expect(panel.y, "ticker panel below the topics").toBeGreaterThanOrEqual(b.y + b.height - 1);

    for (const [name, rect] of Object.entries({ a, b, panel, addTopic })) {
      expect(rect.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width, `${name} right edge`).toBeLessThanOrEqual(391);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
    await deleteArticles(db, articleIds);
  });

  test("the signed-out page fits too, including the open login form", async ({ app, page }) => {
    await app.goto();
    await app.openAuthForm("login");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(app.emailInput).toBeInViewport();
  });
});
