import { test, expect } from "../../support/fixtures";
import { mockApi, mockTicker } from "../../support/mocks";

// Quotes come from Yahoo Finance at request time, so the API's ticker routes
// are stubbed here — the tests are about how the panel renders and behaves,
// not about Yahoo being up.
const quotes = [
  mockTicker(1, "OKLO", { price: 42.5, change: 1.25, changePercent: 3.03, history: [38, 39, 41, 40, 42.5] }),
  mockTicker(2, "COIN", { price: 250, change: -5, changePercent: -1.96, history: [260, 255, 252, 250] }),
  mockTicker(3, "NOPE", { price: null, change: null, changePercent: null, history: [], error: "not found" }),
];

test.describe("ticker panel", () => {
  test("renders price, direction and a sparkline per symbol, and 'unavailable' when there's no quote", async ({ app, makeUser, page }) => {
    const user = await makeUser();
    await mockApi(page, "/api/tickers", { method: "GET", body: quotes });
    await app.gotoAs(user);

    await expect(app.tickerRows).toHaveCount(3);
    const [oklo, coin, nope] = [app.tickerRows.nth(0), app.tickerRows.nth(1), app.tickerRows.nth(2)];

    await expect(oklo.locator(".ticker-symbol")).toHaveText("OKLO");
    await expect(oklo.locator(".ticker-price")).toHaveText("$42.50");
    await expect(oklo.locator(".ticker-change")).toHaveText("▲ 3.03%");
    await expect(oklo.locator(".ticker-change")).toHaveClass(/up/);
    await expect(oklo.locator("svg.sparkline")).toHaveClass(/up/);

    await expect(coin.locator(".ticker-price")).toHaveText("$250.00");
    await expect(coin.locator(".ticker-change")).toHaveText("▼ 1.96%");
    await expect(coin.locator(".ticker-change")).toHaveClass(/down/);
    await expect(coin.locator("svg.sparkline")).toHaveClass(/down/);

    await expect(nope.locator(".ticker-unavailable")).toHaveText("Price unavailable");
    await expect(nope.locator("svg.sparkline")).toHaveCount(0);
  });

  test("removing a symbol sends the right DELETE", async ({ app, makeUser, page }) => {
    const user = await makeUser();
    await mockApi(page, "/api/tickers", { method: "GET", body: quotes });
    await mockApi(page, "/api/tickers/2", { method: "DELETE", status: 204 });
    await app.gotoAs(user);

    const deleted = page.waitForRequest((r) => r.method() === "DELETE" && r.url().endsWith("/api/tickers/2"));
    await app.tickersPanel.getByRole("button", { name: "Stop watching COIN" }).click();
    await deleted;
  });

  test("adding a symbol posts it, clears the box, and reloads the list", async ({ app, makeUser, page }) => {
    const user = await makeUser();
    let posted: unknown;
    await mockApi(page, "/api/tickers", { method: "GET", body: quotes });
    await mockApi(page, "/api/tickers", { method: "POST", status: 201, body: quotes[0], onRequest: (p) => (posted = p) });
    await app.gotoAs(user);

    await app.tickerInput.fill("aapl");
    await app.tickerAddButton.click();
    await expect(app.tickerInput).toHaveValue("");
    expect(posted).toEqual({ symbol: "aapl" });
  });

  test("shows the API's message for a symbol it can't quote", async ({ app, makeUser, page }) => {
    const user = await makeUser();
    await mockApi(page, "/api/tickers", { method: "GET", body: [] });
    await mockApi(page, "/api/tickers", { method: "POST", status: 400, body: { error: 'Couldn\'t find a quote for "ZZZZ".' } });
    await app.gotoAs(user);

    await app.tickerInput.fill("ZZZZ");
    await app.tickerAddButton.click();
    await expect(app.tickerError).toHaveText('Couldn\'t find a quote for "ZZZZ".');
    // Nothing to keep re-trying: the box keeps what was typed.
    await expect(app.tickerInput).toHaveValue("ZZZZ");
  });

  test("a visitor can see the panel but has no way to change it", async ({ app, page }) => {
    await mockApi(page, "/api/tickers", { method: "GET", body: quotes });
    await app.goto();
    await expect(app.tickerRows).toHaveCount(3);
    await expect(app.tickersPanel.getByRole("button", { name: /Stop watching/ })).toHaveCount(0);
    await expect(app.tickerInput).toHaveCount(0);
  });
});
