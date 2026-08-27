import { pool } from "./db.js";

interface Topic {
  id: number;
  name: string;
  keywords: string[];
}

interface Article {
  id: number;
  title: string;
  summary: string | null;
}

function countKeywordHits(text: string, keywords: string[]): number {
  const haystack = text.toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()))
    .length;
}

async function main() {
  const { rows: topics } = await pool.query<Topic>(
    "SELECT id, name, keywords FROM topics ORDER BY id"
  );
  const { rows: articles } = await pool.query<Article>(
    "SELECT id, title, summary FROM articles ORDER BY id"
  );

  if (topics.length === 0 || articles.length === 0) {
    console.log("No topics or no articles — nothing to match.");
    await pool.end();
    return;
  }

  let totalMatches = 0;
  const perTopicCounts = new Map<number, number>();

  for (const article of articles) {
    const text = `${article.title} ${article.summary ?? ""}`;

    for (const topic of topics) {
      const score = countKeywordHits(text, topic.keywords);
      if (score === 0) continue;

      await pool.query(
        `INSERT INTO topic_articles (topic_id, article_id, score, matched_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (topic_id, article_id)
         DO UPDATE SET score = EXCLUDED.score, matched_at = now()`,
        [topic.id, article.id, score]
      );

      totalMatches++;
      perTopicCounts.set(topic.id, (perTopicCounts.get(topic.id) ?? 0) + 1);
    }
  }

  console.log(`Matched ${articles.length} article(s) against ${topics.length} topic(s).`);
  for (const topic of topics) {
    console.log(`  ${topic.name}: ${perTopicCounts.get(topic.id) ?? 0} article(s) matched`);
  }
  console.log(`Total (topic, article) matches: ${totalMatches}`);

  await pool.end();
}

main().catch((err) => {
  console.error("Matching failed:", err);
  process.exit(1);
});
