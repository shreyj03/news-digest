import { useEffect, useState } from "react";
import "./App.css";

interface Topic {
  id: number;
  name: string;
  keywords: string[];
  created_at: string;
}

function App() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("http://localhost:3001/api/topics")
      .then((res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        return res.json();
      })
      .then(setTopics)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <main>
      <h1>News Digest</h1>
      {error && <p className="error">Failed to load topics: {error}</p>}
      <ul className="topics">
        {topics.map((topic) => (
          <li key={topic.id}>
            <h2>{topic.name}</h2>
            <p className="keywords">{topic.keywords.join(", ")}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}

export default App;
