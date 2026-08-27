# News Digest

A website where you add topics and each morning it fetches and shows fresh articles matched to those topics.

See [plan.md](./plan.md) for architecture, tech stack, and build order, and [DECISIONS.md](./DECISIONS.md) for why things were built the way they were.

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
   Serves `GET/POST /api/topics`, `PUT/DELETE /api/topics/:id`, `GET /api/feed` (topics with their top-scoring matched articles), `POST /api/fetch` (runs ingestion + matching on demand), and `GET/POST /api/tickers` + `DELETE /api/tickers/:id` (live stock quotes) on http://localhost:3001.
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

## Deployed version (Milestone 6)

Runs for free on [Render](https://render.com) (`render.yaml` blueprint — an API web service + a static frontend site), with [Neon](https://neon.tech) for Postgres and a GitHub Actions scheduled workflow (`.github/workflows/daily-fetch.yml`) triggering the same `/api/fetch` the button does, once daily before 7am Pacific. See DECISIONS.md for why this shape instead of plan.md's original node-cron/EventBridge sketch.

**One-time setup:**

1. Create a free [Neon](https://neon.tech) project, copy its Postgres connection string, and apply `db/schema.sql` (and `db/seed.sql` if you want the starting topics) against it.
2. In Render: **New → Blueprint**, point at this GitHub repo, deploy. Fill in the env vars it prompts for:
   - `news-digest-api`: `DATABASE_URL` (from Neon), `FETCH_SECRET` (any random string — this is what GitHub Actions uses), `SITE_PASSWORD` (your choice — gates adding/editing/deleting topics & tickers and manual fetch; leave unset for no gate).
   - `news-digest-web`: `VITE_API_BASE` (the `news-digest-api` service's URL — only known after its first deploy, so this is a second pass: deploy, copy the API's URL, set this, redeploy the static site).
3. In the GitHub repo's settings, add two Actions secrets: `API_URL` (same API URL as above) and `FETCH_SECRET` (same value as set in Render).

The free web service spins down after 15 minutes idle, so the first request after a quiet stretch has a ~30–60s cold-start delay — the scheduled fetch's 120s timeout absorbs this.
