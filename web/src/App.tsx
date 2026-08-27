import { useEffect, useState, type FormEvent } from "react";
import "./App.css";

const API_BASE = "http://localhost:3001";

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
const VISIBLE_ARTICLES = 8;

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

  function loadFeed() {
    fetch(`${API_BASE}/api/feed`)
      .then((res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        return res.json();
      })
      .then(setFeed)
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    loadFeed();
  }, []);

  async function handleAddTopic(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const name = newName.trim();
    if (!name) {
      setFormError("Topic name is required.");
      return;
    }

    const res = await fetch(`${API_BASE}/api/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, keywords: parseKeywordsInput(newKeywords) }),
    });

    if (!res.ok) {
      setFormError(await readErrorMessage(res, `Failed to add topic (${res.status})`));
      return;
    }

    setNewName("");
    setNewKeywords("");
    loadFeed();
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

    const res = await fetch(`${API_BASE}/api/topics/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, keywords: parseKeywordsInput(editKeywords) }),
    });

    if (!res.ok) {
      setError(await readErrorMessage(res, `Failed to save topic (${res.status})`));
      return;
    }

    setEditingId(null);
    loadFeed();
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

  return (
    <main>
      <header className="masthead">
        <h1>News Digest</h1>
        <span className="date">{todayLabel}</span>
      </header>

      {error && <p className="page-error">{error}</p>}

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
                  <button onClick={() => saveEdit(topic.id)}>Save</button>
                  <button onClick={cancelEdit}>Cancel</button>
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
              <p className="empty">
                No matches yet. Run ingestion and matching to fill this in.
              </p>
            ) : (
              <>
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
          <button type="submit">Add topic</button>
          {formError && <p className="error">{formError}</p>}
        </form>
        <p className="hint">
          New topics stay empty until ingestion and matching run again.
        </p>
      </section>
    </main>
  );
}

export default App;
