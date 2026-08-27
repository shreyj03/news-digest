# News Digest

A website where you add topics and each morning it fetches and shows fresh articles matched to those topics.

**Stack:** React/TypeScript/Vite frontend (`web/`), Express/TypeScript API (`api/`), standalone ingestion script (`ingest/`), Postgres (`db/`).
**Status:** Milestone 5 complete plus real UX/correctness fixes and a from-scratch newspaper-style visual redesign (newsprint paper, ink, one masthead red, Playfair Display nameplate + Newsreader headlines + IBM Plex Mono data — see DECISIONS.md). Topics auto-manage their own feed on create/rename; matching is word-boundary + full transactional recompute per run; feed shows today's articles with a `stale`-flagged fallback to recent ones; 2-column uniform-height grid; live ticker sidebar via Yahoo Finance's no-key endpoint.

**Milestone 6 (deployment) — live.** Scope changed from plan.md's original "node-cron locally, EventBridge deployed" to a real free hosted deployment (user's explicit request, driven by a hard "ready before 8am" requirement local scheduling can't honestly guarantee). Deployed via the Render + Neon MCP servers directly (user connected both; Claude drove project/service creation, schema, env vars, and GitHub secrets):
- Frontend: https://news-digest-web.onrender.com (Render static site)
- API: https://news-digest-api-a1q4.onrender.com (Render free web service)
- Database: Neon project `news-digest` (`wild-brook-94486900`)
- Scheduling: `.github/workflows/daily-fetch.yml`, GitHub Actions cron pinned to land at/before 7am Pacific year-round, hits `/api/fetch` with `FETCH_SECRET`
- Access: `SITE_PASSWORD`-gated auth on all mutating routes (`X-Site-Password` header, `POST /api/auth`, localStorage-backed "Unlock to edit" control) — actual password values live only in Render's env vars and this machine's shell history, not in any tracked file

Verified end-to-end live: both services deployed and responding, real DB read/write confirmed, GitHub Actions workflow manually triggered and confirmed it populates real articles, unauthenticated mutation confirmed 401, full unlock→add-topic→delete cycle exercised through the actual deployed UI via Playwright. Local dev is unaffected (all of the above is a no-op when the relevant env vars are unset).

See [plan.md](./plan.md) for the full build order, [DECISIONS.md](./DECISIONS.md) for why things were built the way they were, and [README.md](./README.md) for how to run it locally.

**Local dev note:** `.claude/settings.local.json` has a `SessionStart` hook that auto-starts the Postgres container, API, and frontend dev server if they're not already running — you shouldn't need to start them by hand unless that hook is missing or disabled.
