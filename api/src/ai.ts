// Same Gemini Flash free tier as ingest/src/summarize.ts (a separate,
// duplicated call here rather than a shared package — this is a different
// npm package from ingest/, and the project has kept them independent
// throughout, see DECISIONS.md). Suggests keywords for a newly-created
// topic so a topic isn't stuck with zero matches just because its owner
// only typed a name — match.ts's TF-IDF scoring skips any article scoring
// zero across all of a topic's keywords, so an empty keyword list means a
// topic can never match anything at all.

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent";
const TIMEOUT_MS = 10_000;
const MAX_KEYWORDS = 10;

function dedupeCaseInsensitive(keywords: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const k of keywords) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(k);
  }
  return result.slice(0, MAX_KEYWORDS);
}

// Used both as the no-key/failure fallback and as a last resort if Gemini
// returns nothing usable — a topic should never end up with zero keywords.
export function defaultKeywordsFromName(name: string): string[] {
  const STOPWORDS = new Set(["the", "a", "an", "of", "and", "or", "in", "on", "for", "to"]);
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return dedupeCaseInsensitive(words.length > 0 ? words : [name.trim()]);
}

// Returns a merged, deduplicated keyword list (Gemini's suggestions plus
// whatever the user already typed), or null if Gemini is unset/unreachable
// — callers should fall back to defaultKeywordsFromName(name) in that case.
export async function suggestKeywords(
  name: string,
  userKeywords: string[]
): Promise<string[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const existing =
    userKeywords.length > 0
      ? ` The user already suggested: ${userKeywords.join(", ")}. Keep the good ones.`
      : "";

  const prompt =
    `A news digest topic is called "${name}".${existing} ` +
    "Suggest up to 8 short keywords or phrases (single words or short phrases, not full sentences) " +
    "that would literally appear in real news headlines about this topic — include obvious " +
    "synonyms, related entities, and common abbreviations. These are matched against headlines " +
    "as literal text, not semantically, so avoid vague/abstract terms.";

  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { keywords: { type: "ARRAY", items: { type: "STRING" } } },
            required: ["keywords"],
          },
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`Gemini keyword suggestion failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) return null;

    const parsed = JSON.parse(content) as { keywords?: unknown };
    if (!Array.isArray(parsed.keywords)) return null;

    const suggested = parsed.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0);
    return dedupeCaseInsensitive([...userKeywords, ...suggested]);
  } catch (err) {
    console.error(
      `Gemini keyword suggestion failed: ${err instanceof Error ? err.message : "Unknown error"}`
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
