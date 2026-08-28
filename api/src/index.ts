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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Best-effort — a no-op when RESEND_API_KEY/DIGEST_EMAIL_TO aren't set (so
// local dev and anyone who hasn't opted into email are unaffected), and
// never throws: a failed email shouldn't turn a successful fetch into a
// failed one. Only called from the scheduled workflow's /api/fetch?email=1,
// not the manual "Fetch news" button, so clicking that button repeatedly
// doesn't spam the inbox.
async function sendDigestEmail(): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.DIGEST_EMAIL_TO;
  if (!apiKey || !to) return;

  try {
    const feed = await buildFeed(null);
    const dateLabel = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });

    const siteUrl = process.env.SITE_URL ?? "https://news-digest-web.onrender.com";
    const iconUrl = `${siteUrl}/email-icon.png`;
    const SERIF = "Georgia,'Times New Roman',serif";
    const MONO = "'Courier New',ui-monospace,Menlo,Consolas,monospace";

    const sections = feed
      .map((topic, topicIndex) => {
        const items = topic.articles
          .slice(0, 5)
          .map((a: { url: string; title: string; source: string | null }, i: number) => {
            const outlet = extractOutlet(a.title, a.source);
            const headline = stripOutletSuffix(a.title);
            const borderTop = i === 0 ? "none" : "1px solid #ded2b0";
            const padding = i === 0 ? "0 0 14px" : "14px 0";
            return `<tr><td style="padding:${padding};border-top:${borderTop};">
              <a href="${a.url}" style="font-family:${SERIF};font-size:16px;line-height:1.35;font-weight:normal;color:#1c1a15;text-decoration:none;">${escapeHtml(headline)}</a>
              ${outlet ? `<div style="font-family:${MONO};font-size:11px;letter-spacing:0.05em;text-transform:uppercase;color:#635c4b;margin-top:5px;">${escapeHtml(outlet)}</div>` : ""}
            </td></tr>`;
          })
          .join("");
        const body =
          topic.articles.length > 0
            ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${items}</table>`
            : `<p style="font-family:${SERIF};font-style:italic;font-size:14px;color:#635c4b;margin:12px 0 0;">No matches today.</p>`;
        return `<tr><td style="padding-top:${topicIndex === 0 ? 22 : 30}px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr><td style="font-family:${SERIF};font-weight:bold;font-size:19px;letter-spacing:0.01em;text-transform:uppercase;color:#1c1a15;border-bottom:2px solid #1c1a15;padding-bottom:6px;">${escapeHtml(topic.name)}</td></tr>
          </table>
          ${body}
        </td></tr>`;
      })
      .join("");

    const topicCountLabel = `${feed.length} Topic${feed.length === 1 ? "" : "s"}`;
    const preheader = `Today's matches across ${feed.map((t) => t.name).join(", ")}.`;

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>News Digest — ${dateLabel}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1ede2;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:#f1ede2;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border-collapse:collapse;">

<tr><td align="center" style="padding:0 0 14px;">
  <img src="${iconUrl}" width="40" height="40" alt="" style="display:block;margin:0 auto 10px;border:0;" />
  <div style="font-family:${MONO};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#635c4b;margin-bottom:10px;">Est. Daily &mdash; Fresh Every Morning</div>
  <a href="${siteUrl}" style="font-family:${SERIF};font-weight:900;font-size:38px;letter-spacing:-0.01em;text-transform:uppercase;color:#1c1a15;text-decoration:none;">News Digest</a>
  <div style="font-family:${SERIF};font-style:italic;font-size:15px;color:#635c4b;margin-top:6px;">${dateLabel}</div>
</td></tr>

<tr><td style="border-top:3px double #1c1a15;border-bottom:1px solid #1c1a15;padding:8px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td align="left" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#1c1a15;">Vol. I</td>
    <td align="center" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#a3202f;">&#9679; Today's Edition</td>
    <td align="right" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#1c1a15;">${topicCountLabel}</td>
  </tr></table>
</td></tr>

${sections}

<tr><td style="padding-top:34px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
    <td align="center" style="border-top:1px solid #ded2b0;padding-top:20px;">
      <a href="${siteUrl}" style="font-family:${SERIF};font-weight:bold;font-size:14px;color:#a3202f;text-decoration:none;">Read today's full digest &rarr;</a>
      <div style="font-family:${MONO};font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#635c4b;margin-top:10px;">news-digest-web.onrender.com</div>
    </td>
  </tr></table>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.DIGEST_EMAIL_FROM ?? "News Digest <onboarding@resend.dev>",
        to: [to],
        subject: `News Digest — ${dateLabel}`,
        html,
      }),
    });

    if (!res.ok) {
      console.error("Digest email failed:", res.status, await res.text().catch(() => ""));
    }
  } catch (err) {
    console.error("Digest email failed:", err);
  }
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
// No single outlet should be able to fill the whole digest — fetch more raw
// candidates than we need so capping still leaves close to ARTICLES_PER_TOPIC.
const MAX_PER_SOURCE = 3;
const RAW_CANDIDATE_LIMIT = 150;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Recomputed at request time rather than stored — match.ts only keeps the
// final summed score, not which keywords contributed to it. Same
// word-boundary rule match.ts itself uses, so this always agrees with why a
// score is what it is.
function matchedKeywords(text: string, keywords: string[]): string[] {
  const haystack = text.toLowerCase();
  return keywords.filter((keyword) => {
    const pattern = new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`);
    return pattern.test(haystack);
  });
}

// `articles.source` is the feed name (e.g. "Google News: ETF") — since a
// topic typically has exactly one feed, every one of its articles shares
// that same value, making it useless for outlet diversity. The actual
// outlet lives in the title suffix instead (RSS titles from these feeds are
// conventionally "Headline - Outlet"), same convention ingest.ts's own
// dedup already relies on.
function extractOutlet(title: string, fallback: string | null): string {
  const lastDash = title.lastIndexOf(" - ");
  return lastDash > 0 ? title.slice(lastDash + 3).trim() : (fallback ?? "");
}

// Same "Headline - Outlet" convention as extractOutlet, the other half of
// it — used only by the digest email so a headline doesn't show its own
// outlet twice (once inline, once in the byline underneath).
function stripOutletSuffix(title: string): string {
  const lastDash = title.lastIndexOf(" - ");
  return lastDash > 0 ? title.slice(0, lastDash).trim() : title;
}

function capBySource<T extends { title: string; source: string | null }>(
  articles: T[],
  cap: number,
  limit: number
): T[] {
  const counts = new Map<string, number>();
  const result: T[] = [];
  for (const article of articles) {
    const key = extractOutlet(article.title, article.source);
    const count = counts.get(key) ?? 0;
    if (count >= cap) continue;
    counts.set(key, count + 1);
    result.push(article);
    if (result.length >= limit) break;
  }
  return result;
}

interface RawArticle {
  id: number;
  title: string;
  url: string;
  source: string | null;
  summary: string | null;
  published_at: string | null;
  score: number;
}

function buildArticles(candidates: RawArticle[], keywords: string[]) {
  return capBySource(candidates, MAX_PER_SOURCE, ARTICLES_PER_TOPIC).map((a) => ({
    id: a.id,
    title: a.title,
    url: a.url,
    source: a.source,
    published_at: a.published_at,
    score: a.score,
    matched: matchedKeywords(`${a.title} ${a.summary ?? ""}`, keywords),
  }));
}

// Only accepts the last 7 calendar days (today included) — the history view
// is a short lookback, not a full archive browser.
function isValidRecentDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diffDays = Math.round((todayUTC.getTime() - parsed.getTime()) / 86_400_000);
  return diffDays >= 0 && diffDays <= 6;
}

const ARTICLE_COLUMNS = "a.id, a.title, a.url, a.source, a.summary, a.published_at, ta.score";

// Shared by GET /api/feed and the scheduled digest email, so both always
// agree on what "today's feed" actually looks like.
async function buildFeed(dateParam: string | null) {
  const { rows: topics } = await pool.query("SELECT id, name, keywords FROM topics ORDER BY id");

  return Promise.all(
    topics.map(async (topic) => {
      if (dateParam) {
        // A specific past day was asked for — show exactly what matched
        // then. No "today" fallback; that framing only makes sense when no
        // explicit date was requested.
        const { rows: candidates } = await pool.query<RawArticle>(
          `SELECT ${ARTICLE_COLUMNS}
           FROM topic_articles ta
           JOIN articles a ON a.id = ta.article_id
           WHERE ta.topic_id = $1 AND a.published_at::date = $2::date
           ORDER BY ta.score DESC
           LIMIT $3`,
          [topic.id, dateParam, RAW_CANDIDATE_LIMIT]
        );
        return { ...topic, articles: buildArticles(candidates, topic.keywords), stale: false };
      }

      // "Today" per the server's clock (UTC in local dev) — matches plan.md's
      // punted decision to not deal with per-user timezones yet.
      const { rows: todayCandidates } = await pool.query<RawArticle>(
        `SELECT ${ARTICLE_COLUMNS}
         FROM topic_articles ta
         JOIN articles a ON a.id = ta.article_id
         WHERE ta.topic_id = $1 AND a.published_at::date = CURRENT_DATE
         ORDER BY ta.score DESC
         LIMIT $2`,
        [topic.id, RAW_CANDIDATE_LIMIT]
      );

      if (todayCandidates.length > 0) {
        return { ...topic, articles: buildArticles(todayCandidates, topic.keywords), stale: false };
      }

      // Nothing matched today — fall back to this topic's most recent
      // matches regardless of date, newest first, rather than leaving the
      // card empty. `stale` tells the frontend to label these as such.
      const { rows: recentCandidates } = await pool.query<RawArticle>(
        `SELECT ${ARTICLE_COLUMNS}
         FROM topic_articles ta
         JOIN articles a ON a.id = ta.article_id
         WHERE ta.topic_id = $1
         ORDER BY a.published_at DESC NULLS LAST
         LIMIT $2`,
        [topic.id, RAW_CANDIDATE_LIMIT]
      );
      const articles = buildArticles(recentCandidates, topic.keywords);
      return { ...topic, articles, stale: articles.length > 0 };
    })
  );
}

app.get(
  "/api/feed",
  asyncRoute(async (req, res) => {
    const dateParam = typeof req.query.date === "string" ? req.query.date : null;
    if (dateParam && !isValidRecentDate(dateParam)) {
      res.status(400).json({ error: "date must be YYYY-MM-DD within the last 7 days." });
      return;
    }

    res.json(await buildFeed(dateParam));
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
// ?email=1 additionally sends the digest email — only the scheduled GitHub
// Actions workflow passes this, so clicking "Fetch news" in the UI never
// triggers an email on its own.
app.post(
  "/api/fetch",
  requireFetchAuth,
  asyncRoute(async (req, res) => {
    try {
      const { ingest, match } = await runIngestAndMatch();
      if (req.query.email === "1") {
        await sendDigestEmail();
      }
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
  // Up to 7 most recent daily closes, oldest first, for the sidebar
  // sparkline. Empty when unavailable — never blocks showing the price.
  history: number[];
  error?: string;
}

// Yahoo Finance's unofficial chart endpoint — no API key required, same
// no-signup spirit as using Google News RSS for articles. Unofficial and
// could break or rate-limit without notice; each ticker fails independently
// rather than taking the whole panel down (see DECISIONS.md).
async function fetchQuote(symbol: string): Promise<Quote> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`Yahoo returned ${res.status}`);

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta || typeof meta.regularMarketPrice !== "number") {
      throw new Error("Unrecognized symbol or response shape");
    }

    const price = meta.regularMarketPrice;
    const previousClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
    const change = price - previousClose;
    const changePercent = previousClose !== 0 ? (change / previousClose) * 100 : 0;

    const closes: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
    const history = closes
      .filter((c): c is number => typeof c === "number")
      .slice(-7);

    return {
      symbol,
      price,
      change,
      changePercent,
      currency: meta.currency ?? null,
      marketTime: meta.regularMarketTime ?? null,
      history,
    };
  } catch (err) {
    return {
      symbol,
      price: null,
      change: null,
      changePercent: null,
      currency: null,
      marketTime: null,
      history: [],
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
