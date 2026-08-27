# News Digest

A website where you add topics and each morning it fetches and shows fresh articles matched to those topics.

**Stack:** React/TypeScript/Vite frontend (`web/`), Express/TypeScript API (`api/`), standalone ingestion script (`ingest/`), Postgres (`db/`).
**Status:** Milestone 5 (topic management) complete, plus a real visual design pass and UX refinements — the feed page supports add/edit/delete of topics, has an actual design system (dark "desk" background, parchment topic cards, Newsreader/Inter/IBM Plex Mono type, a normalized signal-meter for match score), shows 5 articles per topic by default (expandable), and has a "Fetch news" button (`POST /api/fetch`) that shells out to the existing ingest+match scripts on demand. See DECISIONS.md for design/architecture rationale. Real per-article summaries were requested but are on hold pending an Anthropic API key. Milestone 6 (scheduling ingestion/matching via node-cron locally, EventBridge+Lambda deployed) is next — note the new "Fetch news" button already covers the manual-trigger use case, so Milestone 6 is really about automating what that button does.

See [plan.md](./plan.md) for the full build order, [DECISIONS.md](./DECISIONS.md) for why things were built the way they were, and [README.md](./README.md) for how to run it locally.

**Local dev note:** `.claude/settings.local.json` has a `SessionStart` hook that auto-starts the Postgres container, API, and frontend dev server if they're not already running — you shouldn't need to start them by hand unless that hook is missing or disabled.
