import { test, expect } from "../../support/fixtures";
import { mockApi } from "../../support/mocks";

const names = async (user: { api: { get(url: string): Promise<{ json(): Promise<unknown> }> } }) =>
  ((await (await user.api.get("/api/topics")).json()) as { name: string }[]).map((t) => t.name);

test.describe("adding topics", () => {
  test("adds a topic with keywords filled in from its name, then clears the form", async ({ app, makeUser }) => {
    const user = await makeUser();
    await app.gotoAs(user);
    await expect(app.emptyAccountMessage).toBeVisible();

    await app.addTopic("Solar Power");

    const card = app.topic("Solar Power");
    await expect(card.heading).toBeVisible();
    await expect(card.keywords).toHaveText("solar · power");
    await expect(card.emptyNote).toHaveText('No matches today yet. Try "Fetch news".');
    await expect(app.emptyAccountMessage).toHaveCount(0);
    await expect(app.newTopicName).toHaveValue("");
    await expect(app.newTopicKeywords).toHaveValue("");
    expect(await names(user)).toEqual(["Solar Power"]);
  });

  test("keeps the keywords the user typed", async ({ app, makeUser }) => {
    const user = await makeUser();
    await app.gotoAs(user);
    await app.addTopic("Crypto", "bitcoin, coinbase ,  ,ethereum");
    await expect(app.topic("Crypto").keywords).toHaveText("bitcoin · coinbase · ethereum");
  });

  test("refuses a blank name without calling the API, and a duplicate with the API's message", async ({ app, makeUser, page }) => {
    const user = await makeUser();
    await app.gotoAs(user);

    let posted = false;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/topics")) posted = true;
    });
    await app.addTopic("   ");
    await expect(app.addTopicError).toHaveText("Topic name is required.");
    expect(posted).toBe(false);

    await app.addTopic("ETFs");
    await expect(app.topic("ETFs").heading).toBeVisible();
    await app.addTopic("ETFs");
    await expect(app.addTopicError).toHaveText("A topic with that name already exists.");
    await expect(app.topicSections).toHaveCount(1);
  });

  test("shows the warning when the first fetch for a new topic fails, but keeps the topic", async ({ app, makeUser, page }) => {
    const user = await makeUser();
    await app.gotoAs(user);
    const warning = 'Topic created, but the first fetch failed: boom. Try "Fetch news" once things are running again.';
    await mockApi(page, "/api/topics", {
      method: "POST",
      status: 201,
      body: { id: 999, name: "Flaky", keywords: ["flaky"], warning },
    });

    await app.addTopic("Flaky");
    await expect(app.fetchStatus).toHaveText(warning);
  });
});

test.describe("editing topics", () => {
  test("pre-fills the current values, saves a rename, and cancel discards changes", async ({ app, makeUser }) => {
    const user = await makeUser();
    await user.api.post("/api/topics", { data: { name: "Oil", keywords: ["crude", "opec"] } });
    await app.gotoAs(user);

    // Cancel: nothing should change.
    let card = app.topicAt(0);
    await card.editButton.click();
    await expect(card.editNameInput).toHaveValue("Oil");
    await expect(card.editKeywordsInput).toHaveValue("crude, opec");
    await card.editNameInput.fill("Discarded");
    await card.cancelEditButton.click();
    await expect(app.topic("Oil").heading).toBeVisible();
    await expect(app.topic("Discarded").heading).toHaveCount(0);

    // Save: the heading, keywords and the server all update.
    card = app.topicAt(0);
    await card.editButton.click();
    await card.editNameInput.fill("Natural Gas");
    await card.editKeywordsInput.fill("lng, pipeline");
    await card.saveEditButton.click();

    const renamed = app.topic("Natural Gas");
    await expect(renamed.heading).toBeVisible();
    await expect(renamed.keywords).toHaveText("lng · pipeline");
    expect(await names(user)).toEqual(["Natural Gas"]);
  });

  test("does not save an empty name", async ({ app, makeUser }) => {
    const user = await makeUser();
    await user.api.post("/api/topics", { data: { name: "Keep me" } });
    await app.gotoAs(user);

    const card = app.topicAt(0);
    await card.editButton.click();
    await card.editNameInput.fill("   ");
    await card.saveEditButton.click();

    await expect(card.editNameInput).toBeVisible();
    expect(await names(user)).toEqual(["Keep me"]);
  });

  test("shows the API's message when renaming onto an existing topic", async ({ app, makeUser }) => {
    const user = await makeUser();
    await user.api.post("/api/topics", { data: { name: "First" } });
    await user.api.post("/api/topics", { data: { name: "Second" } });
    await app.gotoAs(user);

    const second = app.topicAt(1);
    await second.editButton.click();
    await second.editNameInput.fill("First");
    await second.saveEditButton.click();

    await expect(app.pageError).toHaveText("A topic with that name already exists.");
    expect(await names(user)).toEqual(["First", "Second"]);
  });
});

test.describe("deleting topics", () => {
  test("takes two clicks: the first only asks, Cancel backs out, the second deletes", async ({ app, makeUser }) => {
    const user = await makeUser();
    await user.api.post("/api/topics", { data: { name: "Doomed" } });
    await app.gotoAs(user);
    const card = app.topic("Doomed");

    await card.deleteButton.click();
    await expect(card.deleteButton).toHaveText("Confirm delete");
    expect(await names(user), "first click must not delete").toEqual(["Doomed"]);

    await card.cancelDeleteButton.click();
    await expect(card.deleteButton).toHaveText("Delete");
    expect(await names(user)).toEqual(["Doomed"]);

    await card.deleteButton.click();
    await card.deleteButton.click();
    await expect(app.topicSections).toHaveCount(0);
    await expect(app.emptyAccountMessage).toBeVisible();
    expect(await names(user)).toEqual([]);
  });

  test("asking to delete one topic doesn't arm another", async ({ app, makeUser }) => {
    const user = await makeUser();
    await user.api.post("/api/topics", { data: { name: "Alpha" } });
    await user.api.post("/api/topics", { data: { name: "Beta" } });
    await app.gotoAs(user);

    await app.topic("Alpha").deleteButton.click();
    await expect(app.topic("Alpha").deleteButton).toHaveText("Confirm delete");
    await expect(app.topic("Beta").deleteButton).toHaveText("Delete");

    await app.topic("Beta").deleteButton.click();
    await expect(app.topic("Beta").deleteButton).toHaveText("Confirm delete");
    await expect(app.topic("Alpha").deleteButton).toHaveText("Delete");
  });
});

test.describe("Refresh my feed", () => {
  test("runs the fetch and reports what the pipeline said", async ({ app, makeUser }) => {
    const user = await makeUser();
    await app.gotoAs(user);

    await app.refreshButton.click();
    await expect(app.fetchStatus).toHaveText("stub ingest: skipped (e2e) — stub match: skipped (e2e)");
    await expect(app.refreshButton).toHaveText("Refresh my feed");
  });

  test("shows the error when the fetch fails and leaves the button usable", async ({ app, makeUser, page }) => {
    const user = await makeUser();
    await app.gotoAs(user);
    await mockApi(page, "/api/fetch", { method: "POST", status: 502, body: { error: "Fetch failed: upstream is down" } });

    await app.refreshButton.click();
    await expect(app.pageError).toHaveText("Fetch failed: upstream is down");
    await expect(app.refreshButton).toBeEnabled();
  });
});
