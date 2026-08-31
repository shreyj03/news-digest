import { describe, it, expect } from "vitest";
import { defaultKeywordsFromName } from "./ai.js";

// Only the pure, network-free fallback is tested here — suggestKeywords
// itself calls the real Gemini API and was verified manually against it
// before shipping (see DECISIONS.md's 2026-08-31 entries).
describe("defaultKeywordsFromName", () => {
  it("splits a multi-word name into lowercase keywords", () => {
    expect(defaultKeywordsFromName("US Immigration Law")).toEqual(["us", "immigration", "law"]);
  });

  it("drops common stopwords", () => {
    expect(defaultKeywordsFromName("The Future of AI")).toEqual(["future", "ai"]);
  });

  it("never returns an empty list, even for a name that's all stopwords", () => {
    const result = defaultKeywordsFromName("The Of And");
    expect(result.length).toBeGreaterThan(0);
  });

  it("keeps a single-word name as one keyword", () => {
    expect(defaultKeywordsFromName("OKLO")).toEqual(["oklo"]);
  });
});
