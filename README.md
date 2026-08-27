# News Digest

**Live at https://news-digest-web.onrender.com**

A personal daily news digest: tell it what topics you care about, and each morning it searches Google News, scores every article against your topics with TF-IDF, and shows you the best matches — styled like an old newspaper's front page.

## What it does

- **Topics you manage** — add a topic by name (e.g. "OKLO", "US Immigration Law") and it automatically creates a search feed for it and pulls today's matches right away. Edit or delete anytime from the page itself.
- **Real ranking, not just keyword hits** — articles are scored with TF-IDF (word-boundary matched, weighted by how rare each keyword is across everything ingested), shown as a signal-strength meter rather than a raw number.
- **Fetches itself every morning** — a GitHub Actions workflow triggers ingestion + matching daily before 7am Pacific, so it's ready before 8am with no manual step. A "Fetch news" button on the page does the same thing on demand.
- **Live stock tickers** — a sidebar with real-time prices and a 7-day sparkline (via Yahoo Finance) for symbols you add or remove.
- **Password-gated editing** — viewing the feed is open to anyone with the link; adding, editing, or deleting topics/tickers requires unlocking with a site password.
- **7-day history** — date pills above the feed let you look back at exactly what matched on any of the last 7 days, not just today.
- **"Why did this match"** — click (or tap, on mobile) an article's signal meter to see which of the topic's keywords actually hit.

See [plan.md](./plan.md) for the original architecture and build order, and [DECISIONS.md](./DECISIONS.md) for why things were actually built the way they were — including several points where the build ended up deviating from that original plan.

## Running locally (Milestone 1)

1. Start Postgres:
   ```
   docker start news-postgres   # or: docker run --name news-postgres -e POSTGRES_PASSWORD=newsdev -e POSTGRES_DB=news_digest -p 5433:5432 -d postgres:16
   ```
   Apply the schema and seed data once:
   ```
   docker exec -i news-postgres psql -U postgres -d news_digest < db/schema.sql
   docker exec -i news-postgres psql -U postgres -d news_digest < db/seed.sql
   ```
2. Start the API:
   ```
   cd api && npm install && npm run dev
   ```
   Serves `GET/POST /api/topics`, `PUT/DELETE /api/topics/:id`, `GET /api/feed` (optionally `?date=YYYY-MM-DD` for the last 7 days), `POST /api/fetch` (`?email=1` also sends the digest email if configured), and `GET/POST /api/tickers` + `DELETE /api/tickers/:id` (live quotes with a 7-day price history) on http://localhost:3001.
3. Start the frontend:
   ```
   cd web && npm install && npm run dev
   ```
   Open http://localhost:5173 — shows each topic's top 5 matched articles (expandable), lets you add/edit/delete topics, has a "Fetch news" button, and a right-hand sidebar with live prices for tickers you add/remove (Milestones 4–5, plus later refinements — see DECISIONS.md).

Adding a topic in the UI automatically creates a Google News search feed for it (`feeds.topic_id`) and runs the first fetch — no manual feed setup needed. To add a *non*-auto-generated source (a specific publisher's own feed, say), insert a row into `feeds` directly (`url`, `name`, `topic_id` left `NULL`).

## Running ingestion + matching by hand (Milestones 2–3)

The same two steps the "Fetch news" button runs, if you'd rather run them from the terminal:

```
cd ingest && npm install
npm run ingest   # pulls articles from every feed, stores new ones (dedup'd by URL)
npm run match    # scores every article against every topic via TF-IDF, word-boundary matched
```

Both are safe to re-run — `ingest` skips articles it's already stored, and `match` fully recomputes `topic_articles` each time (not an upsert), so a keyword edit or scoring change can't leave stale matches behind.

## Deployed version (Milestone 6) — live

- Frontend: https://news-digest-web.onrender.com
- API: https://news-digest-api-a1q4.onrender.com

Runs for free on [Render](https://render.com) (`render.yaml` blueprint — an API web service + a static frontend site), with [Neon](https://neon.tech) for Postgres and a GitHub Actions scheduled workflow (`.github/workflows/daily-fetch.yml`) triggering the same `/api/fetch` the button does, once daily before 7am Pacific. See DECISIONS.md for why this shape instead of plan.md's original node-cron/EventBridge sketch, and for how it was actually deployed (via the Render and Neon MCP servers rather than by hand).

Editing is gated behind a site password — click "Unlock to edit" and enter it (value lives in Render's env vars, not in this repo). Viewing the feed needs no password.

**To redeploy this to your own accounts:**

1. Create a free [Neon](https://neon.tech) project, copy its Postgres connection string, and apply `db/schema.sql` (and `db/seed.sql` if you want the starting topics) against it.
2. In Render: **New → Blueprint**, point at this GitHub repo, deploy. Fill in the env vars it prompts for:
   - `news-digest-api`: `DATABASE_URL` (from Neon), `FETCH_SECRET` (any random string — this is what GitHub Actions uses), `SITE_PASSWORD` (your choice — gates adding/editing/deleting topics & tickers and manual fetch; leave unset for no gate).
   - `news-digest-web`: `VITE_API_BASE` (the `news-digest-api` service's URL — only known after its first deploy, so this is a second pass: deploy, copy the API's URL, set this, redeploy the static site).
3. In the GitHub repo's settings, add two Actions secrets: `API_URL` (same API URL as above) and `FETCH_SECRET` (same value as set in Render).

The free web service spins down after 15 minutes idle, so the first request after a quiet stretch has a ~30–60s cold-start delay — the scheduled fetch's 120s timeout absorbs this.

**Optional: morning digest email.** Set `RESEND_API_KEY` (a free [Resend](https://resend.com) account) and `DIGEST_EMAIL_TO` (your email) on `news-digest-api` and the scheduled workflow will email today's digest right after it fetches — no code changes needed, it's already wired in. Leave both unset to skip email entirely.
