// Pure text-matching helpers shared by ingest.ts and match.ts. Kept in
// their own module (no `pool` import, no top-level `main()`) so they can be
// unit-tested directly without touching the database or triggering a real
// ingest/match run.

// RSS titles from these feeds are conventionally "Headline - Outlet Name" —
// strip the outlet suffix so the same story from two different outlets
// normalizes to the same fingerprint instead of being treated as two
// unrelated articles. Punctuation-insensitive on purpose: headlines for the
// same story often differ in a stray comma or quote mark between outlets.
export function normalizeTitle(title: string): string {
  const lastDash = title.lastIndexOf(" - ");
  const withoutSource = lastDash > 0 ? title.slice(0, lastDash) : title;
  return withoutSource
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Count whole-word/whole-phrase occurrences of `needle` in `haystack` (both
 * already lowercased). Word-boundary-anchored rather than a plain substring
 * search — a short keyword like "OPT" (immigration: Optional Practical
 * Training) must not match inside unrelated words like "Options".
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  const pattern = new RegExp(`\\b${escapeRegExp(needle)}\\b`, "g");
  return haystack.match(pattern)?.length ?? 0;
}
