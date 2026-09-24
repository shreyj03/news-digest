import { randomBytes, randomUUID } from "node:crypto";
import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { NewsDigestPage } from "../pages/NewsDigestPage";
import { API_URL } from "./env";
import { createPool, type Db } from "./db";

export interface TestUser {
  id: number;
  email: string;
  password: string;
  token: string;
  // API client already authenticated as this user.
  api: APIRequestContext;
}

type TestFixtures = {
  // A fake client IP unique to this test. The API rate-limits failed
  // logins per IP (5 strikes, then 60s lockout) and every test here comes
  // from 127.0.0.1 — without this, one test's intentional bad logins would
  // lock every parallel test out. The API reads cf-connecting-ip first
  // (it sits behind Cloudflare in production); locally nothing overwrites
  // it, so a test can pick its own "identity".
  clientIp: string;
  newApiContext: (opts?: { token?: string; ip?: string }) => Promise<APIRequestContext>;
  // Anonymous API client with this test's own IP.
  api: APIRequestContext;
  makeUser: (opts?: { email?: string; password?: string }) => Promise<TestUser>;
  app: NewsDigestPage;
};

type WorkerFixtures = {
  db: Db;
};

function randomIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${c}`;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  db: [
    async ({}, use) => {
      const db = createPool();
      await use(db);
      await db.end();
    },
    { scope: "worker" },
  ],

  clientIp: async ({}, use) => {
    await use(randomIp());
  },

  newApiContext: async ({ playwright, clientIp }, use) => {
    const contexts: APIRequestContext[] = [];
    await use(async (opts = {}) => {
      const ctx = await playwright.request.newContext({
        baseURL: API_URL,
        extraHTTPHeaders: {
          "cf-connecting-ip": opts.ip ?? clientIp,
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
      });
      contexts.push(ctx);
      return ctx;
    });
    await Promise.all(contexts.map((c) => c.dispose()));
  },

  api: async ({ newApiContext }, use) => {
    await use(await newApiContext());
  },

  // Signs a fresh user up through the real endpoint and deletes it (cascading
  // to topics, tickers, sessions) when the test ends, so tests never share
  // state and never depend on run order.
  makeUser: async ({ db, api, newApiContext }, use) => {
    const createdIds: number[] = [];
    await use(async (opts = {}) => {
      const email = (opts.email ?? `user-${randomUUID().slice(0, 8)}@e2e.test`).toLowerCase();
      const password = opts.password ?? "correct-horse-battery";
      const res = await api.post("/api/signup", { data: { email, password } });
      expect(res.status(), `signup for ${email}`).toBe(201);
      const { token, user } = (await res.json()) as { token: string; user: { id: number } };
      createdIds.push(user.id);
      return { id: user.id, email, password, token, api: await newApiContext({ token }) };
    });
    if (createdIds.length > 0) {
      await db.query("DELETE FROM users WHERE id = ANY($1::int[])", [createdIds]);
    }
  },

  // Every browser request from this test carries the test's own client IP
  // (see clientIp above), and any uncaught page exception fails the test
  // instead of scrolling past in a log nobody reads.
  page: async ({ page, clientIp }, use) => {
    await page.context().setExtraHTTPHeaders({ "cf-connecting-ip": clientIp });
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));
    await use(page);
    expect(pageErrors, "uncaught exceptions in the page").toEqual([]);
  },

  app: async ({ page }, use) => {
    await use(new NewsDigestPage(page));
  },
});

export { expect };
