import { test, expect } from "../../support/fixtures";

test.describe("anonymous visitor sees a read-only demo @crossbrowser", () => {
  test("demo banner, demo data, and no editing controls", async ({ app }) => {
    await app.goto();

    await expect(app.demoBanner).toBeVisible();
    await expect(app.authRow.getByRole("button", { name: "Sign up" })).toBeVisible();
    await expect(app.authRow.getByRole("button", { name: "Log in" })).toBeVisible();

    const demoTopic = app.topic("Demo Energy");
    await expect(demoTopic.heading).toBeVisible();
    await expect(demoTopic.articles).toHaveCount(3);

    await expect(app.addTopicSection).toHaveCount(0);
    await expect(app.refreshButton).toHaveCount(0);
    await expect(app.digestSettingsButton).toHaveCount(0);
    await expect(demoTopic.editButton).toHaveCount(0);
    await expect(demoTopic.deleteButton).toHaveCount(0);
    await expect(app.tickerInput).toHaveCount(0);
  });
});
