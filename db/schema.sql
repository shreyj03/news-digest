-- News Digest schema (Milestone 1: static skeleton)

CREATE TABLE IF NOT EXISTS topics (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    keywords TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
    symbol TEXT NOT NULL UNIQUE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
