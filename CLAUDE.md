# News Digest

A website where you add topics and each morning it fetches and shows fresh articles matched to those topics.

**Stack:** React/TypeScript/Vite frontend (`web/`), Express/TypeScript API (`api/`), standalone ingestion script (`ingest/`), Postgres (`db/`).
**Status:** Milestone 5 (topic management) complete, plus a design pass and real UX/correctness fixes — topics auto-manage their own feed (creating/renaming a topic auto-creates/syncs a Google News feed for it and fetches immediately); matching uses word-boundary matching and a full transactional recompute per run; the feed shows today's articles by default and falls back to a topic's most recent matches (flagged `stale: true`) when nothing's from today; topic cards render in a uniform-height 2-column grid with "Add a topic" pinned above them (collapses to 1 column on narrow screens); shows 5 articles per topic by default (expandable); has a "Fetch news" button. A right-hand sidebar (`tickers` table, `/api/tickers`) shows live stock prices for user-selected symbols (OKLO, COIN by default) via Yahoo Finance's unofficial no-key quote endpoint, polled client-side every 60s. See DECISIONS.md for the full rationale on each. Real per-article summaries were requested but are on hold pending an Anthropic API key. Milestone 6 (scheduling ingestion/matching via node-cron locally, EventBridge+Lambda deployed) is next — the "Fetch news" button and auto-feed-on-create already cover the manual-trigger case, so Milestone 6 is really about automating what already works by hand.

See [plan.md](./plan.md) for the full build order, [DECISIONS.md](./DECISIONS.md) for why things were built the way they were, and [README.md](./README.md) for how to run it locally.

**Local dev note:** `.claude/settings.local.json` has a `SessionStart` hook that auto-starts the Postgres container, API, and frontend dev server if they're not already running — you shouldn't need to start them by hand unless that hook is missing or disabled.
