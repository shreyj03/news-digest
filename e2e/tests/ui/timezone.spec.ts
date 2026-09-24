import { randomUUID } from "node:crypto";
import { test, expect } from "../../support/fixtures";

// Regression for a real, engine-specific bug this suite found: Firefox and
// Safari report modern IANA names ("Asia/Kolkata") where Chromium reports the
// legacy spelling ("Asia/Calcutta"), and the API used to 400 the modern ones —
// so on those browsers a new account silently stayed on Pacific time, and the
// settings panel couldn't save. Runs on all three engines.
test.describe("timezone handling @crossbrowser", () => {
  test.use({ timezoneId: "Asia/Kolkata" });

  test("signing up stores whatever timezone this browser reports", async ({ app, page, db }) => {
    const email = `tz-${randomUUID().slice(0, 8)}@e2e.test`;
    await app.goto();
    await app.signUp(email, "correct-horse-battery");

    const reported = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    // The app sends this in the background right after signup, so poll.
    await expect
      .poll(async () => (await db.query("SELECT digest_timezone FROM users WHERE email = $1", [email])).rows[0].digest_timezone)
      .toBe(reported);
    await db.query("DELETE FROM users WHERE email = $1", [email]);
  });

  test("picking India's zone in the settings panel saves without an error", async ({ app, makeUser, db }) => {
    const user = await makeUser();
    await app.gotoAs(user);
    await app.openDigestSettings();

    // Whichever spelling this browser's own list uses for India's zone.
    const value = await app.digestTimezone
      .locator("option")
      .evaluateAll((options) =>
        (options as HTMLOptionElement[]).map((o) => o.value).find((v) => /Kolkata|Calcutta/.test(v))
      );
    expect(value, "India's zone should be in the browser's list").toBeTruthy();

    await app.digestTimezone.selectOption(value!);
    await app.digestSave.click();
    // The panel closes itself on a successful save and stays open (showing the
    // server's message) on a refusal — so "closed" is the success signal.
    await expect(app.digestForm).toHaveCount(0);

    const { rows } = await db.query("SELECT digest_timezone FROM users WHERE id = $1", [user.id]);
    expect(rows[0].digest_timezone).toBe(value);
  });
});

// KNOWN BUG, found by this suite (first seen as a WebKit-only failure because
// its timing happens to lose the race): after signup the app fires
// GET /api/me (from the token change) and, separately, the background PUT that
// saves the browser's timezone. /api/me's handler then overwrites the panel's
// timezone with whatever the server returned — if that read lands before the
// PUT commits, it's the DB default, and the panel shows America/Los_Angeles
// while the server holds the detected zone. Opening the panel and pressing
// Save would then silently revert the account to Pacific time. The delay below
// makes that ordering happen every time, in any engine. test.fail() keeps CI
// green while it stands and goes red the moment it's fixed.
// Needs a browser timezone that differs from the server's default
// (America/Los_Angeles) — otherwise "detected" and "default" are the same
// string and the assertion could never fail.
test.describe("signup timezone race", () => {
  test.use({ timezoneId: "Asia/Kolkata" });

  test("the settings panel shows the detected zone even if /api/me is answered first", async ({ app, page, db }) => {
    test.fail(true, "signup race: GET /api/me can overwrite the detected timezone in the panel with the DB default");
    const email = `tz-${randomUUID().slice(0, 8)}@e2e.test`;
    await page.route("**/api/me/digest", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });

    await app.goto();
    await app.signUp(email, "correct-horse-battery");
    const reported = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    await expect
      .poll(async () => (await db.query("SELECT digest_timezone FROM users WHERE email = $1", [email])).rows[0].digest_timezone)
      .toBe(reported);

    await app.openDigestSettings();
    await expect(app.digestTimezone).toHaveValue(reported);
    await db.query("DELETE FROM users WHERE email = $1", [email]);
  });
});
