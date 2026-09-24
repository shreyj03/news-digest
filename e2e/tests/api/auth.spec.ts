import { randomUUID } from "node:crypto";
import { test, expect } from "../../support/fixtures";
import { seedResetToken, seedTopic, seedUnclaimedUser } from "../../support/seed";

const uniqueEmail = () => `auth-${randomUUID().slice(0, 8)}@e2e.test`;

test.describe("signup", () => {
  test("rejects a malformed email and a short password", async ({ api }) => {
    const badEmail = await api.post("/api/signup", { data: { email: "not-an-email", password: "long-enough-pw" } });
    expect(badEmail.status()).toBe(400);
    expect(await badEmail.json()).toEqual({ error: "A valid email is required." });

    const shortPassword = await api.post("/api/signup", { data: { email: uniqueEmail(), password: "short" } });
    expect(shortPassword.status()).toBe(400);
    expect(await shortPassword.json()).toEqual({ error: "Password must be at least 8 characters." });
  });

  test("creates an account, normalises the email, and never exposes the password hash", async ({ api, db }) => {
    const local = randomUUID().slice(0, 8);
    const res = await api.post("/api/signup", {
      data: { email: `  ${local.toUpperCase()}@E2E.Test  `, password: "correct-horse-battery" },
    });
    expect(res.status()).toBe(201);

    const { token, user } = await res.json();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(user.email).toBe(`${local}@e2e.test`);
    expect(user).toMatchObject({ digest_time: "07:00:00", digest_timezone: "America/Los_Angeles", digest_enabled: true });
    expect(user).not.toHaveProperty("password_hash");

    // Stored hashed, never as plaintext.
    const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [user.id]);
    expect(rows[0].password_hash).not.toContain("correct-horse-battery");
    await db.query("DELETE FROM users WHERE id = $1", [user.id]);
  });

  test("rejects a duplicate email with 409", async ({ api, makeUser }) => {
    const existing = await makeUser();
    const res = await api.post("/api/signup", { data: { email: existing.email, password: "another-password-1" } });
    expect(res.status()).toBe(409);
    expect(await res.json()).toEqual({ error: "An account with that email already exists." });
  });

  test("signing up with an unclaimed bootstrap email claims it and keeps its data", async ({ api, db }) => {
    const email = uniqueEmail();
    const userId = await seedUnclaimedUser(db, email);
    await seedTopic(db, { userId, name: "Pre-existing topic", keywords: ["legacy"] });

    // An unclaimed row has no password, so nothing can log into it yet.
    const early = await api.post("/api/login", { data: { email, password: "anything-at-all" } });
    expect(early.status()).toBe(401);

    // 200 (not 201): the row already existed, this just sets its password.
    const claim = await api.post("/api/signup", { data: { email, password: "my-real-password" } });
    expect(claim.status()).toBe(200);
    const { token, user } = await claim.json();
    expect(user.id).toBe(userId);

    const topics = await api.get("/api/topics", { headers: { Authorization: `Bearer ${token}` } });
    expect((await topics.json()).map((t: { name: string }) => t.name)).toEqual(["Pre-existing topic"]);

    // Once claimed, it's an ordinary account: a second signup is a duplicate.
    const again = await api.post("/api/signup", { data: { email, password: "someone-else-1" } });
    expect(again.status()).toBe(409);

    await db.query("DELETE FROM users WHERE id = $1", [userId]);
  });
});

test.describe("login, session, logout", () => {
  test("logs in regardless of email casing and returns a working token", async ({ api, makeUser }) => {
    const user = await makeUser();
    const res = await api.post("/api/login", { data: { email: user.email.toUpperCase(), password: user.password } });
    expect(res.status()).toBe(200);
    const { token } = await res.json();

    const me = await api.get("/api/me", { headers: { Authorization: `Bearer ${token}` } });
    expect(me.status()).toBe(200);
    expect((await me.json()).email).toBe(user.email);
  });

  test("wrong password and unknown email are indistinguishable", async ({ api, makeUser }) => {
    const user = await makeUser();
    const wrongPassword = await api.post("/api/login", { data: { email: user.email, password: "wrong-password-1" } });
    const unknownEmail = await api.post("/api/login", { data: { email: uniqueEmail(), password: "wrong-password-1" } });

    expect(wrongPassword.status()).toBe(401);
    expect(unknownEmail.status()).toBe(401);
    // Same status and same body, so the response can't be used to probe
    // which emails have accounts.
    expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
    expect(await unknownEmail.json()).toEqual({ error: "Incorrect email or password." });
  });

  test("GET /api/me requires a valid session", async ({ api, makeUser }) => {
    const user = await makeUser();
    expect((await api.get("/api/me")).status()).toBe(401);
    expect((await api.get("/api/me", { headers: { Authorization: "Bearer not-a-real-token" } })).status()).toBe(401);
    expect((await api.get("/api/me", { headers: { Authorization: "Basic abc" } })).status()).toBe(401);

    const ok = await user.api.get("/api/me");
    expect(ok.status()).toBe(200);
    const body = await ok.json();
    expect(body.email).toBe(user.email);
    expect(body).not.toHaveProperty("password_hash");
  });

  test("logout revokes the session server-side", async ({ makeUser }) => {
    const user = await makeUser();
    expect((await user.api.get("/api/me")).status()).toBe(200);

    expect((await user.api.post("/api/logout")).status()).toBe(204);
    // The token is dead, not just forgotten by the client.
    expect((await user.api.get("/api/me")).status()).toBe(401);
  });

  test("logging out one session leaves the account's other sessions alone", async ({ api, makeUser }) => {
    const user = await makeUser();
    const second = await api.post("/api/login", { data: { email: user.email, password: user.password } });
    const { token: secondToken } = await second.json();

    await user.api.post("/api/logout");
    const still = await api.get("/api/me", { headers: { Authorization: `Bearer ${secondToken}` } });
    expect(still.status()).toBe(200);
  });
});

