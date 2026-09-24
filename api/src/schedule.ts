// Pure per-user tick-window logic — no `pool`/`express` import, so this can
// be unit-tested directly without booting the API or touching the database.

// Converts an IANA timezone name into that zone's current local HH:MM and
// YYYY-MM-DD — Intl.DateTimeFormat handles DST correctly on its own, no
// manual offset math. en-CA's date order is conveniently YYYY-MM-DD.
export function getLocalTimeAndDate(timezone: string): { time: string; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const LISTED_TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

// Node's ICU lists the legacy spellings ("Asia/Calcutta", "Europe/Kiev",
// "Asia/Saigon") and omits the modern IANA names — but Firefox and Safari
// report the modern ones ("Asia/Kolkata", "Europe/Kyiv", "Asia/Ho_Chi_Minh"),
// as verified by the Playwright suite across all three engines. A plain
// membership check against the list therefore rejected legitimate zones
// with a 400 for those users. Anything Intl can itself resolve is a real
// zone, so also accept any "Area/Location" name it accepts, plus "UTC"
// (what a browser on a UTC device reports, and also absent from the list);
// other bare aliases ("PST") and fixed offsets ("+05:30") stay rejected.
export function isValidTimezone(tz: string): boolean {
  if (LISTED_TIMEZONES.has(tz) || tz === "UTC") return true;
  if (!tz.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function minutesSinceMidnight(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// True if `now` has reached `target` within the last `window` minutes,
// wrapping correctly across midnight (mod 1440) — e.g. a target of 00:02
// with a 5-minute pre-fetch offset lands at 23:57 the previous day.
export function withinWindow(nowMinutes: number, targetMinutes: number, windowMinutes: number): boolean {
  const diff = (((nowMinutes - targetMinutes) % 1440) + 1440) % 1440;
  return diff < windowMinutes;
}

// How far apart the pre-send fetch and the send itself are, and how wide a
// tolerance band each gets around its target — both tied to the tick
// cadence (every 15 minutes, configured on cron-job.org's side, not in
// this repo — see DECISIONS.md's 2026-08-28 "Tick scheduling" entry for
// why cron-job.org and not GitHub Actions), padded for polling jitter.
// Scaled up 3x together from the original 5/10 (interval was 5 min) when
// the interval itself was widened to 15 min on 2026-09-17: Neon's Free
// plan only auto-suspends its compute after 5 idle minutes, and a query
// landing every 5 minutes never let it go idle at all, burning the whole
// month's compute allowance in 17 days. Keeping the same 1:1 pre-fetch and
// 2:1 window ratios to the interval preserves the original design's
// safety margin rather than picking new numbers from scratch.
export const TICK_PRE_FETCH_MINUTES = 15;
export const TICK_WINDOW_MINUTES = 30;
