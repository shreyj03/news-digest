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
   Serves `GET /api/topics` on http://localhost:3001.
3. Start the frontend:
   ```
   cd web && npm install && npm run dev
   ```
   Open http://localhost:5173.
