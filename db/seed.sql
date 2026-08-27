-- Milestone 1 hardcoded topics

INSERT INTO topics (name, keywords) VALUES
    ('ETFs', ARRAY['ETF', 'exchange-traded fund', 'index fund', 'expense ratio', 'fund flows']),
    ('US Immigration Law', ARRAY['immigration', 'visa', 'USCIS', 'green card', 'asylum', 'H-1B', 'deportation'])
ON CONFLICT (name) DO NOTHING;

-- Milestone 2 seed feed, linked to its topic so it behaves like every feed
-- created automatically since (see api's topic-create/edit handlers).
INSERT INTO feeds (url, name, topic_id) VALUES
    (
        'https://news.google.com/rss/search?q=ETF&hl=en-US&gl=US&ceid=US:en',
        'Google News: ETF',
        (SELECT id FROM topics WHERE name = 'ETFs')
    )
ON CONFLICT (url) DO NOTHING;

-- Default watched tickers
INSERT INTO tickers (symbol) VALUES
    ('OKLO'),
    ('COIN')
ON CONFLICT (symbol) DO NOTHING;
