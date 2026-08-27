# News Digest

A website where you add topics and each morning it fetches and shows fresh articles matched to those topics.

**Stack:** React/TypeScript/Vite frontend (`web/`), Express/TypeScript API (`api/`), standalone ingestion script (`ingest/`), Postgres (`db/`).
**Status:** Milestone 5 (topic management) complete, plus a real visual design pass — the feed page now supports add/edit/delete of topics directly from the UI, and has an actual design system (dark "desk" background, parchment topic cards, Newsreader/Inter/IBM Plex Mono type, a normalized signal-meter for match score instead of a bare decimal, progressive disclosure past 8 articles). See DECISIONS.md for the design rationale. Milestone 6 (scheduling ingestion/matching via node-cron locally, EventBridge+Lambda deployed) is next.

See [plan.md](./plan.md) for the full build order, [DECISIONS.md](./DECISIONS.md) for why things were built the way they were, and [README.md](./README.md) for how to run it locally.

**Local dev note:** `.claude/settings.local.json` has a `SessionStart` hook that auto-starts the Postgres container, API, and frontend dev server if they're not already running — you shouldn't need to start them by hand unless that hook is missing or disabled.
