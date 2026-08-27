# News Digest

A website where you add topics and each morning it fetches and shows fresh articles matched to those topics.

**Stack:** React/TypeScript/Vite frontend (`web/`), Express/TypeScript API (`api/`), standalone ingestion script (`ingest/`), Postgres (`db/`).
**Status:** Milestone 3 (keyword matching) complete — `ingest/` now also has `npm run match`, which keyword-scores every article against every topic and upserts `topic_articles`. 101 of 106 ingested articles matched the "ETFs" topic; "US Immigration Law" has 0 matches so far since no immigration feed has been ingested yet. Milestone 4 (feed UI showing articles grouped by topic) is next.

See [plan.md](./plan.md) for the full build order, [DECISIONS.md](./DECISIONS.md) for why things were built the way they were, and [README.md](./README.md) for how to run it locally.

**Local dev note:** `.claude/settings.local.json` has a `SessionStart` hook that auto-starts the Postgres container, API, and frontend dev server if they're not already running — you shouldn't need to start them by hand unless that hook is missing or disabled.
