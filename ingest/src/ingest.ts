import Parser from "rss-parser";
import { pool } from "./db.js";
import { summarizeArticles } from "./summarize.js";
import { normalizeTitle } from "./textUtils.js";

// A real browser User-Agent and a per-feed timeout well under the 60s the
// API allows the whole `npm run ingest` process (see runIngestAndMatchForUser
// in api/src/index.ts) — Google News RSS has been seen 429/tarpitting
// requests from cloud-hosting IPs, and a single slow feed shouldn't be able
// to eat the whole run's budget by itself.
const parser = new Parser({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
  timeout: 20_000,
});

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

  // Fetch every feed concurrently — network I/O only, no shared state — so
  // the run's total wall-clock time is bounded by the single slowest feed
  // rather than their sum. Sequentially, a handful of slow/rate-limited
  // feeds could together exceed the 60s the API allows the whole process
  // (see runIngestAndMatchForUser), getting the run killed mid-way with no
  // chance to log a summary. A single unreachable or malformed feed still
  // shouldn't take the rest of the run down with it — skip it and keep
  // going.
  console.log(`Fetching ${feeds.length} feed(s)...`);
  const fetchResults = await Promise.allSettled(feeds.map((feed) => parser.parseURL(feed.url)));

  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    const fetchResult = fetchResults[i];

    if (fetchResult.status === "rejected") {
      feedsFailed++;
      console.error(
        `  Failed to fetch/parse feed "${feed.name}" (${feed.url}), skipping it: ${
          fetchResult.reason instanceof Error ? fetchResult.reason.message : "Unknown error"
        }`
      );
      continue;
    }
    const parsed = fetchResult.value;

    // Inserts stay sequential (not part of the parallel fetch above) so the
    // cross-outlet dedup Set below is updated consistently as we go — two
    // different feeds carrying the same story must not both slip past it.
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
