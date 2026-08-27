# News Digest App — Project Plan

## What this is
A website where you add topics (e.g. "AI regulation", "Seattle Kraken", "Rust language") and each morning it fetches and shows fresh articles matched to those topics. No mobile app, no push notifications. You open the site, see a feed grouped by topic.

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
