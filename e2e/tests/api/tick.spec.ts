import { test, expect } from "../../support/fixtures";
import { FETCH_SECRET } from "../../support/env";
import type { Db } from "../../support/db";

// /api/tick acts on *every* due user in one call, so two of these tests
// running at once could each fetch the other's user first and make the
// other's "fetched: true" assertion flaky. Serial keeps them in order in a
// single worker; other spec files never call it.
test.describe.configure({ mode: "serial" });

const bearer = { Authorization: `Bearer ${FETCH_SECRET}` };

// HH:MM in UTC, `offsetMinutes` from now, wrapping across midnight.
function utcClock(offsetMinutes: number): string {
  const now = new Date();
  const total = (((now.getUTCHours() * 60 + now.getUTCMinutes() + offsetMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

async function setSchedule(db: Db, userId: number, opts: { time: string; enabled?: boolean }) {
  await db.query(
    "UPDATE users SET digest_time = $1, digest_timezone = 'UTC', digest_enabled = $2 WHERE id = $3",
    [opts.time, opts.enabled ?? true, userId]
  );
}

type TickResult = { userId: number; fetched: boolean; sent: boolean; error?: string };
const tick = async (api: { post: Function }): Promise<TickResult[]> =>
  (await (await api.post("/api/tick", { headers: bearer })).json()).results;

test.describe("authentication", () => {
  test("needs the machine secret — a user session is not enough", async ({ api, makeUser }) => {
    const user = await makeUser();
    expect((await api.post("/api/tick")).status()).toBe(401);
    expect((await api.post("/api/tick", { headers: { Authorization: "Bearer wrong-secret" } })).status()).toBe(401);
    expect((await user.api.post("/api/tick")).status()).toBe(401);
    expect((await api.post("/api/tick", { headers: bearer })).status()).toBe(200);
  });
});

test.describe("per-user scheduling", () => {
  test("fetches a user once their pre-send window opens, then not again that day", async ({ api, db, makeUser }) => {
    const user = await makeUser();
    // Send time 14 minutes away => the fetch target (15 min earlier) was
    // a minute ago, so the fetch window is open but the send window isn't.
    await setSchedule(db, user.id, { time: utcClock(14) });

    const first = (await tick(api)).find((r) => r.userId === user.id);
    expect(first).toEqual({ userId: user.id, fetched: true, sent: false });

    const { rows } = await db.query("SELECT last_fetch_date, last_digest_sent_date FROM users WHERE id = $1", [user.id]);
    expect(rows[0].last_fetch_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[0].last_digest_sent_date).toBeNull();

    // Idempotent: a second tick the same day does nothing for this user.
    expect((await tick(api)).find((r) => r.userId === user.id)).toBeUndefined();
  });

  test("does nothing for a user whose window isn't open yet", async ({ api, db, makeUser }) => {
    const user = await makeUser();
    await setSchedule(db, user.id, { time: utcClock(120) });

    expect((await tick(api)).find((r) => r.userId === user.id)).toBeUndefined();
    const { rows } = await db.query("SELECT last_fetch_date FROM users WHERE id = $1", [user.id]);
    expect(rows[0].last_fetch_date).toBeNull();
  });

  test("skips users who turned their digest off, even when due", async ({ api, db, makeUser }) => {
    const user = await makeUser();
    await setSchedule(db, user.id, { time: utcClock(14), enabled: false });

    expect((await tick(api)).find((r) => r.userId === user.id)).toBeUndefined();
  });

  test("when email isn't configured the fetch still completes but the send isn't marked done", async ({ api, db, makeUser }) => {
    const user = await makeUser();
    // Send time a minute ago: both the fetch and send windows are open.
    await setSchedule(db, user.id, { time: utcClock(-1) });

    const result = (await tick(api)).find((r) => r.userId === user.id);
    expect(result).toEqual({ userId: user.id, fetched: true, sent: false, error: "send failed" });

    // Not marked as sent, so the next tick inside the window retries it.
    const { rows } = await db.query("SELECT last_fetch_date, last_digest_sent_date FROM users WHERE id = $1", [user.id]);
    expect(rows[0].last_fetch_date).not.toBeNull();
    expect(rows[0].last_digest_sent_date).toBeNull();
  });

  test("judges 'due' in each user's own timezone", async ({ api, db, makeUser }) => {
    const user = await makeUser();
    // Tokyo is 9 hours ahead of UTC. Setting Tokyo's clock time to
    // "UTC now + 14 min" means it's NOT due in Tokyo's real local time.
    await db.query(
      "UPDATE users SET digest_time = $1, digest_timezone = 'Asia/Tokyo', digest_enabled = true WHERE id = $2",
      [utcClock(14), user.id]
    );
    expect((await tick(api)).find((r) => r.userId === user.id)).toBeUndefined();

    // Now express the same target in Tokyo's own clock: due.
    const tokyoNow = new Date(Date.now() + 9 * 3_600_000);
    const tokyoTarget = (((tokyoNow.getUTCHours() * 60 + tokyoNow.getUTCMinutes() + 14) % 1440) + 1440) % 1440;
    const hhmm = `${String(Math.floor(tokyoTarget / 60)).padStart(2, "0")}:${String(tokyoTarget % 60).padStart(2, "0")}`;
    await db.query("UPDATE users SET digest_time = $1 WHERE id = $2", [hhmm, user.id]);
    expect((await tick(api)).find((r) => r.userId === user.id)?.fetched).toBe(true);
  });
});