test.describe("brute-force protection", () => {
  test("locks an IP out after 5 failed logins — even for the right password", async ({ makeUser, newApiContext, clientIp }) => {
    const user = await makeUser();
    const attacker = await newApiContext({ ip: `${clientIp}-attacker` });

    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await attacker.post("/api/login", { data: { email: user.email, password: `guess-number-${attempt}` } });
      expect(res.status(), `attempt ${attempt}`).toBe(401);
    }

    const locked = await attacker.post("/api/login", { data: { email: user.email, password: user.password } });
    expect(locked.status()).toBe(429);
    expect((await locked.json()).error).toMatch(/too many attempts/i);

    // The limiter is keyed by client IP, so the real owner elsewhere is fine.
    const owner = await newApiContext({ ip: `${clientIp}-owner` });
    const fine = await owner.post("/api/login", { data: { email: user.email, password: user.password } });
    expect(fine.status()).toBe(200);
  });

  test("a successful login resets the failure counter", async ({ makeUser, newApiContext, clientIp }) => {
    const user = await makeUser();
    const client = await newApiContext({ ip: `${clientIp}-reset` });
    const fail = () => client.post("/api/login", { data: { email: user.email, password: "wrong-password-1" } });
    const succeed = () => client.post("/api/login", { data: { email: user.email, password: user.password } });

    for (let i = 0; i < 4; i++) expect((await fail()).status()).toBe(401);
    expect((await succeed()).status()).toBe(200);
    // 4 more failures would have crossed the threshold had the first 4 stuck.
    for (let i = 0; i < 4; i++) expect((await fail()).status()).toBe(401);
    expect((await succeed()).status()).toBe(200);
  });
});

test.describe("password reset", () => {
  test("forgot-password answers identically whether or not the email has an account", async ({ api, makeUser }) => {
    const real = await makeUser();
    const known = await api.post("/api/forgot-password", { data: { email: real.email } });
    const unknown = await api.post("/api/forgot-password", { data: { email: uniqueEmail() } });

    expect(known.status()).toBe(200);
    expect(unknown.status()).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
  });

  test("forgot-password only issues a token for a claimed account", async ({ api, db, makeUser }) => {
    const real = await makeUser();
    const unclaimedEmail = uniqueEmail();
    const unclaimedId = await seedUnclaimedUser(db, unclaimedEmail);

    await api.post("/api/forgot-password", { data: { email: real.email } });
    await api.post("/api/forgot-password", { data: { email: unclaimedEmail } });

    const claimed = await db.query("SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1", [real.id]);
    const unclaimed = await db.query("SELECT count(*)::int AS n FROM password_reset_tokens WHERE user_id = $1", [unclaimedId]);
    expect(claimed.rows[0].n).toBe(1);
    expect(unclaimed.rows[0].n).toBe(0);
    await db.query("DELETE FROM users WHERE id = $1", [unclaimedId]);
  });

  test("a valid token sets the new password, logs in, and invalidates old sessions", async ({ api, db, makeUser }) => {
    const user = await makeUser();
    const token = await seedResetToken(db, user.id);

    const res = await api.post("/api/reset-password", { data: { token, password: "brand-new-password" } });
    expect(res.status()).toBe(200);
    const { token: freshSession } = await res.json();

    // Logged straight in on a fresh session…
    const me = await api.get("/api/me", { headers: { Authorization: `Bearer ${freshSession}` } });
    expect(me.status()).toBe(200);
    // …the old session is gone (whoever had it is locked out)…
    expect((await user.api.get("/api/me")).status()).toBe(401);
    // …and only the new password works.
    const old = await api.post("/api/login", { data: { email: user.email, password: user.password } });
    expect(old.status()).toBe(401);
    const fresh = await api.post("/api/login", { data: { email: user.email, password: "brand-new-password" } });
    expect(fresh.status()).toBe(200);
  });

  test("a reset token is single-use", async ({ api, db, makeUser }) => {
    const user = await makeUser();
    const token = await seedResetToken(db, user.id);

    expect((await api.post("/api/reset-password", { data: { token, password: "first-new-password" } })).status()).toBe(200);
    const replay = await api.post("/api/reset-password", { data: { token, password: "second-new-password" } });
    expect(replay.status()).toBe(400);
    expect(await replay.json()).toEqual({ error: "That reset link is invalid or has expired." });
  });

  test("rejects unknown, expired, and too-short-password requests", async ({ api, db, makeUser }) => {
    const user = await makeUser();
    const expired = await seedResetToken(db, user.id, { expiresInMinutes: -5 });
    const valid = await seedResetToken(db, user.id);

    const unknown = await api.post("/api/reset-password", { data: { token: "does-not-exist", password: "long-enough-pw" } });
    expect(unknown.status()).toBe(400);

    const expiredRes = await api.post("/api/reset-password", { data: { token: expired, password: "long-enough-pw" } });
    expect(expiredRes.status()).toBe(400);

    // A too-short password is refused *before* the token is spent.
    const tooShort = await api.post("/api/reset-password", { data: { token: valid, password: "short" } });
    expect(tooShort.status()).toBe(400);
    expect(await tooShort.json()).toEqual({ error: "Password must be at least 8 characters." });
    const stillGood = await api.post("/api/reset-password", { data: { token: valid, password: "long-enough-pw" } });
    expect(stillGood.status()).toBe(200);
  });
});
