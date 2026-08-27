import { useEffect, useState } from "react";
import "./App.css";

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

function App() {
  const [feed, setFeed] = useState<TopicFeed[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("http://localhost:3001/api/feed")
      .then((res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        return res.json();
      })
      .then(setFeed)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <main>
      <h1>News Digest</h1>
      {error && <p className="error">Failed to load feed: {error}</p>}
      {feed.map((topic) => (
        <section key={topic.id} className="topic">
          <h2>{topic.name}</h2>
          <p className="keywords">{topic.keywords.join(", ")}</p>
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
    </main>
  );
}

export default App;
