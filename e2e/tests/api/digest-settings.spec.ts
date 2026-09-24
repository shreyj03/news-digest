import { test, expect } from "../../support/fixtures";

const valid = { digestTime: "08:30", digestTimezone: "Asia/Kolkata", digestEnabled: true };

test.describe("PUT /api/me/digest", () => {
  test("requires a session", async ({ api }) => {
    expect((await api.put("/api/me/digest", { data: valid })).status()).toBe(401);
  });

  test("saves time, timezone and the enabled flag, and /api/me reflects them", async ({ makeUser }) => {
    const user = await makeUser();
    const res = await user.api.put("/api/me/digest", {
      data: { digestTime: "21:05", digestTimezone: "America/New_York", digestEnabled: false },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({
      digest_time: "21:05:00",
      digest_timezone: "America/New_York",
      digest_enabled: false,
    });

    const me = await (await user.api.get("/api/me")).json();
    expect(me).toMatchObject({ digest_time: "21:05:00", digest_timezone: "America/New_York", digest_enabled: false });
  });

  test("accepts the day's boundaries", async ({ makeUser }) => {
    const user = await makeUser();
    for (const digestTime of ["00:00", "23:59"]) {
      const res = await user.api.put("/api/me/digest", { data: { ...valid, digestTime } });
      expect(res.status(), digestTime).toBe(200);
    }
  });

  // Regression: the API used to validate against Node's own zone list, which
  // has only legacy spellings, so the modern names Firefox and Safari report
  // ("Asia/Kolkata", "Europe/Kyiv") — and "UTC" — were rejected with a 400.
  for (const digestTimezone of ["Asia/Kolkata", "Asia/Calcutta", "Europe/Kyiv", "Europe/Kiev", "Asia/Ho_Chi_Minh", "UTC"]) {
    test(`accepts timezone ${digestTimezone} whichever spelling a browser reports`, async ({ makeUser }) => {
      const user = await makeUser();
      const res = await user.api.put("/api/me/digest", { data: { ...valid, digestTimezone } });
      expect(res.status()).toBe(200);
      expect((await res.json()).digest_timezone).toBe(digestTimezone);
    });
  }

  for (const digestTime of ["7:00", "24:00", "07:60", "0700", "", "noon", "07:00:00"]) {
    test(`rejects time ${JSON.stringify(digestTime)} with 400`, async ({ makeUser }) => {
      const user = await makeUser();
      const res = await user.api.put("/api/me/digest", { data: { ...valid, digestTime } });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toMatch(/HH:MM/);
    });
  }

  for (const digestTimezone of ["Mars/Olympus_Mons", "", "PST", "+05:30", "America/New_York "]) {
    test(`rejects timezone ${JSON.stringify(digestTimezone)} with 400`, async ({ makeUser }) => {
      const user = await makeUser();
      const res = await user.api.put("/api/me/digest", { data: { ...valid, digestTimezone } });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toMatch(/IANA timezone/);
    });
  }

  test("a rejected update leaves the saved settings untouched", async ({ makeUser }) => {
    const user = await makeUser();
    await user.api.put("/api/me/digest", { data: valid });
    await user.api.put("/api/me/digest", { data: { ...valid, digestTime: "99:99" } });
    expect(await (await user.api.get("/api/me")).json()).toMatchObject({ digest_time: "08:30:00" });
  });

  test("each user's settings are their own", async ({ makeUser }) => {
    const alice = await makeUser();
    const bob = await makeUser();
    await alice.api.put("/api/me/digest", { data: valid });
    expect(await (await bob.api.get("/api/me")).json()).toMatchObject({
      digest_time: "07:00:00",
      digest_timezone: "America/Los_Angeles",
    });
  });
});
