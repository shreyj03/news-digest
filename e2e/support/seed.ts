import { randomUUID } from "node:crypto";
import type { Db } from "./db";

export interface SeedArticle {
  title: string;
  score: number;
  // Feed name as stored by ingest (e.g. "Google News: Energy"). The API's
  // outlet-diversity cap keys off the " - Outlet" suffix of the *title*
  // first, so tests control that through `title`, not this.
  source?: string;
  summary?: string | null;
  aiSummary?: string | null;
  // Days before now the article was published. 0 = today.
  daysAgo?: number;
}

export interface SeedTopicOptions {
  userId: number;
  name: string;
  keywords: string[];
  articles?: SeedArticle[];
  // Index into `articles` of the one picked as "Top story", plus recap text.
  recap?: { text: string; topArticleIndex: number | null };
}

export interface SeededTopic {
  topicId: number;
  articleIds: number[];
  articleUrls: string[];
}

// Writes a topic and its already-matched articles straight into Postgres,
// bypassing ingest.ts/match.ts. The feed is then exactly what the test says
// it is — no dependency on Google News, TF-IDF scoring, or the clock beyond
// "published N days ago".
export async function seedTopic(db: Db, opts: SeedTopicOptions): Promise<SeededTopic> {
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO topics (user_id, name, keywords) VALUES ($1, $2, $3) RETURNING id",
    [opts.userId, opts.name, opts.keywords]
  );
  const topicId = rows[0].id;

  const articleIds: number[] = [];
  const articleUrls: string[] = [];
  for (const article of opts.articles ?? []) {
    const url = `https://e2e.test/articles/${randomUUID()}`;
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO articles (url, title, summary, source, published_at, ai_summary)
       VALUES ($1, $2, $3, $4, now() - make_interval(days => $5::int), $6)
       RETURNING id`,
      [
        url,
        article.title,
        article.summary ?? null,
        article.source ?? `Google News: ${opts.name}`,
        article.daysAgo ?? 0,
        article.aiSummary ?? null,
      ]
    );
    const articleId = inserted.rows[0].id;
    articleIds.push(articleId);
    articleUrls.push(url);
    await db.query("INSERT INTO topic_articles (topic_id, article_id, score) VALUES ($1, $2, $3)", [
      topicId,
      articleId,
      article.score,
    ]);
  }

  if (opts.recap) {
    const topId =
      opts.recap.topArticleIndex === null ? null : articleIds[opts.recap.topArticleIndex] ?? null;
    await db.query(
      "INSERT INTO topic_recaps (topic_id, date, recap, top_article_id) VALUES ($1, CURRENT_DATE, $2, $3)",
      [topicId, opts.recap.text, topId]
    );
  }

  return { topicId, articleIds, articleUrls };
}

export async function deleteArticles(db: Db, ids: number[]): Promise<void> {
  if (ids.length > 0) await db.query("DELETE FROM articles WHERE id = ANY($1::int[])", [ids]);
}

// YYYY-MM-DD for "today + offsetDays" as the *database* sees it — the API's
// "today" is Postgres' CURRENT_DATE, so computing expectations in JS with
// the test machine's clock/timezone would be a flake waiting to happen.
export async function dbDate(db: Db, offsetDays = 0): Promise<string> {
  const { rows } = await db.query<{ d: string }>(
    "SELECT to_char(CURRENT_DATE + $1::int, 'YYYY-MM-DD') AS d",
    [offsetDays]
  );
  return rows[0].d;
}

export async function seedTicker(db: Db, userId: number, symbol: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO tickers (user_id, symbol) VALUES ($1, $2) RETURNING id",
    [userId, symbol]
  );
  return rows[0].id;
}

// The real flow emails a link containing this token; tests can't read an
// inbox, so they mint one directly and redeem it through the real endpoint.
export async function seedResetToken(
  db: Db,
  userId: number,
  opts: { expiresInMinutes?: number } = {}
): Promise<string> {
  const token = randomUUID().replace(/-/g, "");
  await db.query(
    `INSERT INTO password_reset_tokens (token, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3::int))`,
    [token, userId, opts.expiresInMinutes ?? 60]
  );
  return token;
}

// A row with password_hash NULL is the "unclaimed bootstrap account" state
// the multi-user migration leaves the original owner in.
export async function seedUnclaimedUser(db: Db, email: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [email]
  );
  return rows[0].id;
}
