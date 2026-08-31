import Parser from "rss-parser";
import { pool } from "./db.js";
import { summarizeArticles } from "./summarize.js";
import { normalizeTitle } from "./textUtils.js";

const parser = new Parser();

async function main() {
  // Every run is scoped to one user's own topics — there's no global mode.
  // Set by the API when it shells out to this script (a specific user's
  // "Fetch news" click, or the scheduled per-user tick); required, not
  // optional, so a stray un-scoped invocation can't silently touch
  // everyone's feeds.
  const targetUserId = process.env.TARGET_USER_ID;
  if (!targetUserId || !/^\d+$/.test(targetUserId)) {
    console.error("TARGET_USER_ID env var (a numeric user id) is required.");
    process.exit(1);
  }

  const { rows: feeds } = await pool.query<{
    id: number;
    url: string;
    name: string;
  }>(
    `SELECT f.id, f.url, f.name
     FROM feeds f
     JOIN topics t ON t.id = f.topic_id
     WHERE t.user_id = $1
     ORDER BY f.id`,
    [targetUserId]
  );

  if (feeds.length === 0) {
    console.log("No feeds for this user — nothing to ingest.");
    await pool.end();
    return;
  }

  // Cross-outlet dedup: the same story often runs under near-identical
  // headlines across multiple sources (and sometimes across multiple feeds
  // in this run). Track every normalized title already stored so only the
  // first-seen version of a story gets inserted — everything already in
  // `articles` counts too, not just this run.
  const { rows: existing } = await pool.query<{ title: string }>("SELECT title FROM articles");
  const seenTitles = new Set(existing.map((a) => normalizeTitle(a.title)));

  let totalInserted = 0;
  let totalDuplicates = 0;
  let feedsFailed = 0;
  const newlyInserted: { id: number; title: string; snippet: string | null }[] = [];

  for (const feed of feeds) {
    console.log(`Fetching feed: ${feed.name} (${feed.url})`);

    // A single unreachable or malformed feed shouldn't take the rest of the
    // run down with it — skip it and keep going.
    let parsed;
    try {
      parsed = await parser.parseURL(feed.url);
    } catch (err) {
      feedsFailed++;
      console.error(
        `  Failed to fetch/parse this feed, skipping it: ${
          err instanceof Error ? err.message : "Unknown error"
        }`
      );
      continue;
    }

    for (const item of parsed.items) {
      if (!item.link || !item.title) continue;

      const normalized = normalizeTitle(item.title);
      if (seenTitles.has(normalized)) {
        totalDuplicates++;
        continue;
      }

      const snippet = item.contentSnippet ?? null;
      const result = await pool.query<{ id: number }>(
        `INSERT INTO articles (url, title, summary, source, published_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (url) DO NOTHING
         RETURNING id`,
        [item.link, item.title, snippet, feed.name, item.pubDate ? new Date(item.pubDate) : null]
      );

      if ((result.rowCount ?? 0) > 0) {
        totalInserted++;
        seenTitles.add(normalized);
        newlyInserted.push({ id: result.rows[0].id, title: item.title, snippet });
      }
    }

    console.log(`  ${parsed.items.length} items seen in feed`);
  }

  console.log(
    `Done. ${totalInserted} new article(s) inserted, ${totalDuplicates} cross-outlet duplicate(s) skipped` +
      (feedsFailed > 0 ? `, ${feedsFailed} feed(s) failed.` : ".")
  );

  // Best-effort, display-only summaries for whatever's new this run — see
  // summarize.ts for why this never blocks or fails the ingest run.
  if (newlyInserted.length > 0) {
    const summaries = await summarizeArticles(newlyInserted);
    for (const [id, summary] of summaries) {
      await pool.query("UPDATE articles SET ai_summary = $1 WHERE id = $2", [summary, id]);
    }
    if (summaries.size > 0) {
      console.log(
        `Summarized ${summaries.size}/${newlyInserted.length} new article(s) via Gemini.`
      );
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
