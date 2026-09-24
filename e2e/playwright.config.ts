import { defineConfig, devices } from "@playwright/test";
import {
  API_PORT,
  API_URL,
  DEMO_EMAIL,
  E2E_DB_URL,
  FETCH_SECRET,
  INGEST_STUB_DIR,
  WEB_PORT,
  WEB_URL,
} from "./support/env";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 2 : undefined,
  reporter: isCI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    // Pure HTTP tests against the API — no browser launched at all.
    {
      name: "api",
      testMatch: "api/**/*.spec.ts",
      use: { baseURL: API_URL },
    },
    {
      name: "chromium",
      testMatch: "ui/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: WEB_URL },
    },
    // Touch + small-viewport emulation, only for specs tagged @mobile.
    {
      name: "mobile-chrome",
      testMatch: "ui/**/*.spec.ts",
      grep: /@mobile/,
      use: { ...devices["Pixel 5"], baseURL: WEB_URL },
    },
    // The same engines as Safari and Firefox, on the specs tagged
    // @crossbrowser. Engine differences are real here: the two report
    // different IANA timezone spellings than Chromium does.
    {
      name: "firefox",
      testMatch: "ui/**/*.spec.ts",
      grep: /@crossbrowser/,
      use: { ...devices["Desktop Firefox"], baseURL: WEB_URL },
    },
    {
      name: "webkit",
      testMatch: "ui/**/*.spec.ts",
      grep: /@crossbrowser/,
      use: { ...devices["Desktop Safari"], baseURL: WEB_URL },
    },
  ],
  webServer: [
    {
      // /health never touches the DB, so this comes up before global setup
      // has created the schema.
      command: "npx tsx src/index.ts",
      cwd: "../api",
      url: `${API_URL}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PORT: String(API_PORT),
        DATABASE_URL: E2E_DB_URL,
        INGEST_DIR: INGEST_STUB_DIR,
        FETCH_SECRET,
        DEMO_USER_EMAIL: DEMO_EMAIL,
        SITE_URL: WEB_URL,
        // Blank out every external integration so a developer's shell
        // (or CI secrets) can't leak real calls into a test run: no
        // Gemini (keyword fallback is deterministic), no Brevo emails,
        // no admin alerts, no healthcheck pings.
        GEMINI_API_KEY: "",
        BREVO_API_KEY: "",
        DIGEST_EMAIL_FROM: "",
        ADMIN_ALERT_EMAIL: "",
        HEALTHCHECK_PING_URL: "",
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      cwd: "../web",
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_API_BASE: API_URL },
    },
  ],
});
