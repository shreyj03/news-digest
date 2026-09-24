import { randomUUID } from "node:crypto";
import { test, expect } from "../../support/fixtures";
import { seedResetToken } from "../../support/seed";

const freshEmail = () => `ui-${randomUUID().slice(0, 8)}@e2e.test`;
const PASSWORD = "correct-horse-battery";

test.describe("sign up and log in", () => {
  test("signing up lands on an empty account and survives a reload @crossbrowser", async ({ app, page, db }) => {
    const email = freshEmail();
    await app.goto();
    await app.signUp(email, PASSWORD);

    await expect(app.signedInEmail).toHaveText(email);
    await expect(app.demoBanner).toHaveCount(0);
    await expect(app.addTopicSection).toBeVisible();
    await expect(app.emptyAccountMessage).toBeVisible();
    await expect(app.topicSections).toHaveCount(0);
    expect(await app.storedToken()).toMatch(/^[0-9a-f]{64}$/);

    await page.reload();
    await expect(app.signedInEmail).toHaveText(email);
    await expect(app.emptyAccountMessage).toBeVisible();
    await db.query("DELETE FROM users WHERE email = $1", [email]);
  });

  test("shows the API's message for a taken email and for a short password", async ({ app, makeUser }) => {
    const existing = await makeUser();
    await app.goto();

    await app.openAuthForm("signup");
    await app.submitAuth("signup", existing.email, PASSWORD);
    await expect(app.authError).toHaveText("An account with that email already exists.");

    await app.submitAuth("signup", freshEmail(), "short");
    await expect(app.authError).toHaveText("Password must be at least 8 characters.");
    await expect(app.logOutButton).toHaveCount(0);
  });

  test("a wrong password is refused; the right one logs in; logging out clears the session", async ({ app, makeUser }) => {
    const user = await makeUser();
    await app.goto();

    await app.openAuthForm("login");
    await app.submitAuth("login", user.email, "not-the-password");
    await expect(app.authError).toHaveText("Incorrect email or password.");
    expect(await app.storedToken()).toBeNull();

    await app.submitAuth("login", user.email, user.password);
    await expect(app.logOutButton).toBeVisible();
    await expect(app.signedInEmail).toHaveText(user.email);
    expect(await app.storedToken()).not.toBeNull();

    await app.logOut();
    expect(await app.storedToken()).toBeNull();
    await expect(app.addTopicSection).toHaveCount(0);
  });

  test("the form toggles between sign up and log in, and can be dismissed", async ({ app }) => {
    await app.goto();
    await app.openAuthForm("signup");
    await expect(app.authRow.getByRole("button", { name: "Have an account?" })).toBeVisible();

    await app.authRow.getByRole("button", { name: "Have an account?" }).click();
    await expect(app.authRow.getByRole("button", { name: "Need an account?" })).toBeVisible();
    await expect(app.authRow.getByRole("button", { name: "Forgot password?" })).toBeVisible();

    await app.authRow.getByRole("button", { name: "Cancel" }).click();
    await expect(app.demoBanner).toBeVisible();
  });
});

test.describe("session handling", () => {
  test("a stale stored token falls back to the demo view instead of erroring", async ({ app, page }) => {
    await page.addInitScript(() => window.localStorage.setItem("news-digest-auth-token", "stale-or-forged"));
    await app.goto();

    await expect(app.demoBanner).toBeVisible();
    await expect(app.topic("Demo Energy").heading).toBeVisible();
    await expect(app.pageError).toHaveCount(0);
  });

  test("a session revoked mid-use asks the user to log in again", async ({ app, db, makeUser }) => {
    const user = await makeUser();
    await app.gotoAs(user);
    await expect(app.addTopicSection).toBeVisible();

    // Simulates the session expiring (or being revoked) server-side.
    await db.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);

    await app.addTopic("Anything");
    await expect(app.authError).toHaveText("Session expired — please log in again.");
    await expect(app.emailInput).toBeVisible();
    await expect(app.addTopicSection).toHaveCount(0);
  });
});

test.describe("forgot and reset password", () => {
  test("asking for a reset link gives the same neutral answer for any email", async ({ app, makeUser }) => {
    const user = await makeUser();
    for (const email of [user.email, freshEmail()]) {
      await app.goto();
      await app.openAuthForm("login");
      await app.authRow.getByRole("button", { name: "Forgot password?" }).click();
      await app.emailInput.fill(email);
      await app.authRow.getByRole("button", { name: "Send reset link" }).click();

      await expect(app.authRow.locator(".auth-status")).toHaveText(
        "If that email has an account, a reset link is on its way."
      );
      await app.authRow.getByRole("button", { name: "Back to login" }).click();
      await expect(app.emailInput).toBeVisible();
    }
  });

  test("following a reset link sets the new password, logs in, and strips the token from the URL", async ({ app, page, db, makeUser }) => {
    const user = await makeUser();
    const token = await seedResetToken(db, user.id);

    await page.goto(`/?resetToken=${token}`);
    await expect(page).not.toHaveURL(/resetToken/);
    await page.getByPlaceholder("New password").fill("a-brand-new-password");
    await page.getByRole("button", { name: "Set new password" }).click();

    await expect(app.logOutButton).toBeVisible();
    await expect(app.signedInEmail).toHaveText(user.email);

    // The new password really is the one on the account.
    const login = await user.api.post("/api/login", { data: { email: user.email, password: "a-brand-new-password" } });
    expect(login.status()).toBe(200);
  });

  test("an invalid or already-used link explains itself", async ({ app, page, db, makeUser }) => {
    const user = await makeUser();
    const token = await seedResetToken(db, user.id);
    await db.query("DELETE FROM password_reset_tokens WHERE token = $1", [token]);

    await page.goto(`/?resetToken=${token}`);
    await page.getByPlaceholder("New password").fill("a-brand-new-password");
    await page.getByRole("button", { name: "Set new password" }).click();

    await expect(app.authRow.locator(".auth-error")).toHaveText("That reset link is invalid or has expired.");
    await expect(app.logOutButton).toHaveCount(0);
  });
});
