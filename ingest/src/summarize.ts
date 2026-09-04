// Gemini Flash's free tier (Google AI Studio) — two best-effort, display-
// only features built on the same small hosted model: (1) a one-sentence
// summary per newly-inserted article, and (2) a per-topic daily recap plus
// which article (if any) stands out as that topic's top story. Neither
// touches match.ts's TF-IDF scoring — both fail open (missing key, timeout,
// bad response all just skip and log) and never block or fail a run.
//
// Gemini Flash (not Groq): Groq deprecated its free tier; Gemini Flash's
// free tier via Google AI Studio is the current option that costs nothing.

// The "-latest" alias tracks whatever Google currently calls its small/fast
// tier, so a future model rename (like the gemini-2.0-flash -> current one
// this had to work around) doesn't silently 404 this again.
//
// gemini-flash-latest (not gemini-flash-lite-latest): switched 2026-09-04
// after live testing showed flash-lite-latest failing most requests with
// 503 "high demand" while flash-latest succeeded far more often on the
// same key at the same moment — see DECISIONS.md.
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

// Google's shared free-tier Flash-Lite model returns 503 "currently
// experiencing high demand" often enough in practice (observed ~2 of 3
// requests in a row) that a single attempt was silently losing most
// batches — this is what actually broke both summaries and recaps for
// days straight, not an invalid key or a code bug (see DECISIONS.md).
// One retry after a short pause clears the large majority of these, since
// the overload is at the request level, not sustained per-caller.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_500;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(
  prompt: string,
  responseSchema: object,
  apiKey: string,
  timeoutMs: number
): Promise<unknown | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(GEMINI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema,
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        console.error(`  Gemini request failed: ${res.status} ${res.statusText}`);
        if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return null;
      }

      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) return null;

      return JSON.parse(content);
    } catch (err) {
      console.error(`  Gemini request failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}

interface ArticleInput {
  id: number;
  title: string;
  snippet: string | null;
}

const SUMMARY_BATCH_SIZE = 25;
const SUMMARY_TIMEOUT_MS = 15_000;

async function summarizeArticleBatch(
  batch: ArticleInput[],
  apiKey: string
): Promise<Map<number, string>> {
  const result = new Map<number, string>();

  const numbered = batch
    .map((a, i) => `${i}. ${a.title}${a.snippet ? ` — ${a.snippet}` : ""}`)
    .join("\n");

  const prompt =
    "You summarize news headlines for a personal news digest. " +
    "For each numbered item below, write one short, neutral sentence (under 20 words) " +
    "summarizing only what's stated — never add facts not present in the input. " +
    "Return exactly one summary per item, in the same order.\n\n" +
    numbered;

  const parsed = (await callGemini(
    prompt,
    {
      type: "OBJECT",
      properties: { summaries: { type: "ARRAY", items: { type: "STRING" } } },
      required: ["summaries"],
    },
    apiKey,
    SUMMARY_TIMEOUT_MS
  )) as { summaries?: unknown } | null;

  if (!parsed || !Array.isArray(parsed.summaries) || parsed.summaries.length !== batch.length) {
    if (parsed) console.error("  Gemini summarization returned an unexpected shape, skipping this batch.");
    return result;
  }

  parsed.summaries.forEach((summary, i) => {
    if (typeof summary === "string" && summary.trim()) {
      result.set(batch[i].id, summary.trim());
    }
  });

  return result;
}

export async function summarizeArticles(articles: ArticleInput[]): Promise<Map<number, string>> {
  const apiKey = process.env.GEMINI_API_KEY;
  const combined = new Map<number, string>();
  if (!apiKey || articles.length === 0) return combined;

  for (let i = 0; i < articles.length; i += SUMMARY_BATCH_SIZE) {
    const batch = articles.slice(i, i + SUMMARY_BATCH_SIZE);
    const batchResult = await summarizeArticleBatch(batch, apiKey);
    for (const [id, summary] of batchResult) combined.set(id, summary);
  }

  return combined;
}

interface TopicForRecap {
  id: number;
  name: string;
  articles: ArticleInput[];
}

interface TopicRecap {
  recap: string;
  topArticleId: number | null;
}

const RECAP_BATCH_SIZE = 10;
// Longer than SUMMARY_TIMEOUT_MS on purpose — picking a "top story" per
// topic is a heavier reasoning task than a flat one-sentence-per-item
// summary, and it measurably needed more than 15s in practice.
const RECAP_TIMEOUT_MS = 25_000;

async function recapTopicBatch(
  batch: TopicForRecap[],
  apiKey: string
): Promise<Map<number, TopicRecap>> {
  const result = new Map<number, TopicRecap>();

  const sections = batch
    .map((topic, i) => {
      const items = topic.articles
        .map((a, j) => `  ${j}. ${a.title}${a.snippet ? ` — ${a.snippet}` : ""}`)
        .join("\n");
      return `Topic ${i} — "${topic.name}":\n${items}`;
    })
    .join("\n\n");

  const prompt =
    "You write short daily recaps for a personal news digest, one per topic. " +
    "For each topic below, using only its own listed headlines: " +
    "(1) write a neutral 2-3 sentence recap of what's happening today, and " +
    "(2) pick the single numbered article that's the most significant/major story for that topic, " +
    "or -1 if none clearly stands out. Never add facts not present in the input. " +
    "Return exactly one entry per topic, in the same order as given.\n\n" +
    sections;

  const parsed = (await callGemini(
    prompt,
    {
      type: "OBJECT",
      properties: {
        topics: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              recap: { type: "STRING" },
              topArticleIndex: { type: "INTEGER" },
            },
            required: ["recap", "topArticleIndex"],
          },
        },
      },
      required: ["topics"],
    },
    apiKey,
    RECAP_TIMEOUT_MS
  )) as { topics?: unknown } | null;

  if (!parsed || !Array.isArray(parsed.topics) || parsed.topics.length !== batch.length) {
    if (parsed) console.error("  Gemini recap returned an unexpected shape, skipping this batch.");
    return result;
  }

  parsed.topics.forEach((entry, i) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { recap?: unknown }).recap !== "string" ||
      typeof (entry as { topArticleIndex?: unknown }).topArticleIndex !== "number"
    ) {
      return;
    }
    const recap = (entry as { recap: string }).recap.trim();
    if (!recap) return;
    const topicArticles = batch[i].articles;
    const idx = (entry as { topArticleIndex: number }).topArticleIndex;
    const topArticleId = idx >= 0 && idx < topicArticles.length ? topicArticles[idx].id : null;
    result.set(batch[i].id, { recap, topArticleId });
  });

  return result;
}

export async function summarizeTopicRecaps(
  topics: TopicForRecap[]
): Promise<Map<number, TopicRecap>> {
  const apiKey = process.env.GEMINI_API_KEY;
  const combined = new Map<number, TopicRecap>();
  if (!apiKey || topics.length === 0) return combined;

  for (let i = 0; i < topics.length; i += RECAP_BATCH_SIZE) {
    const batch = topics.slice(i, i + RECAP_BATCH_SIZE);
    const batchResult = await recapTopicBatch(batch, apiKey);
    for (const [id, recap] of batchResult) combined.set(id, recap);
  }

  return combined;
}
