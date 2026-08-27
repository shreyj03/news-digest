-- Milestone 1 hardcoded topics

INSERT INTO topics (name, keywords) VALUES
    ('ETFs', ARRAY['ETF', 'exchange-traded fund', 'index fund', 'expense ratio', 'fund flows']),
    ('US Immigration Law', ARRAY['immigration', 'visa', 'USCIS', 'green card', 'asylum', 'H-1B', 'deportation'])
ON CONFLICT DO NOTHING;
