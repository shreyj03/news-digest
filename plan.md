# News Digest App — Project Plan

## What this is
A website where you add topics (e.g. "AI regulation", "Seattle Kraken", "Rust language") and each morning it fetches and shows fresh articles matched to those topics. No mobile app, no push notifications. You open the site, see a feed grouped by topic.

## Final architecture (as deployed)

*Added after the build. Everything below this section is the original plan, kept as written for reference — see [DECISIONS.md](./DECISIONS.md) for the reasoning behind each place the final result differs from it.*

**Live at https://news-digest-web.onrender.com**

```
[GitHub Actions — daily cron, ~7am Pacific year-round]
                |
                v  POST /api/fetch  (Authorization: Bearer FETCH_SECRET)
[Render — news-digest-api, Express/TypeScript]
                |
                |  child process: npm run ingest && npm run match
                v
[ingest/ — RSS parsed, articles stored, TF-IDF scored into topic_articles]
                |
                v
[Neon Postgres — DATABASE_URL]
                ^
                |  GET /api/topics, /api/feed, /api/tickers
                |  POST/PUT/DELETE (gated by X-Site-Password)
[Render — news-digest-web, React/TypeScript static site]
```

- **Frontend:** React + TypeScript + Vite, as planned — deployed as a Render static site. Visual design ended up an old-newspaper look (newsprint paper, ink, one masthead red, Playfair Display nameplate + Newsreader headlines + IBM Plex Mono data) after an earlier "dark desk + paper cards" pass was explicitly replaced.
- **Backend API:** Node/Express/TypeScript, as planned — deployed as a Render free web service. Still invokes `ingest/`'s scripts as child processes (`npm run ingest && npm run match`) rather than importing that logic directly, keeping the ingestion pipeline a genuinely separate piece even though it now runs inside the same container as the web app.
- **DB:** Postgres, as planned — specifically Neon rather than a self-hosted or Render-provided instance, since Render's own free Postgres tier expires 30 days after creation.
- **Matching:** landed on the TF-IDF end of the plan's "keyword/TF-IDF" range, not the plain-keyword-count version — word-boundary matched (not substring), normalized by article length, weighted by each keyword's rarity across the ingested corpus. The raw keyword-count version shipped first and was upgraded once real data showed it couldn't discriminate strength of match.
- **Scheduler:** GitHub Actions' free scheduled workflow, not node-cron/EventBridge — hits the same `/api/fetch` a person would trigger by hand from the UI, cron-pinned to land at/before 7am Pacific year-round despite GitHub's fixed-UTC schedule and daylight saving.
- **Deploy:** Render (a web service + a static site), not a Docker container on a VM — same "doesn't need heavy infra" reasoning as the original plan, landed on a different specific platform once "deploy this for free" became the actual requirement.
- **Auth:** the plan's punted "skip login, add it later if deployed publicly" — resolved once the app actually was, with a single shared `SITE_PASSWORD` gating all mutating routes (not a full account/login system, which this single-user app doesn't need).
- **Not in the original plan:** topics auto-manage their own Google News feed on create/rename (no more hand-curating the `feeds` table); a live stock-ticker sidebar (Yahoo Finance's no-key endpoint, symbols you add/remove); a "Fetch news" button for on-demand refresh alongside the daily schedule; the feed defaults to today's articles only, falling back to a topic's most recent matches (clearly flagged as such) when nothing's from today.

**Build order:** all 7 milestones below are done, several going further than originally scoped (matching upgraded to TF-IDF; feed UI got a 2-column grid with progressive disclosure rather than a flat list; scheduling became a real deployment instead of local cron). One "Polish" item from the original list is genuinely not done yet: `ingest.ts` doesn't isolate per-feed failures — a single broken feed currently aborts the whole ingestion run rather than skipping just that feed. Exact-URL dedup has existed since Milestone 2; cross-outlet near-duplicate dedup (the same story from two different sources) was never built.

## Architecture

```
[RSS feeds] --> [Ingestion job, runs every morning]
                        |
                        v
              [Match articles to topics]
                        |
                        v
                  [Postgres DB]
                        ^
                        |
              [API reads latest matches]
                        |
                        v
              [React frontend: manage topics, view feed]
```

Two independent pieces:
- **Ingestion pipeline** — a scheduled job, not a request-response service. Runs once a day, has no idea a user is watching.
- **Web app** — a normal CRUD app (manage topics) plus a read view (today's articles). Never talks to RSS feeds directly, only reads what the ingestion job already stored.

Keeping these separate matters: if the ingestion job breaks, the website still loads fine with yesterday's data instead of hanging or erroring.

## Tech stack

- **Frontend:** React + TypeScript, Vite (skip Next.js, you don't need SSR for this)
- **Backend API:** Node.js + Express (or Fastify), TypeScript
- **DB:** Postgres
- **Scheduler:** node-cron for local dev; AWS EventBridge + Lambda for the actual daily run once deployed, since you already know AWS
- **Matching:** start with keyword/TF-IDF matching, not embeddings. Add embeddings later only if keyword matching is visibly bad. Don't start with the complex version.
- **Deploy:** Docker containers, since it's already in your stack. A single small VM or Fly.io/Render is plenty; this doesn't need Lambda-scale infra for the web app itself.

Reasoning for the "skip embeddings at first" call: embeddings solve a precision problem you don't have evidence of yet. Build the dumb version, look at how bad the matches actually are, then decide if it's worth the extra complexity and cost.

## Data model (rough)

- `topics`: id, name, keywords[], created_at
- `articles`: id, url (unique), title, summary, source, published_at
- `topic_articles`: topic_id, article_id, matched_at, score
- `feeds`: id, url, name (your curated list of RSS sources)

## Build order (milestones)

1. **Static skeleton** — Postgres schema, Express API with hardcoded topics, React page that lists them. No RSS yet. Goal: prove the plumbing works.
2. **Manual ingestion** — a script (not scheduled yet) that pulls one RSS feed, parses it, stores articles. Run it by hand.
3. **Matching** — keyword match stored articles against topics, populate `topic_articles`.
4. **Feed UI** — frontend page showing articles grouped by topic, pulling from the API.
5. **Topic management** — add/remove/edit topics from the UI instead of the DB directly.
6. **Scheduling** — wire the ingestion script into node-cron (local) then EventBridge (deployed).
7. **Polish** — dedupe articles across days, handle feeds that go down, add a handful more RSS sources.

Each milestone should be a working, visible thing, not a pile of code you can't run yet. This also maps cleanly onto how you'll actually prompt Claude Code (see below) — one milestone at a time.

## Open decisions I'm punting on for now
- Exact RSS source list — pick 10-15 once you're at milestone 2, easy to add more later
- Whether "morning" means a fixed UTC time or your local time — trivial to change later, don't decide now
- Auth — if this is just for you, skip login entirely at first and add it later if you deploy it publicly
