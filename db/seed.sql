-- Local dev seed user — topics/tickers now require an owner. Left
-- unclaimed (password_hash NULL, same state the real production bootstrap
-- migration uses for the live owner account) — sign up with this email
-- through the app once locally to set a password and log in as this user;
-- see DECISIONS.md for why the bootstrap/claim flow exists.
INSERT INTO users (email) VALUES ('dev@example.com')
ON CONFLICT (email) DO NOTHING;

-- Milestone 1 hardcoded topics
INSERT INTO topics (user_id, name, keywords)
SELECT id, 'ETFs', ARRAY['ETF', 'exchange-traded fund', 'index fund', 'expense ratio', 'fund flows']
FROM users WHERE email = 'dev@example.com'
ON CONFLICT (user_id, name) DO NOTHING;

INSERT INTO topics (user_id, name, keywords)
SELECT id, 'US Immigration Law', ARRAY['immigration', 'visa', 'USCIS', 'green card', 'asylum', 'H-1B', 'deportation']
FROM users WHERE email = 'dev@example.com'
ON CONFLICT (user_id, name) DO NOTHING;

-- Milestone 2 seed feed, linked to its topic so it behaves like every feed
-- created automatically since (see api's topic-create/edit handlers).
INSERT INTO feeds (url, name, topic_id)
SELECT
    'https://news.google.com/rss/search?q=ETF&hl=en-US&gl=US&ceid=US:en',
    'Google News: ETF',
    topics.id
FROM topics JOIN users ON users.id = topics.user_id
WHERE users.email = 'dev@example.com' AND topics.name = 'ETFs'
ON CONFLICT (url) DO NOTHING;

-- Default watched tickers
INSERT INTO tickers (user_id, symbol)
SELECT id, 'OKLO' FROM users WHERE email = 'dev@example.com'
ON CONFLICT (user_id, symbol) DO NOTHING;

INSERT INTO tickers (user_id, symbol)
SELECT id, 'COIN' FROM users WHERE email = 'dev@example.com'
ON CONFLICT (user_id, symbol) DO NOTHING;
