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

function App() {
  const [feed, setFeed] = useState<TopicFeed[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editKeywords, setEditKeywords] = useState("");

  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

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
      <h1>News Digest</h1>
      {error && <p className="error">{error}</p>}

      {feed.map((topic) => (
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
                <button onClick={cancelEdit} className="secondary">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="topic-header">
              <div>
                <h2>{topic.name}</h2>
                <p className="keywords">{topic.keywords.join(", ")}</p>
              </div>
              <div className="topic-actions">
                <button onClick={() => startEdit(topic)} className="secondary">
                  Edit
                </button>
                <button onClick={() => handleDeleteClick(topic.id)} className="danger">
                  {confirmDeleteId === topic.id ? "Confirm delete" : "Delete"}
                </button>
                {confirmDeleteId === topic.id && (
                  <button onClick={() => setConfirmDeleteId(null)} className="secondary">
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )}

          {topic.articles.length === 0 ? (
            <p className="empty">No matching articles yet.</p>
          ) : (
            <ul className="articles">
              {topic.articles.map((article) => (
                <li key={article.id}>
                  <a href={article.url} target="_blank" rel="noreferrer">
                    {article.title}
                  </a>
                  <div className="meta">
                    {article.source ?? "Unknown source"}
                    {article.published_at &&
                      ` · ${new Date(article.published_at).toLocaleDateString()}`}
                    {` · score ${article.score.toFixed(2)}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <section className="topic add-topic">
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
          {formError && <p className="error">{formError}</p>}
          <button type="submit">Add Topic</button>
        </form>
        <p className="hint">
          New topics won't show matched articles until ingestion and matching
          are run again.
        </p>
      </section>
    </main>
  );
}

export default App;
