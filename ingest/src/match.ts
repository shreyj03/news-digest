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

/** Count all occurrences of `needle` in `haystack` (both already lowercased). */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) break;
    count++;
    from = found + needle.length;
  }
  return count;
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

  const corpusSize = articles.length;

  // Precompute each article's lowercased text and word count once.
  const articleText = new Map<number, string>();
  const articleWordCount = new Map<number, number>();
  for (const article of articles) {
    const text = `${article.title} ${article.summary ?? ""}`.toLowerCase();
    articleText.set(article.id, text);
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    articleWordCount.set(article.id, Math.max(wordCount, 1));
  }

  // Every distinct keyword across all topics, so df/idf is computed once per keyword
  // even if two topics happen to share one.
  const allKeywords = new Set<string>();
  for (const topic of topics) {
    for (const keyword of topic.keywords) allKeywords.add(keyword.toLowerCase());
  }

  // For each keyword: corpus-wide IDF, and per-article normalized TF.
  const idfByKeyword = new Map<string, number>();
  const tfByKeyword = new Map<string, Map<number, number>>();

  for (const keyword of allKeywords) {
    let documentFrequency = 0;
    const tfForArticles = new Map<number, number>();

    for (const article of articles) {
      const text = articleText.get(article.id)!;
      const rawCount = countOccurrences(text, keyword);
      if (rawCount > 0) {
        documentFrequency++;
        // Term frequency, normalized by document length so short titles don't
        // automatically outscore longer title+summary pairs.
        tfForArticles.set(article.id, rawCount / articleWordCount.get(article.id)!);
      }
    }

    // Smoothed IDF (as in scikit-learn's default): always positive, and never
    // zero even for a keyword that appears in every single article.
    const idf = Math.log((corpusSize + 1) / (documentFrequency + 1)) + 1;
    idfByKeyword.set(keyword, idf);
    tfByKeyword.set(keyword, tfForArticles);
  }

  let totalMatches = 0;
  const perTopicCounts = new Map<number, number>();

  for (const topic of topics) {
    for (const article of articles) {
      let score = 0;
      for (const rawKeyword of topic.keywords) {
        const keyword = rawKeyword.toLowerCase();
        const tf = tfByKeyword.get(keyword)?.get(article.id) ?? 0;
        if (tf === 0) continue;
        score += tf * idfByKeyword.get(keyword)!;
      }

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

  console.log(
    `Matched ${articles.length} article(s) against ${topics.length} topic(s) using TF-IDF scoring.`
  );
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
