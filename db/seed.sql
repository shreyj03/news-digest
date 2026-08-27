-- Milestone 1 hardcoded topics

INSERT INTO topics (name, keywords) VALUES
    ('ETFs', ARRAY['ETF', 'exchange-traded fund', 'index fund', 'expense ratio', 'fund flows']),
    ('US Immigration Law', ARRAY['immigration', 'visa', 'USCIS', 'green card', 'asylum', 'H-1B', 'deportation'])
ON CONFLICT (name) DO NOTHING;

-- Milestone 2 seed feed
INSERT INTO feeds (url, name) VALUES
    ('https://news.google.com/rss/search?q=ETF&hl=en-US&gl=US&ceid=US:en', 'Google News: ETF')
ON CONFLICT (url) DO NOTHING;
