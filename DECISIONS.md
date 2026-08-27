# Decisions

A running log of non-trivial technical decisions for this project: what was chosen, why, and what else was considered.

> Entries below dated 2026-08-26 marked "(backfilled)" were reconstructed from the project plan and setup conversation after the fact, not logged at the moment the call was made.

## 2026-08-27 — Matching score upgraded to TF-IDF

**Decision:** `topic_articles.score` is now a TF-IDF sum over a topic's keywords, not a raw keyword-hit count. For each keyword: term frequency is its occurrence count in an article's title+summary normalized by that article's word count (so a short title matching twice doesn't lose to a long article matching twice), and inverse document frequency is the smoothed `ln((N+1)/(df+1)) + 1` form (same shape scikit-learn defaults to), computed once per keyword across the whole ingested corpus. An article's score for a topic is the sum of `tf * idf` over that topic's keywords; articles with all-zero keyword hits still get no `topic_articles` row.
**Why:** plan.md groups "keyword/TF-IDF" as one matching approach, and the raw-count version from the first pass had an obvious weakness once tested on real data — with 101 of 106 articles all containing the literal word "ETF" (unsurprising, since the seed feed *is* a Google News search for "ETF"), raw counting couldn't distinguish a strongly-on-topic article from one that mentions "ETF" once in passing. IDF down-weights that common term and up-weights rarer topic keywords (e.g. "expense ratio", "fund flows"), and length-normalized TF stops long articles from winning purely by having more words. Verified on the real corpus: the top-scoring article hits two keywords in a short title; the lowest-scoring one is a very long headline where "ETF" appears once.
**Alternatives considered:**
- Keep the raw keyword-hit count — rejected once real data showed it couldn't discriminate strength of match, only presence/absence
- Embeddings-based semantic matching — still deferred per plan.md; no evidence yet that TF-IDF's matches are wrong, just that raw counting's *ranking* was too coarse
- Un-normalized TF (raw occurrence count, no division by document length) — rejected, would bias scores toward longer articles independent of actual relevance

**Bug found and fixed while building this:** `topics` had no unique constraint on `name`, so re-running `db/seed.sql` (done once during Milestone 2 setup) silently inserted duplicate topic rows instead of the `ON CONFLICT DO NOTHING` skipping them — that clause had no conflict target to match against. Added `UNIQUE` on `topics.name` in `schema.sql`, pointed `seed.sql`'s `ON CONFLICT` at it explicitly, and deleted the duplicate rows (and their spurious `topic_articles` matches) from the running dev DB.

## 2026-08-27 — First ingestion feed: Google News RSS query, not a single publisher feed

**Decision:** Milestone 2's one RSS feed is a Google News search feed (`news.google.com/rss/search?q=ETF`) rather than a single outlet's own RSS feed (e.g. ETF.com directly).
**Why:** A topic-query feed aggregates many publishers under one URL, so it's less likely to go dark than any one site's feed, and it's already thematically matched to the seeded "ETFs" topic — useful real data for Milestone 3's keyword matching. Verified working via a live fetch (106 items parsed on first run).
**Alternatives considered:**
- A single publisher's own RSS feed (e.g. ETF.com, CNBC's ETF section) — rejected for now, more single-point-of-failure risk than a query feed; may still add specific publisher feeds later per plan.md's "10-15 sources" note
- Note: Google News RSS links are Google redirect URLs, not the publisher's canonical article URL — acceptable for now since `articles.url` just needs to be unique per item, but worth knowing if dedup-across-sources becomes a concern later

## 2026-08-27 — Ingestion reads feed list from the `feeds` table, not a hardcoded URL

