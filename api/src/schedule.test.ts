import { describe, it, expect } from "vitest";
import { minutesSinceMidnight, withinWindow, getLocalTimeAndDate, isValidTimezone } from "./schedule.js";

describe("minutesSinceMidnight", () => {
  it("converts HH:MM to minutes since midnight", () => {
    expect(minutesSinceMidnight("00:00")).toBe(0);
    expect(minutesSinceMidnight("07:00")).toBe(420);
    expect(minutesSinceMidnight("23:59")).toBe(1439);
  });
});

describe("withinWindow", () => {
  it("is true right at the target", () => {
    expect(withinWindow(420, 420, 10)).toBe(true);
  });

  it("is true just inside the window after the target", () => {
    expect(withinWindow(429, 420, 10)).toBe(true);
  });

  it("is false once the window has passed", () => {
    expect(withinWindow(430, 420, 10)).toBe(false);
  });

  it("is false before the target (window doesn't look backward)", () => {
    expect(withinWindow(419, 420, 10)).toBe(false);
  });

  // The exact scenario called out in schedule.ts's own comment: a target of
  // 00:02 with a 5-minute pre-fetch offset computes to 23:57 the previous
  // day, and "now" at 23:59 should still be considered within that window.
  it("wraps correctly across midnight", () => {
    const target = 2; // 00:02
    const fetchTarget = ((target - 5) % 1440 + 1440) % 1440; // 23:57 previous day
    expect(fetchTarget).toBe(1437);
    expect(withinWindow(1439, fetchTarget, 10)).toBe(true); // 23:59 now
    expect(withinWindow(5, fetchTarget, 10)).toBe(true); // 00:05 now (wrapped past midnight)
    expect(withinWindow(1420, fetchTarget, 10)).toBe(false); // 23:40 now, too early
  });
});

describe("getLocalTimeAndDate", () => {
  it("returns HH:MM and YYYY-MM-DD shaped strings for a given IANA timezone", () => {
    const { time, date } = getLocalTimeAndDate("America/Los_Angeles");
    expect(time).toMatch(/^\d{2}:\d{2}$/);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("agrees with the difference between two timezones known to be offset", () => {
    // Tokyo is always ahead of Los Angeles (never the same UTC offset,
    // even across both zones' DST changes), so their minutes-since-midnight
    // should never be equal at the same real instant.
    const la = getLocalTimeAndDate("America/Los_Angeles");
    const tokyo = getLocalTimeAndDate("Asia/Tokyo");
    expect(minutesSinceMidnight(tokyo.time)).not.toBe(minutesSinceMidnight(la.time));
  });
});

describe("isValidTimezone", () => {
  it("accepts ordinary IANA names", () => {
    for (const tz of ["America/New_York", "America/Los_Angeles", "Europe/London", "Asia/Tokyo", "UTC"]) {
      expect(isValidTimezone(tz), tz).toBe(true);
    }
  });

  // Firefox and Safari report the modern names; Node's own list only has the
  // legacy spellings. Both must be accepted or those users' zones 400.
  it("accepts both the legacy and the modern spelling of a renamed zone", () => {
    const pairs = [
      ["Asia/Calcutta", "Asia/Kolkata"],
      ["Europe/Kiev", "Europe/Kyiv"],
      ["Asia/Saigon", "Asia/Ho_Chi_Minh"],
      ["Asia/Katmandu", "Asia/Kathmandu"],
    ];
    for (const names of pairs) for (const tz of names) expect(isValidTimezone(tz), tz).toBe(true);
  });

  it("rejects garbage, bare aliases, offsets, and stray whitespace", () => {
    for (const tz of ["Mars/Olympus_Mons", "", "PST", "+05:30", "-08:00", "America/New_York ", " UTC", "Asia/"]) {
      expect(isValidTimezone(tz), JSON.stringify(tz)).toBe(false);
    }
  });
});
