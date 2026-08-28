-- News Digest schema

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    -- NULL means "not yet claimed" — used only for the one bootstrap owner
    -- row created by the multi-user migration, before they've signed up
    -- through the real UI and set a password. Unusable for login while NULL.
    password_hash TEXT,
    digest_time TIME NOT NULL DEFAULT '07:00',
    digest_timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    digest_enabled BOOLEAN NOT NULL DEFAULT true,
    -- Dedupe columns for the per-user scheduler (see api/src/tick.ts) —
    -- compared against that user's own local calendar date (via Intl in
    -- their digest_timezone), not the server's UTC date.
    last_fetch_date DATE,
    last_digest_sent_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DB-backed bearer sessions — same convention as the FETCH_SECRET bearer
-- token, just per-user and revocable by deleting the row (logout).
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

-- One-time, short-lived tokens for "forgot password" — same shape as
-- sessions, but single-use (deleted on redemption) and much shorter-lived.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    keywords TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS feeds (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    -- Set when this feed was auto-generated for a topic (a Google News
    -- search for that topic's name), so creating/renaming/deleting a topic
    -- can keep its feed in sync. NULL for manually-curated feeds not tied
    -- to one topic. UNIQUE so a topic has at most one auto-generated feed.
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE UNIQUE
);

-- Shared, deduplicated-by-URL article pool — not user-scoped. Different
-- users' topics (even identically-worded ones) all match against this same
-- pool independently via topic_articles; nothing here needs to know who
-- owns which topic.
CREATE TABLE IF NOT EXISTS articles (
    id SERIAL PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    summary TEXT,
    source TEXT,
    published_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS topic_articles (
    topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    matched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    score REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (topic_id, article_id)
);

-- Ticker symbols to show live prices for in the sidebar. Prices themselves
-- aren't stored — fetched live from Yahoo Finance on each request.
CREATE TABLE IF NOT EXISTS tickers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, symbol)
);
