import Parser from "rss-parser";
import { pool } from "./db.js";

const parser = new Parser();

async function main() {
  const { rows: feeds } = await pool.query<{
    id: number;
    url: string;
    name: string;
  }>("SELECT id, url, name FROM feeds ORDER BY id");

  if (feeds.length === 0) {
    console.log("No feeds in the `feeds` table — nothing to ingest.");
    await pool.end();
    return;
  }

  let totalInserted = 0;

  for (const feed of feeds) {
    console.log(`Fetching feed: ${feed.name} (${feed.url})`);
    const parsed = await parser.parseURL(feed.url);

    for (const item of parsed.items) {
      if (!item.link || !item.title) continue;

      const result = await pool.query(
        `INSERT INTO articles (url, title, summary, source, published_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (url) DO NOTHING`,
        [
          item.link,
          item.title,
          item.contentSnippet ?? null,
          feed.name,
          item.pubDate ? new Date(item.pubDate) : null,
        ]
      );

      if ((result.rowCount ?? 0) > 0) totalInserted++;
    }

    console.log(`  ${parsed.items.length} items seen in feed`);
  }

  console.log(`Done. ${totalInserted} new article(s) inserted.`);
  await pool.end();
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
