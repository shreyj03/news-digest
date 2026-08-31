// Batches newly-inserted articles to Gemini Flash's free tier (Google AI
// Studio) to turn each raw RSS title+snippet into one clean sentence for
// display — the raw RSS `summary` column is often an awkward fragment (or
// just repeats the title), and it stays untouched since match.ts's TF-IDF
// scoring depends on it as-is; this is a separate, display-only
// `ai_summary` column. Fails open: any error here (missing key, network,
// bad response) just leaves `ai_summary` null and logs, never fails the
// ingest run itself.
//
// Gemini Flash (not Groq): Groq deprecated its free tier; Gemini Flash's
// free tier via Google AI Studio is the current option that costs nothing.

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
const BATCH_SIZE = 25;
const TIMEOUT_MS = 15_000;

interface ArticleInput {
  id: number;
  title: string;
  snippet: string | null;
}

async function summarizeBatch(
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
          responseSchema: {
            type: "OBJECT",
            properties: {
              summaries: { type: "ARRAY", items: { type: "STRING" } },
            },
            required: ["summaries"],
          },
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`  Gemini summarization request failed: ${res.status} ${res.statusText}`);
      return result;
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) return result;

    const parsed = JSON.parse(content) as { summaries?: unknown };
    if (!Array.isArray(parsed.summaries) || parsed.summaries.length !== batch.length) {
      console.error("  Gemini summarization returned an unexpected shape, skipping this batch.");
      return result;
    }

    parsed.summaries.forEach((summary, i) => {
      if (typeof summary === "string" && summary.trim()) {
        result.set(batch[i].id, summary.trim());
      }
    });
  } catch (err) {
    console.error(
      `  Gemini summarization failed: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  } finally {
    clearTimeout(timeout);
  }

  return result;
}

export async function summarizeArticles(articles: ArticleInput[]): Promise<Map<number, string>> {
  const apiKey = process.env.GEMINI_API_KEY;
  const combined = new Map<number, string>();
  if (!apiKey || articles.length === 0) return combined;

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    const batchResult = await summarizeBatch(batch, apiKey);
    for (const [id, summary] of batchResult) combined.set(id, summary);
  }

  return combined;
}
