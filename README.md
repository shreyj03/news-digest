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
   Serves `GET/POST /api/topics`, `PUT/DELETE /api/topics/:id`, `GET /api/feed` (topics with their top-scoring matched articles), and `POST /api/fetch` (runs ingestion + matching on demand) on http://localhost:3001.
3. Start the frontend:
   ```
   cd web && npm install && npm run dev
   ```
   Open http://localhost:5173 — shows each topic's top 5 matched articles (expandable), lets you add/edit/delete topics, and has a "Fetch news" button to pull fresh articles without touching the terminal (Milestones 4–5).

## Running ingestion (Milestone 2)

Pulls articles from every feed listed in the `feeds` table and stores new ones in `articles` (safe to re-run — duplicate URLs are skipped).

```
cd ingest && npm install && npm run ingest
```

To add another source, insert a row into `feeds` (`url`, `name`) — no code changes needed.

## Running matching (Milestone 3)

Scores every stored article against every topic's `keywords[]` using TF-IDF (term frequency normalized by article length, weighted by each keyword's rarity across the ingested corpus) and upserts scores into `topic_articles` (safe to re-run — re-matching just recomputes and updates the score).

```
cd ingest && npm run match
```
