import { useEffect, useState, type FormEvent } from "react";
import "./App.css";

const API_BASE = "http://localhost:3001";
const TICKER_REFRESH_MS = 60_000;

interface Article {
  id: number;
  title: string;
  url: string;
  source: string | null;
  published_at: string | null;
  score: number;
}

interface TopicFeed {
  id: number;
  name: string;
  keywords: string[];
  articles: Article[];
  // true when nothing matched today, so `articles` is a fallback of the
  // topic's most recent matches (any date), newest first.
  stale: boolean;
}

interface Quote {
  price: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string | null;
  error?: string;
}

interface Ticker {
  id: number;
  symbol: string;
  quote: Quote;
}

function parseKeywordsInput(input: string): string[] {
  return input
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error ?? fallback;
}

// Show the strongest matches first; the rest are a click away rather than
// dumped in one wall of rows — a digest should read like one, even when the
// API is holding up to 30 per topic.
const VISIBLE_ARTICLES = 5;

const todayLabel = new Date().toLocaleDateString(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

/**
 * Match strength, normalized against the best-scoring article in the same
 * topic. A raw TF-IDF float doesn't mean anything on its own — this turns it
 * into something scannable, while the exact score stays visible underneath
 * for anyone who wants it.
 */
function SignalMeter({ score, topScore }: { score: number; topScore: number }) {
  const ratio = topScore > 0 ? score / topScore : 0;
  const lit = Math.max(1, Math.min(5, Math.round(ratio * 5)));

  return (
    <div
      className="meter"
      role="img"
      aria-label={`Match strength ${lit} of 5, score ${score.toFixed(2)}`}
    >
      <div className="meter-bars" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((bar) => (
          <span key={bar} className={bar <= lit ? "lit" : ""} />
        ))}
      </div>
      <span className="meter-score" aria-hidden="true">
        {score.toFixed(2)}
      </span>
    </div>
  );
}

function TickerRow({ ticker, onRemove }: { ticker: Ticker; onRemove: (id: number) => void }) {
  const { quote } = ticker;
  const isUp = (quote.change ?? 0) >= 0;

  return (
    <div className="ticker-row">
      <div className="ticker-top">
        <span className="ticker-symbol">{ticker.symbol}</span>
        <button
          className="ticker-remove"
          onClick={() => onRemove(ticker.id)}
          aria-label={`Stop watching ${ticker.symbol}`}
        >
          ×
        </button>
      </div>
      {quote.error || quote.price === null ? (
        <span className="ticker-unavailable">Price unavailable</span>
      ) : (
        <div className="ticker-price-line">
          <span className="ticker-price">${quote.price.toFixed(2)}</span>
          <span className={`ticker-change ${isUp ? "up" : "down"}`}>
            {isUp ? "▲" : "▼"} {Math.abs(quote.changePercent ?? 0).toFixed(2)}%
          </span>
        </div>
      )}
    </div>
  );
}

