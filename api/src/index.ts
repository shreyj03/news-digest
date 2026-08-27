import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";

const execAsync = promisify(exec);
// api/src -> api -> project root -> ingest. Resolved from this file's own
// location rather than process.cwd() so it doesn't matter where `npm run
// dev`/`tsx` was actually launched from.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INGEST_DIR = path.join(PROJECT_ROOT, "ingest");

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

// Constant-time string compare — a plain `===` on a secret leaks timing
// information proportional to how many leading characters match.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Gates every mutating topic/ticker route. A no-op locally (SITE_PASSWORD
// unset) — this only matters once the app is reachable on the public
// internet, per plan.md's own "add auth if deployed publicly" note.
function requireSitePassword(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.SITE_PASSWORD;
  if (!expected) {
    next();
    return;
  }
  const provided = req.header("X-Site-Password");
  if (provided && safeEqual(provided, expected)) {
    next();
    return;
  }
  res.status(401).json({ error: "Site password required." });
}

// A topic's auto-generated feed is just a Google News search for the
// topic's own name — the same pattern used for the original "ETFs" feed.
function topicFeedUrl(topicName: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(topicName)}&hl=en-US&gl=US&ceid=US:en`;
}

// Both ingest/match scripts print a one-line summary as their last
// console.log — pull just that out instead of relaying npm's banner lines
// and Node's ExperimentalWarning noise to callers.
function lastMeaningfulLine(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith(">") &&
        !line.includes("ExperimentalWarning") &&
        !line.includes("Support for loading") &&
        !line.includes("trace-warnings")
    );
  return lines.at(-1) ?? "";
}

// Shells out to the same `npm run ingest`/`npm run match` commands a person
// would type by hand, rather than importing that logic into the API process
// — keeps the ingestion pipeline a genuinely separate piece (see
// DECISIONS.md), whether it's triggered by the "Fetch news" button or by
// creating/editing a topic.
async function runIngestAndMatch(): Promise<{ ingest: string; match: string }> {
  const ingestResult = await execAsync("npm run ingest", { cwd: INGEST_DIR, timeout: 60_000 });
  const matchResult = await execAsync("npm run match", { cwd: INGEST_DIR, timeout: 60_000 });
  return {
    ingest: lastMeaningfulLine(ingestResult.stdout),
    match: lastMeaningfulLine(matchResult.stdout),
  };
}

// Lets the frontend verify a password before storing it in localStorage,
// rather than storing whatever was typed and finding out it's wrong on the
// next mutating request.
app.post("/api/auth", (req, res) => {
  const expected = process.env.SITE_PASSWORD;
  if (!expected) {
    // No password configured (local dev) — nothing to unlock.
    res.json({ ok: true });
    return;
  }
  const provided = typeof req.body?.password === "string" ? req.body.password : "";
  if (safeEqual(provided, expected)) {
    res.json({ ok: true });
    return;
  }
  res.status(401).json({ error: "Wrong password." });
});

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
  requireSitePassword,
  asyncRoute(async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const keywords = parseKeywords(req.body?.keywords);

    if (!name) {
      res.status(400).json({ error: "Topic name is required." });
      return;
    }

    let topic;
    try {
      const result = await pool.query(
        "INSERT INTO topics (name, keywords) VALUES ($1, $2) RETURNING id, name, keywords, created_at",
        [name, keywords]
      );
      topic = result.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "A topic with that name already exists." });
        return;
      }
      throw err;
    }

    // Best-effort: give the new topic a feed to search, then pull+match
    // right away so it isn't empty until someone thinks to click "Fetch
    // news." None of this should fail topic creation itself — the topic
    // already exists at this point either way.
    let warning: string | undefined;
    try {
      await pool.query(
        "INSERT INTO feeds (url, name, topic_id) VALUES ($1, $2, $3)",
        [topicFeedUrl(topic.name), `Google News: ${topic.name}`, topic.id]
      );
      await runIngestAndMatch();
    } catch (err) {
      warning = `Topic created, but the first fetch failed: ${
        err instanceof Error ? err.message : "Unknown error"
      }. Try "Fetch news" once things are running again.`;
    }

    res.status(201).json(warning ? { ...topic, warning } : topic);
  })
);

app.put(
  "/api/topics/:id",
  requireSitePassword,
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

    let topic;
    try {
      const result = await pool.query(
        "UPDATE topics SET name = $1, keywords = $2 WHERE id = $3 RETURNING id, name, keywords, created_at",
        [name, keywords, id]
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Topic not found." });
        return;
      }
      topic = result.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "A topic with that name already exists." });
        return;
      }
      throw err;
    }

    // Keep this topic's feed in sync with the new name — creating one if it
    // never had one (e.g. a topic from before this feature existed), or
    // updating the search query if it did — then re-fetch so matches
    // reflect it.
    let warning: string | undefined;
    try {
      await pool.query(
        `INSERT INTO feeds (url, name, topic_id) VALUES ($1, $2, $3)
         ON CONFLICT (topic_id)
         DO UPDATE SET url = EXCLUDED.url, name = EXCLUDED.name`,
        [topicFeedUrl(topic.name), `Google News: ${topic.name}`, topic.id]
      );
      await runIngestAndMatch();
    } catch (err) {
      warning = `Topic updated, but re-fetching its articles failed: ${
        err instanceof Error ? err.message : "Unknown error"
      }. Try "Fetch news" once things are running again.`;
    }

    res.json(warning ? { ...topic, warning } : topic);
  })
);

app.delete(
  "/api/topics/:id",
  requireSitePassword,
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
        // "Today" per the server's clock (UTC in local dev) — matches
        // plan.md's punted decision to not deal with per-user timezones yet.
        const { rows: todayArticles } = await pool.query(
          `SELECT a.id, a.title, a.url, a.source, a.published_at, ta.score
           FROM topic_articles ta
           JOIN articles a ON a.id = ta.article_id
           WHERE ta.topic_id = $1
             AND a.published_at::date = CURRENT_DATE
           ORDER BY ta.score DESC
           LIMIT $2`,
          [topic.id, ARTICLES_PER_TOPIC]
        );

        if (todayArticles.length > 0) {
          return { ...topic, articles: todayArticles, stale: false };
        }

        // Nothing matched today — fall back to this topic's most recent
        // matches regardless of date, newest first, rather than leaving the
        // card empty. `stale` tells the frontend to label these as such.
        const { rows: recentArticles } = await pool.query(
          `SELECT a.id, a.title, a.url, a.source, a.published_at, ta.score
           FROM topic_articles ta
           JOIN articles a ON a.id = ta.article_id
           WHERE ta.topic_id = $1
           ORDER BY a.published_at DESC NULLS LAST
           LIMIT $2`,
          [topic.id, ARTICLES_PER_TOPIC]
        );

        return { ...topic, articles: recentArticles, stale: recentArticles.length > 0 };
      })
    );

    res.json(feed);
  })
);

// /api/fetch has two legitimate callers with two different secrets: the
// GitHub Actions scheduled workflow (server-to-server, using FETCH_SECRET —
// a token that's never shipped to the browser) and you, via the "Fetch
// news" button (using the same site password everything else is gated
// behind). Either one is accepted; neither implies the other.
function requireFetchAuth(req: Request, res: Response, next: NextFunction) {
  const fetchSecret = process.env.FETCH_SECRET;
  const authHeader = req.header("Authorization");
  if (fetchSecret && authHeader && safeEqual(authHeader, `Bearer ${fetchSecret}`)) {
    next();
    return;
  }
  requireSitePassword(req, res, next);
}

// Manual, on-demand version of what Milestone 2/3's scripts do by hand.
app.post(
  "/api/fetch",
  requireFetchAuth,
  asyncRoute(async (_req, res) => {
    try {
      const { ingest, match } = await runIngestAndMatch();
      res.json({ ok: true, ingest, match });
    } catch (err) {
      const stderr = (err as { stderr?: string })?.stderr;
      const message = stderr?.trim() || (err instanceof Error ? err.message : "Unknown error");
      res.status(502).json({ error: `Fetch failed: ${message}` });
    }
  })
);

interface Quote {
  symbol: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string | null;
  marketTime: number | null;
  error?: string;
}

// Yahoo Finance's unofficial chart endpoint — no API key required, same
// no-signup spirit as using Google News RSS for articles. Unofficial and
// could break or rate-limit without notice; each ticker fails independently
// rather than taking the whole panel down (see DECISIONS.md).
async function fetchQuote(symbol: string): Promise<Quote> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`Yahoo returned ${res.status}`);

    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== "number") {
      throw new Error("Unrecognized symbol or response shape");
    }

    const price = meta.regularMarketPrice;
    const previousClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
    const change = price - previousClose;
    const changePercent = previousClose !== 0 ? (change / previousClose) * 100 : 0;

    return {
      symbol,
      price,
      change,
      changePercent,
      currency: meta.currency ?? null,
      marketTime: meta.regularMarketTime ?? null,
    };
  } catch (err) {
    return {
      symbol,
      price: null,
      change: null,
      changePercent: null,
      currency: null,
      marketTime: null,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

app.get(
  "/api/tickers",
  asyncRoute(async (_req, res) => {
    const { rows: tickers } = await pool.query("SELECT id, symbol FROM tickers ORDER BY id");
    const withQuotes = await Promise.all(
      tickers.map(async (ticker) => ({ ...ticker, quote: await fetchQuote(ticker.symbol) }))
    );
    res.json(withQuotes);
  })
);

app.post(
  "/api/tickers",
  requireSitePassword,
  asyncRoute(async (req, res) => {
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol.trim().toUpperCase() : "";
    if (!symbol) {
      res.status(400).json({ error: "Ticker symbol is required." });
      return;
    }

    // Confirm it's a real, quotable symbol before storing it — otherwise a
    // typo just sits there as a permanently broken card.
    const quote = await fetchQuote(symbol);
    if (quote.error) {
      res.status(400).json({ error: `Couldn't find a quote for "${symbol}".` });
      return;
    }

    try {
      const result = await pool.query(
        "INSERT INTO tickers (symbol) VALUES ($1) RETURNING id, symbol",
        [symbol]
      );
      res.status(201).json({ ...result.rows[0], quote });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "That ticker is already being watched." });
        return;
      }
      throw err;
    }
  })
);

app.delete(
  "/api/tickers/:id",
  requireSitePassword,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid ticker id." });
      return;
    }

    const result = await pool.query("DELETE FROM tickers WHERE id = $1", [id]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Ticker not found." });
      return;
    }
    res.status(204).end();
  })
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
