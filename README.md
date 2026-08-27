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
