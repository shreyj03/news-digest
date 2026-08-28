# Decisions

A running log of non-trivial technical decisions for this project: what was chosen, why, and what else was considered.

> Entries below dated 2026-08-26 marked "(backfilled)" were reconstructed from the project plan and setup conversation after the fact, not logged at the moment the call was made.

## 2026-08-28 — Email provider: Resend → Brevo

**Decision:** Replaced Resend with Brevo for both the digest and welcome emails. `sendDigestEmailForUser`/`sendWelcomeEmailForUser` now go through one shared `sendEmail(to, subject, html)` helper calling Brevo's `POST https://api.brevo.com/v3/smtp/email` (auth via an `api-key` header, not `Authorization: Bearer`; body is `{ sender: { name, email }, to: [{ email }], subject, htmlContent }`). Env vars changed from `RESEND_API_KEY` to `BREVO_API_KEY` + `DIGEST_EMAIL_FROM` (both now required together — `DIGEST_EMAIL_FROM` must be exactly the address verified as a sender in Brevo's dashboard).

**Why:** Resend's free tier only delivers from an unverified sender (`onboarding@resend.dev`) to the Resend account's own exact email — confirmed live, mid-multi-user-build: even `jainshrey2004+test@gmail.com` (same inbox as the account owner via Gmail's plus-addressing) was rejected with a 403 "not your own address." That's a hard blocker for a multi-user app — every real user besides the account owner would silently never receive email (both functions fail closed by design, so this wouldn't surface as an error, just as "nothing arrived"). Brevo's free tier (300/day) instead lets a single *verified sender email* — confirmed by entering a code Brevo emails to it, no owned domain or DNS required — send to any recipient. That's the actual requirement here, not "send more emails for free."

**Alternatives considered:**
- Verify a domain on Resend instead of switching providers — rejected as the default path since it requires owning a domain, which the plan shouldn't assume; switching to a provider whose free tier doesn't require one keeps the "free, no extra infrastructure" bar the rest of this project has held to. Domain verification on Resend remains an option later if a real domain is ever set up for other reasons.
- Amazon SES — rejected: same sandbox-until-approved restriction as Resend (every recipient must be individually verified until AWS grants "production access," a manual review), and not actually free (~$0.10/1,000 emails), just very cheap.
- SendGrid/Mailjet — same single-sender-verification model as Brevo and would have worked equally well; Brevo chosen for its more generous free daily limit (300 vs. SendGrid's 100) and because SendGrid's free tier has reportedly become less consistently available since its full migration under Twilio.

## 2026-08-28 — Multi-user accounts, demo mode, and per-user fetch-then-send scheduling

**Decision:** Replaced the single shared `SITE_PASSWORD` model with real per-user accounts (email + scrypt-hashed password, DB-backed bearer sessions in a new `sessions` table — not JWT, no new dependency, revocable by deleting a row). `topics`/`tickers` gained `user_id` and switched their unique constraints from global to `(user_id, name)`/`(user_id, symbol)`. Anonymous visitors see a configured `DEMO_USER_EMAIL` account's data read-only rather than an empty or locked page. The existing live data was attached to a pre-created, unclaimed (`password_hash IS NULL`) owner row that the real signup flow "claims" (sets a password on it) instead of rejecting as a duplicate email — the same bootstrap/claim mechanism local dev's seed data now uses too, so there's one flow, not two.

Scheduling changed more fundamentally than originally scoped: the first pass of this plan kept one global daily ingest with only *delivery time* made per-user. The user corrected this mid-build — different users have different topics, so a shared ingest doesn't make sense; each user needed their own fetch, scoped to their own topics, shortly before their own send time. `ingest.ts`/`match.ts` now require a `TARGET_USER_ID` (no more global mode at all), and a single `POST /api/tick` — triggered every 5 minutes by GitHub Actions instead of once daily — loops over every user and, per user, fetches+matches ~5 minutes before their chosen local time (via `Intl.DateTimeFormat`, correctly DST-aware) and emails them at it, each gated by `last_fetch_date`/`last_digest_sent_date` so a re-trigger within the same local day is a no-op.

**Why:** scrypt (Node's built-in `crypto.scrypt`, already used for the existing timing-safe secret comparisons) avoids adding bcrypt/argon2 as a dependency while being a sound KDF. DB-backed sessions over JWT: this app already had the "bearer token checked against a DB-adjacent source" pattern (`FETCH_SECRET`), and sessions can be revoked by deleting a row — a JWT can't be un-issued without an extra denylist mechanism anyway. The claim-the-bootstrap-row approach means there's no separate one-off migration script that only runs once and then bit-rots — signup itself is the migration path, and it's exercised by every fresh `db/seed.sql` setup too, not just the one-time production case.

**Bug caught during this build:** `pg`'s default type parser returns `DATE` columns as JS `Date` objects, not strings — `user.last_fetch_date !== localDate` (comparing a `Date` object to a plain `"YYYY-MM-DD"` string) is *always* true regardless of what's actually stored, so the tick's dedup silently never worked; a re-trigger within the same window kept re-fetching. Caught by actually re-triggering `/api/tick` twice in a row locally and observing `fetched: true` both times rather than assuming the dedup logic worked because it type-checked and looked right. Fixed at the source with a global `pg.types.setTypeParser(1082, ...)` override in `db.ts` (keeps the raw text Postgres already sent) rather than remembering to `::text`-cast every query touching a `DATE` column.

**Alternatives considered:**
- JWT sessions — rejected above (no clean revocation without extra state anyway, so the "stateless" benefit doesn't actually apply here)
- bcrypt/argon2 npm packages — rejected, Node's built-in scrypt is sufficient and keeps the dependency count flat, matching this project's existing pattern of preferring built-ins (see the `SITE_PASSWORD` rate-limiter and `cf-connecting-ip` work, also dependency-free)
- A separate `is_demo` flag on a topics/tickers row, or a dedicated demo-only account type — rejected in favor of `DEMO_USER_EMAIL` pointing at an ordinary account; simpler, and the demo account behaves in every way like a real one (including being fetched/emailed on its own real schedule) rather than needing special-cased code paths
- Keeping one global daily ingest and only varying delivery *time* per user — this was the original plan, corrected by the user once it became clear different users' different topics made a shared fetch nonsensical; superseded before shipping, not built

## 2026-08-27 — Match-reason tooltip switched from hover-only to click/tap

**Decision:** The signal meter's "why did this match" info was shipped as a native `title` attribute (hover tooltip). User reported not seeing it. Root cause: native `title` tooltips need a real motionless hover (~1s) to appear, and don't exist at all on touch devices — no hover state on mobile means no tooltip, ever. Rebuilt `SignalMeter` as a real `<button>` with local `open` state: clicking/tapping toggles a visible caption rendered directly in the page (dark chip, positioned under the meter), which works identically on mouse and touch. Kept the `title` attribute too, as a free bonus for anyone who does hover with a mouse.
**Why:** confirmed live — the deployed DOM already had the correct `title` attribute (checked directly via Playwright before assuming anything was broken), so this wasn't a deploy bug, it was the interaction model itself being unreliable on the device the user actually checked from.
**Alternatives considered:**
- A custom hover-triggered tooltip (CSS `:hover` + `visibility`) — rejected, same fundamental problem: still invisible on touch devices, the most likely culprit
- `alert()`/native dialog on click — rejected, blocks the page and is a worse interaction than an inline caption

## 2026-08-27 — Match-reason click: made exclusive/dismissible, kept native hover

**Decision:** Follow-up to the entry above. User reported the click-toggle caption "just stays there" once opened, and that hover still has its usual ~1s native delay (expected, not a bug — they explicitly said to leave hover as-is). Root cause of the "stays there" complaint: `open` state lived locally in each `SignalMeter`, so nothing closed one caption when another was opened, and nothing closed it on an outside click. Fixed by lifting the open/closed state up to `App` as a single `openMatchId: number | null` (only one article's caption can be open at a time) plus a document-level click listener that closes it on any click outside a meter (`e.stopPropagation()` on the meter button itself so its own click doesn't immediately re-trigger the outside-click handler). The native `title` attribute stays exactly as before — hover was never the problem, only the click behavior was.
**Why:** verified via Playwright against local dev: clicking meter 1 opens its caption; clicking meter 2 closes meter 1's and opens meter 2's; clicking anywhere else on the page closes whatever is open. Confirmed `title` is still present on the button (`getAttribute('title')` returns the match text) so hover still works independently of the click state.

## 2026-08-27 — Five post-launch improvements: sparklines, source cap, match reasons, 7-day history, email scaffold

**Decision:** Added, in one pass:
- **Ticker sparklines** — Yahoo's chart endpoint already returned a full price series when given `range`/`interval` params, previously discarded down to just `meta`. Now keeps the last 7 daily closes and renders a tiny inline SVG trend line per ticker.
- **Source diversity cap** — `/api/feed` now caps each topic's results at 3 articles per *outlet*, fetching up to 150 raw candidates by score and filtering down to `ARTICLES_PER_TOPIC` (30) so a prolific outlet can't dominate. Caught and fixed a real bug while building this: outlet identity had to come from the title suffix (`"Headline - Outlet"`), not the stored `articles.source` column — that column holds the *feed* name, and since a topic typically has exactly one feed, every one of its articles shares the same value, which would have collapsed each topic down to 3 articles total instead of 3-per-outlet. Caught by checking actual output before shipping, not assumed correct from the type signature.
- **"Why did this match" tooltip** — the signal meter's title/aria-label now lists which of the topic's keywords were actually found in the article, recomputed at request time with the same word-boundary rule `match.ts` itself uses (not stored — `match.ts` only ever kept the final summed score, not the per-keyword contributions).
- **7-day history view** — `GET /api/feed?date=YYYY-MM-DD` (validated to the last 7 days) shows exactly what matched a specific past day, no "today" fallback — that framing only makes sense for the undated default view. Frontend adds a row of date pills computed in UTC to match the server's own definition of "today".
- **Morning digest email (scaffolded, not yet active)** — `/api/fetch?email=1` sends an HTML summary via Resend after a successful ingest+match; a no-op until `RESEND_API_KEY`/`DIGEST_EMAIL_TO` are actually set, so shipping the code doesn't require the account to exist yet. Only the GitHub Actions scheduled call passes `?email=1` — the "Fetch news" button doesn't, so manual clicks never spam the inbox.
**Why:** all five were proposed as a recommended set of "next improvements" and approved together; 7-day (not full archive) history was the user's own scope call.
**Alternatives considered:**
- Storing per-keyword match contributions in `topic_articles` at match time, instead of recomputing at request time — rejected, would mean a schema change and keeping two representations of "why this matched" in sync; recomputation is cheap at this scale and always agrees with `match.ts` by construction
- A full source-diversity SQL solution (window function in the query itself) — rejected in favor of a small in-memory post-filter; simpler to read and the candidate set (150 rows) is tiny
- Sending the digest email on every `/api/fetch` call — rejected, would email on every manual "Fetch news" click; gated behind an explicit flag only the scheduled workflow sets

## 2026-08-27 — Milestone 7 (Polish): per-feed failure isolation and cross-outlet dedup
## 2026-08-27 — Milestone 7 (Polish): per-feed failure isolation and cross-outlet dedup

**Decision:** `ingest.ts` now wraps each feed's `parser.parseURL()` call in its own try/catch — a feed that's down or returns malformed XML is logged and skipped, not allowed to abort the rest of the run (previously a single bad feed would throw out of `main()` and every feed after it in the list never got processed). Separately, added cross-outlet duplicate detection: titles are normalized (outlet suffix stripped via the last `" - "` in the string, lowercased, punctuation stripped) before insert, checked against every normalized title already in `articles` (not just this run), and only the first-seen version of a story is kept.
**Why:** direct request to fix both gaps flagged in plan.md's "Final architecture" section. The dedup problem was real and measurable, not theoretical — checked the local DB before writing any code and found genuine duplicates already sitting there (one story, "Monthly Dividend ETFs Are Paying 8% to 13%...", had been ingested 4 times under 4 different outlets).
**Alternatives considered:**
- Embeddings/semantic similarity for dedup — rejected, same reasoning as the original "no embeddings until keyword matching proves insufficient" call; title-normalization catches the actual failure mode observed (same headline, different outlet) without new infrastructure
- Per-item try/catch inside each feed's loop, not just per-feed — rejected, the only likely per-item failure is a DB error, which is a real infrastructure problem worth surfacing loudly rather than silently swallowing
**Verified live, not just locally:** ran the fixed script locally against a deliberately unreachable test feed (confirmed the other feeds still processed and the failure was logged, not fatal) and confirmed the dedup counter correctly recognized already-stored duplicates without re-inserting them. Then cleaned up existing duplicates retroactively on both databases — 29 rows locally, 15 on the live Neon database (confirmed via a `DELETE` the user explicitly approved first, per the Neon MCP server's own instruction to never run destructive SQL without asking) — keeping the earliest-inserted row of each duplicate group. Confirmed the live feed still renders correctly afterward.

## 2026-08-27 — Deployment executed via Render/Neon MCP servers, not by hand in each dashboard

**Decision:** Rather than the user clicking through Render's and Neon's dashboards themselves, both platforms' official MCP servers were connected (Neon via OAuth, Render via a user-generated API key after its plugin's OAuth flow hit a registration bug — `redirect_uri is not registered for this client`) and Claude drove the actual deployment directly: created the Neon project, applied `db/schema.sql`/`seed.sql` to it, created both Render services with `render.yaml`'s build/start commands, set all env vars, and set the two GitHub Actions secrets via the already-authenticated `gh` CLI.
**Why:** direct user request ("install the mcps... and do it yourself"), and it's a meaningfully better experience than narrating dashboard clicks — the MCP tools can create resources and set config directly once the account-level authorization step (which only the user can complete) is done.
**What still required the user directly, and why:** account creation itself (Neon signup), the Neon OAuth browser consent, and generating the Render API key (`claude mcp add` with a raw key embedded in the command was blocked by Claude Code's own safety classifier — API keys in shell command arguments are treated as risky regardless of source, so that one command had to be run by the user in their own terminal). Everything past those authorization handshakes — actual resource creation, schema, env vars, deploys — was done directly via MCP.
**Verified live, not just "deployed":** curled both service URLs directly, manually triggered the GitHub Actions workflow and confirmed it populated real articles end-to-end (GitHub Actions → deployed API → Google News RSS → TF-IDF match → Neon → served back), confirmed a request with no `X-Site-Password` gets 401, and exercised the full unlock → add topic → delete topic cycle through the actual deployed UI via Playwright — not assumed working from a "live" deploy status alone (which, on inspection, reported "live" ~20s after creation and turned out to be accurate, but was verified rather than trusted).
**One gap found and fixed during verification:** the freshly-seeded Neon database only had `seed.sql`'s original ETF feed link — "US Immigration Law" had no auto-generated feed and returned 0 articles, same gap fixed locally in an earlier session. Fixed the same way: a `PUT` re-save of the topic through the live API, which the auto-feed-on-edit logic (see the "topics auto-manage their own feed" decision) picked up correctly.

## 2026-08-27 — Milestone 6 became a real free deployment, not local node-cron

**Decision:** plan.md's Milestone 6 was "node-cron locally, then EventBridge once deployed." Asked for the fetch to reliably land before 8am daily, and given local scheduling depends on the Mac being awake and a Claude Code session having started that day, the user opted to deploy for real instead — for free, replacing both the local-cron half and the AWS half of the original plan:
- **Render** (web service for the API + static site for the frontend) — already had an account.
- **Neon** for Postgres instead of Render's own Postgres product, which expires 30 days after creation (14-day grace period, then deletion) — Neon's free tier has no such expiration.
- **GitHub Actions' free scheduled workflows** (`.github/workflows/daily-fetch.yml`) instead of Render Cron Jobs (not actually free — $1/mo minimum) or AWS EventBridge+Lambda (a second cloud provider and account for one small personal app). The repo is already public, so Actions minutes are unlimited. The workflow just `curl`s the existing `/api/fetch` endpoint — no new ingestion-triggering code, reusing exactly what the "Fetch news" button already calls.
- Cron is pinned to `14:13 UTC` — GitHub's schedule cron doesn't shift for DST, so a fixed UTC time drifts by an hour across the year relative to Pacific local time. Picked the value that equals 7:13 AM in Pacific *summer* time (PDT, UTC-7); in winter (PST, UTC-8) the same UTC time lands at 6:13 AM Pacific instead — earlier, never later, so "before 8am" holds year-round without needing two seasonal cron entries.
**Why:** the user's actual requirement ("ready before 8am every morning," stated as a hard constraint) isn't something local scheduling can honestly guarantee on a personal laptop — this was surfaced and confirmed with the user (via `AskUserQuestion`) rather than silently built as node-cron anyway. Render's Postgres/Cron Job free-tier limits were verified via web search before committing to this architecture, not assumed from memory.
**Alternatives considered:**
- Local node-cron + launchd (see the two options originally proposed) — rejected once the user clarified they wanted a real hosted website, not something tied to the Mac being on
- Render's own Postgres — rejected, 30-day expiration means recurring data loss/migration the user didn't ask to sign up for
- Render Cron Jobs — rejected on cost; GitHub Actions does the identical job (an HTTP call on a timer) for zero cost, reusing an endpoint that already exists

## 2026-08-27 — Lightweight shared-password gate instead of full auth

**Decision:** Added `SITE_PASSWORD` (checked via `X-Site-Password` header, constant-time compared) gating every mutating route (`POST/PUT/DELETE /api/topics*`, `POST/DELETE /api/tickers*`) and `POST /api/fetch` (which also separately accepts `Authorization: Bearer <FETCH_SECRET>` for the GitHub Actions workflow — two independent secrets, since the automation shouldn't need to know the site password and vice versa). No user accounts, sessions, or password hashing — one password, one shared secret, checked directly against an env var. Read-only `GET` routes stay open. The frontend has a small "Unlock to edit" control that verifies the password via `POST /api/auth`, then stores it in `localStorage` and attaches it to every mutating request; a 401 anywhere clears the stored password and re-prompts. Both `SITE_PASSWORD` and `FETCH_SECRET` are no-ops when unset, so local dev is completely unaffected.
**Why:** plan.md explicitly punted auth with the condition "add it later if you deploy it publicly" — that condition is now true. A public `DELETE /api/topics/:id` with no gate at all would let anyone with the URL wipe the topic list; a full login system (accounts, password hashing, sessions) is real scope this single-user personal tool doesn't need.
**Alternatives considered:**
- Ship fully open, add auth later — considered and explicitly declined by the user once the risk (anyone can edit/delete your data) was made concrete
- Real user accounts / JWT sessions — rejected as overbuilt for an app with exactly one intended user
- Gating `GET` routes too — rejected, no reason to require a password just to view your own public digest from your phone

## 2026-08-27 — Redesigned to an old-newspaper look, replacing the "desk + paper cards" concept

**Decision:** Full visual system change per direct user request: newsprint paper background (`#f1ede2`) instead of the dark "desk," near-black ink instead of warm parchment cards, a single masthead red (`#a3202f`) instead of brass/amber, flat edges and hairline/double rules instead of rounded cards with soft shadows. New typefaces: Playfair Display for the masthead nameplate only (high-contrast, editorial, used in exactly one place — the signature), Newsreader kept for article headlines, IBM Plex Mono kept for meta/data (bylines, scores, tickers). The masthead now has a centered nameplate, an italic tagline, and a "dateline" row (today's date, fetch status, and the Fetch News button together) framed by a double rule, evoking a real paper's edition line. Topic columns get a vertical rule between them on wide screens, echoing real newsprint columns. "Add a topic" restyled as a dashed "clip and file" classified box. Tickers sidebar restyled as a plain rule-divided stock table.
**Why:** direct, explicit user request ("old newspaper style but modern") after approving the previous design's content/functionality but wanting a different visual identity. The frontend-design skill explicitly flags "broadsheet-style, hairline rules, zero border-radius" as one of three generic AI-design defaults to avoid *by default* — but also says the brief's own words win when it explicitly asks for that look, which this one does. The one restraint applied: keep it to rules/type/flat edges rather than pastiche (no blackletter logo, no fake "Vol. 1 No. 1" — the tagline and dateline are genuinely functional copy, not costume).
**Alternatives considered:**
- A dense multi-column broadsheet with tiny type — rejected as impractical for a page meant to be read at a glance every morning, not browsed like an archive
- Keeping the dark theme and just adding hairlines/serif type — rejected, wouldn't actually read as "newspaper" without the paper-colored ground newsprint requires
**Verified live:** desktop (1400px) and mobile (390px) screenshots, inline edit-form state, and confirmed all existing functionality (topic CRUD, signal meter, fetch-news, ticker add/remove) still works — this was a visual-only change, no logic touched.

## 2026-08-27 — Live ticker sidebar via Yahoo Finance's unofficial quote endpoint, no API key

**Decision:** New `tickers` table (`symbol`, unique) plus `GET/POST /api/tickers` and `DELETE /api/tickers/:id`. Prices aren't stored — `GET /api/tickers` fetches live from `query1.finance.yahoo.com/v8/finance/chart/{symbol}` on every request (per-ticker `Promise.all`, 8s timeout each), so the panel is exactly as fresh as the last request. The frontend polls it every 60s and also on the topic-feed page load. Adding a ticker validates the symbol against a real quote fetch before storing it, so a typo doesn't sit there as a permanently broken card. The panel lives in a right-hand sidebar (`position: sticky`), stacking below the main content under 980px.
**Why:** direct user request for live prices on OKLO/Coinbase, "for now" implying more will be added later — matched with `tickers` as a proper managed table + simple add/remove UI (mirroring the `topics` pattern already established) rather than hardcoding two symbols. Yahoo's endpoint needs no signup, matching this project's existing precedent of using unofficial-but-workable no-auth sources (see the Google News RSS decision) — the user explicitly confirmed this choice.
**Alternatives considered:**
- A real financial data API (Alpha Vantage, Finnhub, etc.) — more legitimate/stable, but needs an API key and signup; rejected for the same "avoid setup friction for a personal project" reasoning as the earlier Anthropic-key deferral, and the user confirmed Yahoo directly
- Caching/storing quotes server-side on a timer — rejected as unnecessary complexity for 2–3 tickers refreshed client-side every 60s; revisit if the ticker list grows large enough that per-request fan-out to Yahoo becomes a real cost
- Hardcoding OKLO/COIN in the frontend instead of a table — rejected, "tickers I select" implies ongoing management, same reasoning that drove full topic CRUD earlier in this project
**Known risk:** same as the Google News RSS dependency — this is an unofficial, undocumented Yahoo endpoint that could change shape or start blocking without notice. Each ticker fails independently (`quote.error` → "Price unavailable" card) so one bad symbol or a Yahoo outage doesn't take down the whole panel.

## 2026-08-27 — Uniform card height; fall back to recent matches when nothing's from today

**Decision:** Dropped `align-items: start` from `.topics-grid`, so cards revert to CSS Grid's default `stretch` — both cards in a row now share that row's height, at the cost of blank space under a shorter card. Separately, `/api/feed` no longer just returns an empty list for a topic with nothing from today: it falls back to that topic's most recent matches (any date, ordered by `published_at DESC`), and flags the response with `stale: true` so the frontend can show "Nothing matched today — showing the most recent matches" instead of silently mixing dates in with no explanation, or showing a dead-looking empty card.
**Why:** direct user request on both — uneven card heights read as broken/unfinished, and an empty OKLO card looked like a bug rather than "no fresh OKLO news today," which per this same session's earlier fix is genuinely possible now that the feed is date-filtered.
**Alternatives considered:**
- Keep `align-items: start` and just live with uneven cards — rejected, this was explicit feedback that it looked bad, not a case with two reasonable options
- Silently fall back to older articles with no indication they aren't from today — rejected, would misrepresent the digest's "today" framing; the `stale` flag exists specifically so the UI can be honest about what it's showing

## 2026-08-27 — Two-column layout; feed scoped to today's articles only

**Decision:** `/api/feed` now filters articles to `published_at::date = CURRENT_DATE` (server clock — UTC in local dev), on top of the existing per-topic cap and score ordering. The frontend lays out topic cards in a 2-column CSS grid (`main` widened to 1120px) above 860px, collapsing to 1 column below it; `align-items: start` so a short card doesn't stretch to match a taller neighbor in the same row.
**Why:** direct user request — single column was wasting horizontal space, and the feed was showing every article ever matched (accumulating across every "Fetch news" run) rather than reading like an actual daily digest.
**Alternatives considered:**
- A "published in the last N hours" rolling window instead of calendar-day — rejected as more complex for no real benefit at personal-project scale; calendar-day matches the mental model of "today's digest" directly
- A real per-user timezone setting — punted; plan.md already flagged "morning = fixed UTC or local time" as a decision to defer, and this filter uses the same server-clock assumption
**Note:** articles without a `published_at` (RSS items with no pubDate) are excluded by this filter, same as they'd fail any date check — acceptable since "today's articles" can't be verified for them anyway.

## 2026-08-27 — Topics auto-manage their own feed; matching switched from substring to word-boundary

**Decision:** `feeds` gained a nullable, unique `topic_id` column linking a feed to the topic it was auto-generated for. Creating a topic (`POST /api/topics`) now also inserts a Google News search feed for that topic's name (`Google News: <name>`) and immediately runs ingest+match; editing a topic's name (`PUT /api/topics/:id`) upserts that feed's query to match and re-fetches. Deleting a topic cascades its feed via the FK, same as `topic_articles` already did. `topic_id` is nullable so a manually-curated feed (e.g. a real publisher's own feed added later) isn't forced into this 1:1 shape.
**Why:** the user asked why "US Immigration Law" never got articles — root cause was that `topics` and `feeds` were fully decoupled, so adding a topic never gave the ingestion pipeline anything to go fetch for it. Auto-generating a feed at topic-creation time closes that gap the way the user expected it to already work.
**Alternatives considered:**
- Leaving feeds fully manual and just telling the user to add one by hand each time — rejected, defeats the purpose of the "add a topic" flow being self-serve
- A full many-to-many topics↔feeds join table — rejected as more structure than this app needs today; matching already scores every article against every topic regardless of source feed, so the 1:1 auto-feed is purely a convenience for "give this topic something to search," not a hard coupling
**Also found and fixed while backfilling existing topics:** `match.ts`'s keyword matching used plain substring search, so the short keyword `"OPT"` (Optional Practical Training) matched inside unrelated words like `"Options"` — surfaced for real when a stock-ticker "OKLO" topic got matched into "US Immigration Law" via an "Options Tape" headline. Switched `countOccurrences` to word-boundary-anchored regex (`\bkeyword\b`). This also exposed that matching only ever upserted rows, never removed ones that stopped qualifying (from a keyword edit, or this same fix) — changed `match.ts` to a full delete-then-reinsert per run, wrapped in a transaction, so it can't drift from what the current keywords/scoring actually justify.
**Backfilled live:** re-saved the two pre-existing topics ("US Immigration Law", "OKLO" — the latter added by the user directly through the running app, not through this session) via `PUT` to retroactively create their feeds and populate real matches, since they predated this feature.

## 2026-08-27 — Manual "Fetch news" button shells out to the existing scripts, doesn't inline them

**Decision:** `POST /api/fetch` runs `npm run ingest` then `npm run match` in the `ingest/` package as child processes (via `child_process.exec`), rather than importing that logic into the API server. The frontend gets a "Fetch news" button that calls this, shows a "Fetching…" disabled state, and on success reloads the feed and shows each script's one-line summary.
**Why:** plan.md's own architecture explicitly decouples the ingestion pipeline from the web app specifically so a scraping failure doesn't become a user-facing outage. Importing ingest/match logic directly into the Express process would blur that line; shelling out to the same commands a person would type keeps them genuinely separate processes — the button is just a convenience for triggering the same manual step, not a rewrite of it. A user-initiated on-demand refresh doesn't violate the "no live RSS fetch on page load" intent behind that decision, since it's still explicit and manual, just moved from terminal to UI.
**Alternatives considered:**
- Importing ingest/match as functions called directly in the API process — rejected, re-couples the two pieces the earlier decoupling decision was for
- A background job queue with polling status — rejected as overkill; ingest+match currently finishes in under 2 seconds against one feed, so a synchronous request/response with a disabled-button loading state is enough. Revisit if feed count grows enough to make this slow.
**Known risk, punted deliberately:** this route runs a fixed local shell command with no request input in it, so there's no injection risk today — but it's also unauthenticated. Fine for local-only personal use (auth is already a punted decision per plan.md); would need to be gated before any public deploy per plan.md's deploy step, so this route needs revisiting before then.
**Also this session:** default visible articles per topic dropped from 8 to 5 (still expandable via "Show more") per direct request; real per-article summaries were requested but held off — the stored `articles.summary` field turned out to just be the headline+source duplicated (Google News RSS doesn't provide real summaries), and generating real ones needs an LLM call and an Anthropic API key not yet configured in this project. Revisit once that's set up.

## 2026-08-27 — Real visual design pass: "briefing on a desk" concept

**Decision:** Replaced the plain unstyled boxes with an actual design system (via the `frontend-design` plugin skill): a dark neutral page background acting as a "desk," with each topic rendered as a warm parchment "briefing sheet" resting on it. Typography: Newsreader (serif) for topic names and article headlines, Inter for UI controls, IBM Plex Mono for metadata (source/date/keywords) and the score readout — chosen deliberately to avoid the three most common AI-generated-design defaults (cream+terracotta, near-black+neon, newspaper-hairline-broadsheet). The article's TF-IDF score, previously shown as a bare decimal, is now also rendered as a 5-bar "signal meter" normalized against the top-scoring article in that topic, with the raw number kept alongside for anyone who wants it — a bare float doesn't communicate match strength at a glance, and the meter does.
**Why:** The brief is a personal tool read every morning, not a marketing page, so the "hero" is the masthead showing today's date (grounds the product's actual premise — "each morning it fetches...") rather than an oversized banner. Also added progressive disclosure (8 articles shown per topic by default, "Show N more" to expand) after seeing the first pass render all 30 as one undifferentiated wall of rows — undermined the "digest" concept the scoring/capping work in Milestones 3–4 was already built around.
**Alternatives considered:**
- Reusing one of the three flagged generic AI-design defaults — rejected per the design skill's own guidance; a personal daily-use tool benefits more from a concept tied to its actual subject (a briefing/dispatch) than a trendy template
- Showing all 30 articles per topic with no disclosure control — rejected after the first screenshot made the scannability problem obvious
- A generic rounded progress-bar for score — rejected in favor of discrete signal bars, which read as "signal strength" rather than "loading progress" and don't imply a percentage-of-completion the score isn't
**Verified via Playwright**: full-page screenshots at desktop and 390px mobile widths, plus the inline edit-form state — confirmed responsive stacking, aria-labeled signal meters, and that `Cancel` correctly discards an edit-in-progress.
**Aside:** while reviewing the live app, noticed `US Immigration Law`'s keywords in the database no longer match the Milestone 1 seed (now `immigration, visa, USCIS, F1, H-1B, OPT` instead of the original set including `green card`/`asylum`/`deportation`) — Milestone 5's edit feature is live at `localhost:5173` outside of any Claude Code session, so this looks like a real edit made through the app itself rather than a bug; left as-is rather than overwritten.

## 2026-08-27 — Topic management: inline edit/delete on the feed page, no native confirm dialogs

**Decision:** Milestone 5's add/edit/delete UI lives directly on the existing feed page (no separate route/page — there's no router yet). Editing a topic swaps its card into inline text inputs with Save/Cancel; deleting requires two clicks (first click turns the button into "Confirm delete" + a Cancel button, second click actually deletes) instead of a native `window.confirm()`.
**Why:** A separate "manage topics" page would need client-side routing for a single-user app with two topics — not worth it yet. The two-click delete avoids a native browser confirm dialog, which is both worse UX (blocks the whole page, no styling) and a known automation hazard — Chrome-based tools (Claude's own browser automation included) can get stuck once a native dialog is open, so avoiding it keeps the page scriptable/testable, not just prettier.
**Alternatives considered:**
- `window.confirm()` before delete — rejected for the dialog-blocking reason above
- A dedicated `/topics` route with react-router — rejected as premature; revisit if the topic list or the management UI actually needs its own page
**API side:** `POST/PUT/DELETE /api/topics` added, wrapped in a shared `asyncRoute` helper so a rejected promise (e.g. a DB error) calls `next(err)` instead of silently hanging the client — the read-only GET routes never surfaced this gap, but a failed write leaving the browser waiting forever is a much worse failure mode. Unique-name violations (Postgres error code `23505`) map to `409`, missing rows to `404`.
**Verified live** via Playwright end-to-end: created a test topic, edited its name (confirmed the edit form pre-populates from current values), confirmed delete's two-click behavior doesn't fire on the first click, then deleted it — DB back to exactly the original 2 topics afterward.

## 2026-08-27 — One combined `/api/feed` endpoint, capped at 30 articles per topic

**Decision:** Added `GET /api/feed`, which returns every topic with its top-scoring matched articles nested inline (`ORDER BY score DESC LIMIT 30` per topic), fetched via `Promise.all` across topics. The frontend calls this single endpoint once rather than fetching topics and then per-topic articles separately.
**Why:** The feed page needs topics-with-their-articles in one shot; a single combined endpoint means one network round trip from the browser instead of 1 (topics) + N (articles per topic). The 30-per-topic cap keeps the page an actual "digest" — with 101 matched articles on "ETFs" already, showing all of them would defeat the point of a morning digest.
**Alternatives considered:**
- Separate `GET /api/topics` + `GET /api/topics/:id/articles` calls from the frontend — rejected, more round trips for no real benefit at this scale; kept `/api/topics` around anyway since Milestone 5 (topic management) will likely still want it standalone
- A single SQL query using `json_agg`/`LATERAL` instead of one query per topic — considered for avoiding N+1 queries entirely, but with only 2 topics right now the `Promise.all` version is simpler to read and just as fast; revisit if the topic count grows enough for N+1 latency to matter
- No cap on articles per topic — rejected, already-visible 101-article dump for one topic makes the page unusable as a "digest"

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
