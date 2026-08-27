import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { pool } from "./db.js";

const app = express();
const port = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json());

// Express 4 doesn't catch rejected promises from async handlers on its own —
// an unhandled DB error in a POST/PUT/DELETE would otherwise just hang the
// client with no response. This wrapper forwards any rejection to next(),
// which the error-handling middleware at the bottom turns into a 500.
function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function parseKeywords(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((k): k is string => typeof k === "string")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

app.get(
  "/api/topics",
  asyncRoute(async (_req, res) => {
    const result = await pool.query(
      "SELECT id, name, keywords, created_at FROM topics ORDER BY id"
    );
    res.json(result.rows);
  })
);

app.post(
  "/api/topics",
  asyncRoute(async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const keywords = parseKeywords(req.body?.keywords);

    if (!name) {
      res.status(400).json({ error: "Topic name is required." });
      return;
    }

    try {
      const result = await pool.query(
        "INSERT INTO topics (name, keywords) VALUES ($1, $2) RETURNING id, name, keywords, created_at",
        [name, keywords]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "A topic with that name already exists." });
        return;
      }
      throw err;
    }
  })
);

app.put(
  "/api/topics/:id",
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid topic id." });
      return;
    }

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const keywords = parseKeywords(req.body?.keywords);

    if (!name) {
      res.status(400).json({ error: "Topic name is required." });
      return;
    }

    try {
      const result = await pool.query(
        "UPDATE topics SET name = $1, keywords = $2 WHERE id = $3 RETURNING id, name, keywords, created_at",
        [name, keywords, id]
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Topic not found." });
        return;
      }
      res.json(result.rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "A topic with that name already exists." });
        return;
      }
      throw err;
    }
  })
);

app.delete(
  "/api/topics/:id",
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid topic id." });
      return;
    }

    // topic_articles rows for this topic are removed automatically via
    // ON DELETE CASCADE in the schema.
    const result = await pool.query("DELETE FROM topics WHERE id = $1", [id]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Topic not found." });
      return;
    }
    res.status(204).end();
  })
);

// Cap per-topic article count so an early-morning digest stays a digest,
// not a dump of every article that ever matched.
const ARTICLES_PER_TOPIC = 30;

app.get(
  "/api/feed",
  asyncRoute(async (_req, res) => {
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
  })
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
