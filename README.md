# News Digest

**Live at https://news-digest-web.onrender.com**

A personal daily news digest: sign up, tell it what topics you care about, and each morning it searches Google News, scores every article against your topics with TF-IDF, and shows you the best matches — styled like an old newspaper's front page. Multi-user — everyone gets their own topics, tickers, and delivery schedule.

## What it does

- **Real accounts** — sign up with an email and password. Everything you add (topics, tickers, delivery preferences) is yours alone; other accounts can't see or touch it.
- **A live demo before you sign up** — visiting without an account shows a real, currently-running example account's feed, read-only, so you can see what it looks like before committing to your own.
- **Topics you manage** — add a topic by name (e.g. "OKLO", "US Immigration Law") and it automatically creates a search feed for it and pulls today's matches right away. Edit or delete anytime from the page itself.
- **Real ranking, not just keyword hits** — articles are scored with TF-IDF (word-boundary matched, weighted by how rare each keyword is across everything ingested), shown as a signal-strength meter rather than a raw number.
- **Fetches and emails on your own schedule** — pick what local time and timezone you want your digest delivered. A scheduled check runs every 5 minutes and, for each user, fetches+matches their topics a few minutes before their chosen time, then emails it. A "Refresh my feed" button on the page does an on-demand fetch of just your own topics.
- **Live stock tickers** — a sidebar with real-time prices and a 7-day sparkline (via Yahoo Finance) for symbols you add or remove.
- **7-day history** — date pills above the feed let you look back at exactly what matched on any of the last 7 days, not just today.
- **"Why did this match"** — click (or tap, on mobile) an article's signal meter to see which of the topic's keywords actually hit.

See [plan.md](./plan.md) for the original architecture and build order, and [DECISIONS.md](./DECISIONS.md) for why things were actually built the way they were — including several points where the build ended up deviating from that original plan.

## Running locally

1. Start Postgres:
   ```
   docker start news-postgres   # or: docker run --name news-postgres -e POSTGRES_PASSWORD=newsdev -e POSTGRES_DB=news_digest -p 5433:5432 -d postgres:16
   ```
   Apply the schema and seed data once:
   ```
   docker exec -i news-postgres psql -U postgres -d news_digest < db/schema.sql
   docker exec -i news-postgres psql -U postgres -d news_digest < db/seed.sql
   ```
   The seed creates an unclaimed dev account (`dev@example.com`, no password) with some starting topics/tickers — sign up with that same email through the app once to set a password and log in as it (the same "claim the bootstrap account" flow the real production migration uses — see DECISIONS.md).
2. Start the API:
   ```
   cd api && npm install && npm run dev
   ```
   Serves `POST /api/signup`/`/api/login`/`/api/logout`, `GET /api/me`, `PUT /api/me/digest`, `GET/POST /api/topics`, `PUT/DELETE /api/topics/:id`, `GET /api/feed` (optionally `?date=YYYY-MM-DD` for the last 7 days), `POST /api/fetch` (your own topics, on demand), `POST /api/tick` (the scheduled per-user fetch+send loop), and `GET/POST /api/tickers` + `DELETE /api/tickers/:id` (live quotes with a 7-day price history) on http://localhost:3001.
3. Start the frontend:
   ```
   cd web && npm install && npm run dev
   ```
   Open http://localhost:5173 — sign up or log in, add/edit/delete your own topics and tickers, "Refresh my feed" to fetch on demand, and set your digest delivery time/timezone under "Digest settings." Without logging in you'll see a read-only demo (whichever account `DEMO_USER_EMAIL` points at — unset locally by default, so the logged-out view is empty until you set it).

Adding a topic in the UI automatically creates a Google News search feed for it (`feeds.topic_id`) and runs the first fetch — no manual feed setup needed. To add a *non*-auto-generated source (a specific publisher's own feed, say), insert a row into `feeds` directly (`url`, `name`, `topic_id` left `NULL`).

## Running ingestion + matching by hand

The same two steps `/api/fetch` runs, if you'd rather run them from the terminal — both are scoped to one user's topics, so you need that user's id:

```
cd ingest && npm install
TARGET_USER_ID=1 npm run ingest   # pulls articles from that user's feeds, stores new ones (dedup'd by URL)
TARGET_USER_ID=1 npm run match    # scores every article against that user's topics via TF-IDF, word-boundary matched
```

Both are safe to re-run — `ingest` skips articles it's already stored (checked against the whole shared article pool, not just this user's), and `match` fully recomputes this user's `topic_articles` each time (not an upsert, and scoped only to their own topic ids — it never touches other users' matches), so a keyword edit or scoring change can't leave stale matches behind.

## Deployed version — live

- Frontend: https://news-digest-web.onrender.com
- API: https://news-digest-api-a1q4.onrender.com

Runs for free on [Render](https://render.com) (`render.yaml` blueprint — an API web service + a static frontend site), with [Neon](https://neon.tech) for Postgres and a GitHub Actions scheduled workflow (`.github/workflows/tick.yml`) hitting `/api/tick` every 5 minutes — the scheduling engine for every user's own fetch-then-send cycle (see DECISIONS.md for why this replaced the original single daily cron once the app went multi-user, and for how it was actually deployed, via the Render and Neon MCP servers rather than by hand).

Accounts are real email+password logins (scrypt-hashed, DB-backed sessions) — no shared site password anymore. Anyone can view the demo read-only; sign up to add your own topics/tickers.

**To redeploy this to your own accounts:**

1. Create a free [Neon](https://neon.tech) project, copy its Postgres connection string, and apply `db/schema.sql` against it (skip `db/seed.sql` on a fresh production deploy — that's for local dev only).
2. In Render: **New → Blueprint**, point at this GitHub repo, deploy. Fill in the env vars it prompts for:
   - `news-digest-api`: `DATABASE_URL` (from Neon), `FETCH_SECRET` (any random string — this is what GitHub Actions uses), `DEMO_USER_EMAIL` (which account's data anonymous visitors see — leave unset for an empty demo view until you set it).
   - `news-digest-web`: `VITE_API_BASE` (the `news-digest-api` service's URL — only known after its first deploy, so this is a second pass: deploy, copy the API's URL, set this, redeploy the static site).
3. In the GitHub repo's settings, add two Actions secrets: `API_URL` (same API URL as above) and `FETCH_SECRET` (same value as set in Render).
4. Update the hardcoded `news-digest-web.onrender.com` URLs in `web/index.html`'s Open Graph/Twitter meta tags (`og:url`, `og:image`, `twitter:image`) to your own frontend's domain — link-preview cards (WhatsApp, iMessage, Slack, etc.) read these, and a stale URL means a broken preview image even though the site itself works fine.
5. Sign up through the real UI with whatever email you want to be the demo account, then set `DEMO_USER_EMAIL` to it and redeploy `news-digest-api` — or leave `DEMO_USER_EMAIL` unset entirely for no public demo (anonymous visitors just see an empty page with sign-up/log-in links).

The free web service spins down after 15 minutes idle, so the first request after a quiet stretch has a ~30–60s cold-start delay — `/api/tick`'s 120s timeout absorbs this, though a user due right at that moment may see their digest land a few minutes later than usual that one time.

**Digest email.** Set `RESEND_API_KEY` (a free [Resend](https://resend.com) account) on `news-digest-api` and every user with "Email me a daily digest" checked (the default) gets one at their own chosen time/timezone — no code changes needed, it's already wired in. Leave it unset to skip email entirely; the rest of the app (fetching, matching, viewing) still works without it.
