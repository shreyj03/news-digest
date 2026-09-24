import { test, expect } from "../../support/fixtures";
import { mockApi } from "../../support/mocks";

test.describe("digest settings", () => {
  test("saves time, timezone and the on/off switch — and remembers them after a reload", async ({ app, page, makeUser }) => {
    const user = await makeUser();
    await app.gotoAs(user);
    await app.openDigestSettings();

    // Starts from the account's defaults.
    await expect(app.digestTime).toHaveValue("07:00");
    await expect(app.digestTimezone).toHaveValue("America/Los_Angeles");
    await expect(app.digestEnabled).toBeChecked();

    await app.digestTime.fill("08:30");
    await app.digestTimezone.selectOption("America/New_York");
    await app.digestEnabled.uncheck();

    const saved = page.waitForResponse((r) => r.url().endsWith("/api/me/digest") && r.request().method() === "PUT");
    await app.digestSave.click();
    const response = await saved;
    expect(response.status()).toBe(200);
    // What actually went over the wire.
    expect(response.request().postDataJSON()).toEqual({
      digestTime: "08:30",
      digestTimezone: "America/New_York",
      digestEnabled: false,
    });

    // …and what the server now holds.
    expect(await (await user.api.get("/api/me")).json()).toMatchObject({
      digest_time: "08:30:00",
      digest_timezone: "America/New_York",
      digest_enabled: false,
    });

    await page.reload();
    await expect(app.logOutButton).toBeVisible();
    await app.openDigestSettings();
    await expect(app.digestTime).toHaveValue("08:30");
    await expect(app.digestTimezone).toHaveValue("America/New_York");
    await expect(app.digestEnabled).not.toBeChecked();
  });

  test("the panel toggles open and closed", async ({ app, makeUser }) => {
    const user = await makeUser();
    await app.gotoAs(user);
    await expect(app.digestForm).toHaveCount(0);
    await app.openDigestSettings();
    await app.digestSettingsButton.click();
    await expect(app.digestForm).toHaveCount(0);
  });

  test("shows the server's message when saving is refused", async ({ app, makeUser, page }) => {
    const user = await makeUser();
    await app.gotoAs(user);
    await app.openDigestSettings();
    await mockApi(page, "/api/me/digest", {
      method: "PUT",
      status: 400,
      body: { error: "digestTimezone must be a valid IANA timezone name." },
    });

    await app.digestSave.click();
    await expect(app.digestError).toHaveText("digestTimezone must be a valid IANA timezone name.");
  });

  test("one user's settings never bleed into another's session", async ({ app, makeUser }) => {
    const alice = await makeUser();
    const bob = await makeUser();
    await alice.api.put("/api/me/digest", {
      data: { digestTime: "05:15", digestTimezone: "Europe/London", digestEnabled: false },
    });

    await app.gotoAs(bob);
    await app.openDigestSettings();
    await expect(app.digestTime).toHaveValue("07:00");
    await expect(app.digestTimezone).toHaveValue("America/Los_Angeles");
  });
});
