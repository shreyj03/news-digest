import express from "express";
import cors from "cors";
import { pool } from "./db.js";

const app = express();
const port = process.env.PORT ?? 3001;

app.use(cors());

app.get("/api/topics", async (_req, res) => {
  const result = await pool.query(
    "SELECT id, name, keywords, created_at FROM topics ORDER BY id"
  );
  res.json(result.rows);
});

// Cap per-topic article count so an early-morning digest stays a digest,
// not a dump of every article that ever matched.
const ARTICLES_PER_TOPIC = 30;

app.get("/api/feed", async (_req, res) => {
  const { rows: topics } = await pool.query(
    "SELECT id, name, keywords FROM topics ORDER BY id"
  );

  const feed = await Promise.all(
    topics.map(async (topic) => {
      const { rows: articles } = await pool.query(
        `SELECT a.id, a.title, a.url, a.source, a.published_at, ta.score
         FROM topic_articles ta
         JOIN articles a ON a.id = ta.article_id
         WHERE ta.topic_id = $1
         ORDER BY ta.score DESC
         LIMIT $2`,
        [topic.id, ARTICLES_PER_TOPIC]
      );
      return { ...topic, articles };
    })
  );

  res.json(feed);
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
