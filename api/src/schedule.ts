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
// cadence (every 5 minutes; see .github/workflows/tick.yml), padded a
// little for GitHub's own scheduler jitter.
export const TICK_PRE_FETCH_MINUTES = 5;
export const TICK_WINDOW_MINUTES = 10;
