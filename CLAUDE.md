# News Digest

A website where you add topics and each morning it fetches and shows fresh articles matched to those topics.

**Stack:** React/TypeScript/Vite frontend (`web/`), Express/TypeScript API (`api/`), standalone ingestion script (`ingest/`), Postgres (`db/`).
**Status:** Milestone 5 (topic management) complete — the feed page now supports add/edit/delete of topics directly from the UI (`POST/PUT/DELETE /api/topics`), no more editing Postgres by hand. Editing is inline on each topic card; delete requires two clicks (no native confirm dialogs — see DECISIONS.md). Verified end-to-end with Playwright. Milestone 6 (scheduling ingestion/matching via node-cron locally, EventBridge+Lambda deployed) is next.

See [plan.md](./plan.md) for the full build order, [DECISIONS.md](./DECISIONS.md) for why things were built the way they were, and [README.md](./README.md) for how to run it locally.

**Local dev note:** `.claude/settings.local.json` has a `SessionStart` hook that auto-starts the Postgres container, API, and frontend dev server if they're not already running — you shouldn't need to start them by hand unless that hook is missing or disabled.