**Decision:** The ingestion script queries the `feeds` table for what to fetch, rather than hardcoding the feed URL in code.
**Why:** The schema already has a `feeds` table for exactly this. Reading from it means adding more sources later (plan.md's "10-15 feeds" step) is just an INSERT, not a code change.
**Alternatives considered:**
- Hardcoding the URL directly in `ingest.ts` — rejected, defers work that's essentially free right now given the table already exists

## 2026-08-27 — API queries Postgres for topics instead of returning a hardcoded array

**Decision:** `GET /api/topics` queries the `topics` table in Postgres rather than serving an in-memory hardcoded list.
**Why:** Milestone 1's goal is to prove the full plumbing (DB → API → frontend), not just the API-to-frontend leg. Seeding real rows and querying them exercises the actual data path Milestone 2+ will depend on.
**Alternatives considered:**
- Hardcoding the topics array directly in the Express route — rejected, would leave the Postgres connection unverified until Milestone 2 and defer a real integration point

## 2026-08-27 — Local dev Postgres runs in Docker on port 5433

**Decision:** Local development uses a `postgres:16` Docker container (`news-postgres`) on port 5433, not the machine's existing system-wide Postgres 16 install.
**Why:** Port 5432 was already bound by a pre-existing `/Library/PostgreSQL/16` installation running under a separate system `postgres` user, with credentials/config not owned by this project. Attempting to reuse it would mean modifying an install other things on the machine may depend on, and its `pg_hba.conf` wasn't readable to confirm safe auth settings.
**Alternatives considered:**
- Connecting to the existing system Postgres 16 on port 5432 — rejected, unknown credentials and risk of interfering with an install this project doesn't own
- Installing Postgres via Homebrew (`postgresql@14`) — attempted first, but it also tried to bind port 5432 and crash-looped against the same conflict; abandoned in favor of Docker, which sidesteps the port conflict entirely and matches the project's eventual deploy target anyway

## 2026-08-26 — Public GitHub repo (backfilled)

**Decision:** Created `news-digest` as a public repo on GitHub, in its own git repository scoped to the project folder.
**Why:** No sensitive data or credentials involved in this project; public was the user's preference. A separate, project-scoped `.git` was used instead of the pre-existing git repo rooted at the home directory, to avoid entangling this project with unrelated home-directory tracking.
**Alternatives considered:**
- Private repo — rejected, no need to restrict visibility for this project
- Reusing the existing home-directory git repo — rejected, that repo tracks the entire home folder and isn't scoped to this project

## 2026-08-26 — Deploy target: Docker on a small VM/PaaS, not serverless (backfilled)

**Decision:** Deploy the web app (API + frontend) as Docker containers on a single small VM or a PaaS like Fly.io/Render.
**Why:** Docker is already a known part of the stack, and the web app's traffic doesn't need Lambda-scale elasticity — it's a small CRUD app plus a read view.
**Alternatives considered:**
- AWS Lambda for the web app itself — rejected as unnecessary complexity/cost for this traffic pattern (Lambda is still used, just for the ingestion job — see scheduler decision below)
- Bare-metal/manual server setup without containers — rejected, Docker keeps deploys reproducible with less extra effort

## 2026-08-26 — Article matching: keyword/TF-IDF first, embeddings later if needed (backfilled)

**Decision:** Match articles to topics using keyword/TF-IDF matching initially, not embeddings.
**Why:** Embeddings solve a precision problem there's no evidence of yet. Building the simple version first and observing real match quality avoids paying for complexity that may not be needed.
**Alternatives considered:**
- Embedding-based semantic matching from day one — rejected for now; revisit only if keyword matching is visibly bad in practice

## 2026-08-26 — Scheduler: node-cron locally, AWS EventBridge + Lambda in production (backfilled)

**Decision:** Use node-cron to run the ingestion job on a schedule during local development, and AWS EventBridge + Lambda for the daily run once deployed.
**Why:** AWS is already familiar tooling, and EventBridge/Lambda is a natural fit for a job that just needs to run once a day with no server to keep alive.
**Alternatives considered:**
- Running node-cron in production inside a long-lived process — rejected, means paying for an always-on process just to fire once a day
- A third-party scheduling SaaS — not considered seriously given existing AWS familiarity

## 2026-08-26 — Database: Postgres (backfilled)

**Decision:** Use Postgres as the datastore for topics, articles, and topic-article matches.
**Why:** Relational structure fits the data model well (topics, articles, and a join table for matches with scores), and Postgres is a safe, well-understood default.
**Alternatives considered:**
- A NoSQL document store — rejected, the data is inherently relational (topics ↔ articles via a join table) and doesn't need schema flexibility
- SQLite — rejected, this app is expected to run as a deployed service, not a single-file local tool

## 2026-08-26 — Backend: Node.js + Express (or Fastify) + TypeScript (backfilled)

**Decision:** Build the API in Node.js/TypeScript using Express (or Fastify).
**Why:** Keeps the stack in one language (TypeScript) across frontend and backend, and Express/Fastify are both simple enough for what's essentially a CRUD API plus one read endpoint.
**Alternatives considered:**
- A different language/framework for the backend (e.g., Python/Django, given prior experience per [[project_stock_tracker]]) — not chosen for this project, to keep the whole stack in one language
- A heavier framework (e.g., NestJS) — rejected, unnecessary structure for the app's size

## 2026-08-26 — Frontend: React + TypeScript + Vite, not Next.js (backfilled)

**Decision:** Build the frontend with React, TypeScript, and Vite.
**Why:** The app doesn't need server-side rendering — it's a logged-in-to-yourself dashboard-style app, not something that needs SEO or fast first paint for anonymous visitors.
**Alternatives considered:**
- Next.js — rejected, its main benefits (SSR, routing conventions, API routes) aren't needed here since there's already a separate Express API and no SSR requirement

## 2026-08-26 — Decouple ingestion pipeline from the web app (backfilled)

**Decision:** Split the system into two independent pieces: a scheduled ingestion job (RSS → parse → match → store) and a normal request-response web app (API + frontend) that only ever reads what the ingestion job already stored.
**Why:** If the ingestion job breaks or an RSS feed goes down, the website should still load fine with yesterday's data instead of hanging or erroring. Coupling them would mean a scraping failure becomes a user-facing outage.
**Alternatives considered:**
- Fetching RSS feeds live on each page request — rejected, makes page load latency and reliability dependent on third-party feed uptime
- A single monolithic process handling both scheduling and serving — rejected, harder to reason about failure modes and to scale/deploy independently later
