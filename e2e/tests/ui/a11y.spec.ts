import { test, expect } from "../../support/fixtures";
import { deleteArticles, seedTopic } from "../../support/seed";

test.describe("keyboard and motion", () => {
  test("logging in works from the keyboard alone", async ({ app, page, makeUser }) => {
    const user = await makeUser();
    await app.goto();
    await app.authRow.getByRole("button", { name: "Log in", exact: true }).press("Enter");

    // The email field takes focus on its own; Tab moves to password.
    await expect(app.emailInput).toBeFocused();
    await page.keyboard.type(user.email);
    await page.keyboard.press("Tab");
    await expect(app.passwordInput).toBeFocused();
    await page.keyboard.type(user.password);
    await page.keyboard.press("Enter");

    await expect(app.signedInEmail).toHaveText(user.email);
  });

  test("a topic's controls can be reached and used without a mouse", async ({ app, page, makeUser }) => {
    const user = await makeUser();
    await user.api.post("/api/topics", { data: { name: "Keyboard topic" } });
    await app.gotoAs(user);

    await app.topic("Keyboard topic").editButton.focus();
    await page.keyboard.press("Enter");
    await expect(app.topicAt(0).editNameInput).toBeVisible();
    await app.topicAt(0).editNameInput.fill("Renamed by keyboard");
    await app.topicAt(0).saveEditButton.focus();
    await page.keyboard.press("Enter");
    await expect(app.topic("Renamed by keyboard").heading).toBeVisible();
  });

  test("the entrance animation switches off for people who ask for reduced motion", async ({ app, page, db, makeUser }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, {
      userId: user.id,
      name: "Motion",
      keywords: ["motion"],
      articles: [{ title: "Headline - Outlet 1", score: 1 }],
    });
    const animationName = () =>
      app.topic("Motion").root.evaluate((el) => getComputedStyle(el).animationName);

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await app.gotoAs(user);
    expect(await animationName()).not.toBe("none");

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await animationName()).toBe("none");
    await deleteArticles(db, seeded.articleIds);
  });
});

test.describe("accessible names", () => {
  test("every button on a populated page has a name a screen reader can announce", async ({ app, page, db, makeUser }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, {
      userId: user.id,
      name: "Names",
      keywords: ["names"],
      articles: [
        { title: "One - Outlet 1", score: 1 },
        { title: "Two - Outlet 2", score: 0.5 },
      ],
    });
    await app.gotoAs(user);
    await expect(app.topic("Names").articles).toHaveCount(2);

    const unnamed = await page.getByRole("button").evaluateAll((buttons) =>
      buttons
        .filter((b) => !(b.getAttribute("aria-label") ?? b.textContent ?? "").trim())
        .map((b) => b.outerHTML.slice(0, 120))
    );
    expect(unnamed, "buttons with no accessible name").toEqual([]);
    await deleteArticles(db, seeded.articleIds);
  });
});
