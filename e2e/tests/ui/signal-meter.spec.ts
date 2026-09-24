import { test, expect } from "../../support/fixtures";
import { deleteArticles, seedTopic } from "../../support/seed";

// Regression coverage for a real bug: the "why did this match" explanation was
// a hover-only `title`, which doesn't exist on touch devices. It's now a
// click/tap toggle. These run on desktop *and* a touch-emulated phone.
test.describe("“why did this match” toggle @mobile @crossbrowser", () => {
  test("opens on click/tap, switches between meters, and closes on an outside click", async ({ app, db, makeUser, isMobile }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, {
      userId: user.id,
      name: "Energy",
      keywords: ["nuclear", "grid"],
      articles: [
        { title: "Nuclear plant joins the grid - Outlet 1", score: 1 },
        { title: "Grid demand hits a record - Outlet 2", score: 0.5 },
      ],
    });
    await app.gotoAs(user);
    const [first, second] = [app.topic("Energy").meters.nth(0), app.topic("Energy").meters.nth(1)];
    const press = (locator: typeof first) => (isMobile ? locator.tap() : locator.click());

    // Closed by default.
    await expect(first).toHaveAttribute("aria-expanded", "false");
    await expect(first.locator(".meter-why")).toHaveCount(0);

    await press(first);
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await expect(first.locator(".meter-why")).toHaveText("Matched: nuclear, grid");

    // Opening another closes the first.
    await press(second);
    await expect(second.locator(".meter-why")).toHaveText("Matched: grid");
    await expect(first).toHaveAttribute("aria-expanded", "false");
    await expect(first.locator(".meter-why")).toHaveCount(0);

    // Tapping the same one again closes it.
    await press(second);
    await expect(second).toHaveAttribute("aria-expanded", "false");

    // Any click elsewhere closes whatever is open.
    await press(first);
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await (isMobile ? app.page.getByRole("heading", { level: 1 }).tap() : app.page.getByRole("heading", { level: 1 }).click());
    await expect(first).toHaveAttribute("aria-expanded", "false");
    await deleteArticles(db, seeded.articleIds);
  });

  test("keeps the native hover tooltip working alongside the toggle", async ({ app, db, makeUser }) => {
    const user = await makeUser();
    const seeded = await seedTopic(db, {
      userId: user.id,
      name: "Energy",
      keywords: ["nuclear"],
      articles: [{ title: "Nuclear plant joins the grid - Outlet 1", score: 1 }],
    });
    await app.gotoAs(user);
    await expect(app.topic("Energy").meters.first()).toHaveAttribute("title", "Matched: nuclear");
    await deleteArticles(db, seeded.articleIds);
  });
});