function App() {
  const [feed, setFeed] = useState<TopicFeed[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editKeywords, setEditKeywords] = useState("");

  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [expandedTopics, setExpandedTopics] = useState<Set<number>>(new Set());

  const [newName, setNewName] = useState("");
  const [newKeywords, setNewKeywords] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [addingTopic, setAddingTopic] = useState(false);

  const [savingEdit, setSavingEdit] = useState(false);

  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState<string | null>(null);

  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [newTicker, setNewTicker] = useState("");
  const [tickerError, setTickerError] = useState<string | null>(null);
  const [addingTicker, setAddingTicker] = useState(false);

  function loadFeed() {
    fetch(`${API_BASE}/api/feed`)
      .then((res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        return res.json();
      })
      .then(setFeed)
      .catch((err) => setError(err.message));
  }

  function loadTickers() {
    fetch(`${API_BASE}/api/tickers`)
      .then((res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        return res.json();
      })
      .then(setTickers)
      .catch(() => {
        // Quiet failure — the ticker panel is a nice-to-have, not core to
        // the page, so it just keeps showing its last-known prices.
      });
  }

  useEffect(() => {
    loadFeed();
    loadTickers();
    const interval = setInterval(loadTickers, TICKER_REFRESH_MS);
    return () => clearInterval(interval);
  }, []);

  async function handleAddTopic(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const name = newName.trim();
    if (!name) {
      setFormError("Topic name is required.");
      return;
    }

    setAddingTopic(true);
    try {
      const res = await fetch(`${API_BASE}/api/topics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, keywords: parseKeywordsInput(newKeywords) }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setFormError(body?.error ?? `Failed to add topic (${res.status})`);
        return;
      }

      setNewName("");
      setNewKeywords("");
      if (body?.warning) setFetchStatus(body.warning);
      loadFeed();
    } finally {
      setAddingTopic(false);
    }
  }

  function startEdit(topic: TopicFeed) {
    setConfirmDeleteId(null);
    setEditingId(topic.id);
    setEditName(topic.name);
    setEditKeywords(topic.keywords.join(", "));
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function handleFetchNews() {
    setFetching(true);
    setFetchStatus(null);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/fetch`, { method: "POST" });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setError(body?.error ?? `Fetch failed (${res.status})`);
        return;
      }

      const parts = [body?.ingest, body?.match].filter(Boolean);
      setFetchStatus(parts.length > 0 ? parts.join(" — ") : "Fetch complete.");
      loadFeed();
    } catch {
      setError("Fetch failed — is the API running?");
    } finally {
      setFetching(false);
    }
  }

  function toggleExpanded(id: number) {
    setExpandedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveEdit(id: number) {
    const name = editName.trim();
    if (!name) return;

    setSavingEdit(true);
    try {
      const res = await fetch(`${API_BASE}/api/topics/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, keywords: parseKeywordsInput(editKeywords) }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setError(body?.error ?? `Failed to save topic (${res.status})`);
        return;
      }

      if (body?.warning) setFetchStatus(body.warning);
      setEditingId(null);
      loadFeed();
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDeleteClick(id: number) {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }

    const res = await fetch(`${API_BASE}/api/topics/${id}`, { method: "DELETE" });
    setConfirmDeleteId(null);

    if (!res.ok) {
      setError(await readErrorMessage(res, `Failed to delete topic (${res.status})`));
      return;
    }

    loadFeed();
  }

  async function handleAddTicker(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTickerError(null);
    const symbol = newTicker.trim();
    if (!symbol) return;

    setAddingTicker(true);
    try {
      const res = await fetch(`${API_BASE}/api/tickers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setTickerError(body?.error ?? `Failed to add ticker (${res.status})`);
        return;
      }

      setNewTicker("");
      loadTickers();
    } finally {
      setAddingTicker(false);
    }
  }

  async function handleRemoveTicker(id: number) {
    const res = await fetch(`${API_BASE}/api/tickers/${id}`, { method: "DELETE" });
    if (res.ok) loadTickers();
  }

  return (
    <div className="page">
      <main className="content">
        <header className="masthead">
          <h1>News Digest</h1>
          <p className="tagline">Your topics, matched against fresh articles every morning.</p>
          <div className="dateline">
            <span className="date">{todayLabel}</span>
            <span className="fetch-status">
              {fetching
                ? "Fetching…"
                : (fetchStatus ?? "Pulls fresh articles, then re-scores every topic.")}
            </span>
            <button onClick={handleFetchNews} disabled={fetching}>
              {fetching ? "Fetching…" : "Fetch news"}
            </button>
          </div>
        </header>

        <section className="add-topic">
          <h2>Add a topic</h2>
          <form onSubmit={handleAddTopic}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Topic name"
            />
            <input
              value={newKeywords}
              onChange={(e) => setNewKeywords(e.target.value)}
              placeholder="Keywords, comma separated"
            />
            <button type="submit" disabled={addingTopic}>
              {addingTopic ? "Adding…" : "Add topic"}
            </button>
            {formError && <p className="error">{formError}</p>}
          </form>
          <p className="hint">
            We'll search Google News for this topic's name and pull today's matches right away.
          </p>
        </section>

        {error && <p className="page-error">{error}</p>}

        <div className="topics-grid">
          {feed.map((topic) => {
            const topScore = topic.articles.reduce((max, a) => Math.max(max, a.score), 0);
            const expanded = expandedTopics.has(topic.id);
            const visibleArticles = expanded
              ? topic.articles
              : topic.articles.slice(0, VISIBLE_ARTICLES);
            const hiddenCount = topic.articles.length - visibleArticles.length;

            return (
              <section key={topic.id} className="topic">
                {editingId === topic.id ? (
                  <div className="edit-form">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Topic name"
                    />
                    <input
                      value={editKeywords}
                      onChange={(e) => setEditKeywords(e.target.value)}
                      placeholder="Keywords, comma separated"
                    />
                    <div className="topic-actions">
                      <button onClick={() => saveEdit(topic.id)} disabled={savingEdit}>
                        {savingEdit ? "Saving…" : "Save"}
                      </button>
                      <button onClick={cancelEdit} disabled={savingEdit}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="topic-header">
                    <div>
                      <h2>{topic.name}</h2>
                      <p className="keywords">
                        {topic.keywords.join(" · ")}
                        {topic.articles.length > 0 && (
                          <span className="count"> — {topic.articles.length} matched</span>
                        )}
                      </p>
                    </div>
                    <div className="topic-actions">
                      <button onClick={() => startEdit(topic)}>Edit</button>
                      <button onClick={() => handleDeleteClick(topic.id)} className="danger">
                        {confirmDeleteId === topic.id ? "Confirm delete" : "Delete"}
                      </button>
                      {confirmDeleteId === topic.id && (
                        <button onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                      )}
                    </div>
                  </div>
                )}

                {topic.articles.length === 0 ? (
                  <p className="empty">No matches today yet. Try "Fetch news".</p>
                ) : (
                  <>
                    {topic.stale && (
                      <p className="stale-note">
                        Nothing matched today — showing the most recent matches.
                      </p>
                    )}
                    <ul className="articles">
                      {visibleArticles.map((article) => (
                        <li key={article.id}>
                          <SignalMeter score={article.score} topScore={topScore} />
                          <div className="article-body">
                            <a href={article.url} target="_blank" rel="noreferrer">
                              {article.title}
                            </a>
                            <div className="meta">
                              {article.source ?? "Unknown source"}
                              {article.published_at &&
                                ` · ${new Date(article.published_at).toLocaleDateString()}`}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                    {(hiddenCount > 0 || expanded) && topic.articles.length > VISIBLE_ARTICLES && (
                      <button className="show-more" onClick={() => toggleExpanded(topic.id)}>
                        {expanded ? "Show fewer" : `Show ${hiddenCount} more`}
                      </button>
                    )}
                  </>
                )}
              </section>
            );
          })}
        </div>
      </main>

      <aside className="tickers-panel">
        <h2>Tickers</h2>
        <div className="ticker-list">
          {tickers.map((ticker) => (
            <TickerRow key={ticker.id} ticker={ticker} onRemove={handleRemoveTicker} />
          ))}
        </div>
        <form className="add-ticker" onSubmit={handleAddTicker}>
          <input
            value={newTicker}
            onChange={(e) => setNewTicker(e.target.value)}
            placeholder="Symbol, e.g. AAPL"
          />
          <button type="submit" disabled={addingTicker}>
            {addingTicker ? "Adding…" : "Add"}
          </button>
        </form>
        {tickerError && <p className="error">{tickerError}</p>}
      </aside>
    </div>
  );
}

export default App;
