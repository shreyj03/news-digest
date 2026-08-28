import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";

export interface User {
  id: number;
  email: string;
  digest_time: string;
  digest_timezone: string;
  digest_enabled: boolean;
  last_fetch_date: string | null;
  last_digest_sent_date: string | null;
  created_at: string;
}

// Node's built-in scrypt is a sound password KDF — no new dependency
// (bcrypt/argon2 packages) needed for this. Stored as "salt:hash", both hex.
const SCRYPT_KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(userId: number): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)", [
    token,
    userId,
    expiresAt,
  ]);
  return token;
}

export async function deleteSession(token: string): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
}

const USER_COLUMNS =
  "id, email, digest_time, digest_timezone, digest_enabled, last_fetch_date, last_digest_sent_date, created_at";
const USER_COLUMNS_PREFIXED = "u.id, u.email, u.digest_time, u.digest_timezone, u.digest_enabled, u.last_fetch_date, u.last_digest_sent_date, u.created_at";

export async function getUserBySessionToken(token: string): Promise<User | null> {
  const { rows } = await pool.query<User>(
    `SELECT ${USER_COLUMNS_PREFIXED}
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  return rows[0] ?? null;
}

export async function getUserByEmail(email: string): Promise<(User & { password_hash: string | null }) | null> {
  const { rows } = await pool.query(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = $1`, [
    email,
  ]);
  return rows[0] ?? null;
}

export async function getUserById(id: number): Promise<User | null> {
  const { rows } = await pool.query<User>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// Resolves DEMO_USER_EMAIL to a user id once and caches it — the demo
// account essentially never changes at runtime, and this is looked up on
// every unauthenticated GET. Re-resolves on a miss (env var set but no
// matching row yet — e.g. before the owner has signed up) rather than
// caching a permanent null.
let cachedDemoUserId: number | null = null;

export async function resolveDemoUserId(): Promise<number | null> {
  if (cachedDemoUserId !== null) return cachedDemoUserId;
  const email = process.env.DEMO_USER_EMAIL;
  if (!email) return null;
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  cachedDemoUserId = rows[0]?.id ?? null;
  return cachedDemoUserId;
}
