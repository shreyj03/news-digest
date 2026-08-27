# News Digest

A website where you add topics and each morning it fetches and shows fresh articles matched to those topics.

**Stack:** React/TypeScript/Vite frontend (`web/`), Express/TypeScript API (`api/`), standalone ingestion script (`ingest/`), Postgres (`db/`).
**Status:** Milestone 4 (feed UI) complete — `GET /api/feed` returns each topic with its top 30 TF-IDF-scored articles nested inline, and the React page (`web/src/App.tsx`) renders topics with their matched articles (title, source, date, score), showing "No matching articles yet" for topics with none. "US Immigration Law" is still empty since no immigration feed has been ingested. Milestone 5 (topic management from the UI instead of the DB directly) is next.

See [plan.md](./plan.md) for the full build order, [DECISIONS.md](./DECISIONS.md) for why things were built the way they were, and [README.md](./README.md) for how to run it locally.

**Local dev note:** `.claude/settings.local.json` has a `SessionStart` hook that auto-starts the Postgres container, API, and frontend dev server if they're not already running — you shouldn't need to start them by hand unless that hook is missing or disabled.
