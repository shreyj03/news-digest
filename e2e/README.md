# End-to-end tests (Playwright)

142 test runs from 126 test definitions: HTTP-level API tests with no browser, and
browser tests on Chromium, a phone-sized Chromium, Firefox and WebKit.

```
cd e2e && npm install && npx playwright install   # once
docker start news-postgres                        # the same Postgres the dev setup uses
npm test                                          # everything (~35s)
npm run test:api                                  # API only, no browsers
npx playwright test tests/ui/topics.spec.ts --headed --project=chromium
npm run report                                    # open the HTML report of the last run
```

Playwright starts the API (port 3101) and the Vite frontend (port 5273) itself — nothing
needs to be running, and a running dev environment on 3001/5173 is never touched.

## What it covers

| Area | API specs | Browser specs |
| --- | --- | --- |
| Auth: signup, login, sessions, logout, claim-the-bootstrap-account, forgot/reset password, brute-force lockout | `auth` | `auth` |
| Topics: create/edit/delete, keyword fallback, per-topic feed | `topics` | `topics` |
| Multi-user isolation and the read-only demo | `isolation` | `demo-mode` |
| Digest settings and timezones | `digest-settings` | `digest-settings`, `timezone` |
| Feed: ranking, keyword matching, outlet cap, recap/top story, stale fallback, 7-day history | `feed` | `feed` |
| Scheduler (`/api/tick`): window logic, idempotency, per-timezone, opt-out | `tick` | — |
| "Why did this match" toggle (touch + mouse), layout at desktop and phone width, keyboard use, reduced motion, accessible names | — | `signal-meter`, `responsive`, `a11y` |
| Ticker panel (quotes stubbed) | — | `tickers` |

## How it stays deterministic

- **Its own database.** `support/global-setup.ts` drops and rebuilds `news_digest_e2e` from the
  real `db/schema.sql` on every run. Tests never touch `news_digest` (dev) or Neon.
- **No network.** The API's `INGEST_DIR` points at `fixtures/ingest-stub`, so creating a topic
  never calls Google News. Gemini, Brevo, alerts and healthcheck pings are blanked in
  `playwright.config.ts`. Yahoo quotes are stubbed per-test with `page.route`.
- **Feed content is seeded straight into Postgres** (`support/seed.ts`) — the test states exactly
  which articles matched a topic and when they were published, rather than depending on TF-IDF,
  the clock, or a real feed.
- **Every test makes its own user** (`makeUser`) and cleans it up, so tests are order-independent
  and run fully in parallel.
- **A unique client IP per test.** The API rate-limits failed logins per IP, and every test comes
  from 127.0.0.1 — without a per-test `cf-connecting-ip`, one test's bad logins would lock out its
  parallel neighbours.
- **UI tests skip the login form** by planting a session token (`gotoAs`); the form itself is
  covered once in `auth.spec.ts`.

## Known bugs, tracked as expected failures

These were found by the suite. Each is a `test.fail()` — CI stays green while the bug stands and
turns red the moment it's fixed (at which point remove the `test.fail` line).

| Bug | Test |
| --- | --- |
| `feeds.url` is globally `UNIQUE`, so a second user creating a same-named topic gets no feed of their own (and a "first fetch failed" warning) | `isolation.spec.ts` — "a same-named topic gets its own feed for each user" |
| After signup, `GET /api/me` can overwrite the detected timezone in the settings panel with the DB default; saving the panel would then revert the zone | `timezone.spec.ts` — "the settings panel shows the detected zone even if /api/me is answered first" |

One found-and-fixed: the API rejected the modern IANA timezone names Firefox and Safari report
(`Asia/Kolkata`, `Europe/Kyiv`, …) and `UTC`; see `isValidTimezone` in `api/src/schedule.ts`.

## Tags

`@crossbrowser` runs on Firefox and WebKit too; `@mobile` also runs on a Pixel 5 emulation. Everything
else runs on desktop Chromium only.

## Environment

`E2E_PG_ADMIN_URL` (default `postgres://postgres:newsdev@localhost:5433/postgres`) points at the
Postgres server used to create the throwaway database. `E2E_API_PORT` / `E2E_WEB_PORT` override the ports.
