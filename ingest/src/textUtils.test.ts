import { describe, it, expect } from "vitest";
import { normalizeTitle, escapeRegExp, countOccurrences } from "./textUtils.js";

describe("normalizeTitle", () => {
  it("strips a trailing ' - Outlet Name' suffix", () => {
    expect(normalizeTitle("Fed holds rates steady - Reuters")).toBe("fed holds rates steady");
  });

  it("normalizes punctuation and whitespace so near-identical headlines match", () => {
    const a = normalizeTitle("Fed Holds Rates Steady, Again - Reuters");
    const b = normalizeTitle("fed holds rates steady again  -  AP News");
    expect(a).toBe(b);
  });

  it("leaves a title with no outlet suffix as-is (just cased/punctuation normalized)", () => {
    expect(normalizeTitle("No dash here at all")).toBe("no dash here at all");
  });

  it("doesn't strip a dash that isn't the outlet-suffix pattern (no surrounding spaces)", () => {
    expect(normalizeTitle("Pre-Market Movers - CNBC")).toBe("premarket movers");
  });
});

describe("escapeRegExp", () => {
  it("escapes regex special characters so they're matched literally", () => {
    const escaped = escapeRegExp("C++ (2024)");
    expect(new RegExp(escaped).test("C++ (2024)")).toBe(true);
    expect(new RegExp(escaped).test("C  (2024)")).toBe(false);
  });
});

describe("countOccurrences", () => {
  it("matches a whole-word keyword", () => {
    expect(countOccurrences("students filed for opt this year", "opt")).toBe(1);
  });

  it("does not match a keyword inside a longer unrelated word", () => {
    // "OPT" (Optional Practical Training) must not match inside "Options".
    expect(countOccurrences("stock options surged today", "opt")).toBe(0);
  });

  it("counts multiple occurrences", () => {
    expect(countOccurrences("fed fed fed", "fed")).toBe(3);
  });

  it("returns 0 for an empty needle", () => {
    expect(countOccurrences("anything at all", "")).toBe(0);
  });

  it("matches a multi-word phrase as a whole", () => {
    expect(countOccurrences("interest rate hike expected", "interest rate")).toBe(1);
    expect(countOccurrences("interest in rate changes", "interest rate")).toBe(0);
  });
});
