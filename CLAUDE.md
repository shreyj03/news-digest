# News Digest

A website where you add topics and each morning it fetches and shows fresh articles matched to those topics.

**Stack:** React/TypeScript/Vite frontend (`web/`), Express/TypeScript API (`api/`), Postgres (`db/`).
**Status:** Milestone 1 (static skeleton) complete — Postgres schema seeded with two topics (ETFs, US Immigration Law), Express API serving `GET /api/topics` from Postgres, React page listing them. Milestone 2 (manual RSS ingestion script) is next.

See [plan.md](./plan.md) for the full build order, [DECISIONS.md](./DECISIONS.md) for why things were built the way they were, and [README.md](./README.md) for how to run it locally.

**Local dev note:** `.claude/settings.local.json` has a `SessionStart` hook that auto-starts the Postgres container, API, and frontend dev server if they're not already running — you shouldn't need to start them by hand unless that hook is missing or disabled.
