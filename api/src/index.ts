import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { pool } from "./db.js";
import {
  hashPassword,
  verifyPassword,
  createSession,
  deleteSession,
  getUserBySessionToken,
  getUserByEmail,
  getUserById,
  resolveDemoUserId,
  createPasswordResetToken,
  getUserIdByPasswordResetToken,
  deletePasswordResetToken,
  deleteAllSessionsForUser,
  type User,
} from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

const execAsync = promisify(exec);
// api/src -> api -> project root -> ingest. Resolved from this file's own
// location rather than process.cwd() so it doesn't matter where `npm run
// dev`/`tsx` was actually launched from.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INGEST_DIR = path.join(PROJECT_ROOT, "ingest");

const app = express();
const port = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json());

// Express 4 doesn't catch rejected promises from async handlers on its own —
// an unhandled DB error in a POST/PUT/DELETE would otherwise just hang the
// client with no response. This wrapper forwards any rejection to next(),
// which the error-handling middleware at the bottom turns into a 500.
function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function parseKeywords(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((k): k is string => typeof k === "string")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

// Constant-time string compare — a plain `===` on a secret leaks timing
// information proportional to how many leading characters match.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Reads the real client IP from Cloudflare's cf-connecting-ip header, which
// sits in front of this in production and sets it authoritatively — a
// client can't spoof it (confirmed live: Cloudflare's edge itself rejects
// with an error any request that tries to set this header directly).
// x-forwarded-for was tried first and is NOT safe for this: also confirmed
// live, a self-supplied X-Forwarded-For value gets prepended onto the real
// chain rather than replaced, so trusting its leftmost entry would have let
// anyone bypass the rate limiter below just by rotating a fake value per
// request. Falls back to the raw socket address for local dev, where
// there's no Cloudflare (or any proxy) in front at all.
function clientIp(req: Request): string {
  return req.header("cf-connecting-ip") ?? req.socket.remoteAddress ?? "unknown";
}

// In-memory brute-force guard, keyed by client IP — shared between
// /api/signup and /api/login, since both are password-guessing surfaces
// (signup for the claim-the-bootstrap-account case). IP-keyed rather than
// per-account: caps how many password guesses one IP gets across every
// account it tries, not just one. Not persisted: a restart just resets
// everyone's attempt budget, which is fine for a single-instance personal
// app; a multi-instance deployment would need this shared (Redis, the DB)
// instead.
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_LOCKOUT_MS = 60_000;
const authAttempts = new Map<string, { count: number; lockedUntil: number }>();

function authRateLimited(ip: string): boolean {
  const entry = authAttempts.get(ip);
  return entry !== undefined && entry.lockedUntil > Date.now();
}

function recordAuthFailure(ip: string): void {
  const entry = authAttempts.get(ip) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= AUTH_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + AUTH_LOCKOUT_MS;
    entry.count = 0; // next lockout requires a full fresh run of attempts
  }
  authAttempts.set(ip, entry);
}

function recordAuthSuccess(ip: string): void {
  authAttempts.delete(ip);
}

// Gates every mutating topic/ticker route, and the manual "Fetch news"
// button — replaces the old shared SITE_PASSWORD entirely with real
// per-user sessions. Reads Authorization: Bearer <session token>, sets
// req.userId on success.
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!token) {
    res.status(401).json({ error: "Login required." });
    return;
  }
  getUserBySessionToken(token)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: "Login required." });
        return;
      }
      req.userId = user.id;
      next();
    })
    .catch(next);
}

// Read-only routes (topics/feed/tickers) never require login — a valid
// session scopes them to that user's own data; no session falls back to the
// configured demo account (read-only, since the mutating routes above still
// require requireAuth) so anonymous visitors see a real, live example
// instead of an empty page. Returns null if neither applies (no session and
// no demo user configured), which callers treat as "show nothing."
async function resolveViewerUserId(req: Request): Promise<number | null> {
  const authHeader = req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (token) {
    const user = await getUserBySessionToken(token);
    if (user) return user.id;
  }
  return resolveDemoUserId();
}

// A topic's auto-generated feed is just a Google News search for the
// topic's own name — the same pattern used for the original "ETFs" feed.
function topicFeedUrl(topicName: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(topicName)}&hl=en-US&gl=US&ceid=US:en`;
}

// Both ingest/match scripts print a one-line summary as their last
// console.log — pull just that out instead of relaying npm's banner lines
// and Node's ExperimentalWarning noise to callers.
function lastMeaningfulLine(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith(">") &&
        !line.includes("ExperimentalWarning") &&
        !line.includes("Support for loading") &&
        !line.includes("trace-warnings")
    );
  return lines.at(-1) ?? "";
}

// Shells out to the same `npm run ingest`/`npm run match` commands a person
// would type by hand, rather than importing that logic into the API process
// — keeps the ingestion pipeline a genuinely separate piece (see
// DECISIONS.md). Always scoped to one user (TARGET_USER_ID) — there's no
// global mode; every fetch is either the "Fetch news" button (that user) or
// the scheduled per-user tick (whichever user is due).
async function runIngestAndMatchForUser(userId: number): Promise<{ ingest: string; match: string }> {
  const env = { ...process.env, TARGET_USER_ID: String(userId) };
  const ingestResult = await execAsync("npm run ingest", { cwd: INGEST_DIR, timeout: 60_000, env });
  const matchResult = await execAsync("npm run match", { cwd: INGEST_DIR, timeout: 60_000, env });
  return {
    ingest: lastMeaningfulLine(ingestResult.stdout),
    match: lastMeaningfulLine(matchResult.stdout),
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Shared low-level sender for both digest and welcome emails. Brevo, not
// Resend (see DECISIONS.md): Resend's free tier is sandboxed to only send
// to the Resend account's own email until a domain is verified, which broke
// as soon as this app went multi-user — confirmed live, even a Gmail
// plus-address pointing at the same inbox was rejected. Brevo's free tier
// lets a single *verified sender email* (no owned domain needed — just
// confirm a code sent to that address) send to any recipient, which is
// what multi-user actually needs. `DIGEST_EMAIL_FROM` must be exactly that
// verified sender address; there's no safe generic fallback the way
// Resend's shared onboarding@resend.dev was, so both are required together.
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.DIGEST_EMAIL_FROM;
  if (!apiKey || !fromEmail) return false;

  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: "News Digest", email: fromEmail },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      console.error(`Email to ${to} failed:`, res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Email to ${to} failed:`, err);
    return false;
  }
}

// Best-effort — a no-op (returns false) when BREVO_API_KEY isn't set (so
// local dev and anyone who hasn't opted into email are unaffected), and
// never throws: a failed email shouldn't take down the scheduled tick for
// every other due user. Returns whether it actually sent, so /api/tick only
// marks a user's last_digest_sent_date on a real success — a transient
// failure should leave them eligible to retry on the next tick, not get
// silently marked as "sent today" regardless. Only called from /api/tick
// for a user whose own chosen delivery time is due — never from the manual
// "Fetch news" button, so clicking that never spams anyone's inbox. Sends
// to the user's own account email; there's no separate "recipient"
// concept — each account gets its own digest.
async function sendDigestEmailForUser(user: User): Promise<boolean> {
  if (!process.env.BREVO_API_KEY || !process.env.DIGEST_EMAIL_FROM) return false;

  try {
    const feed = await buildFeed(null, user.id);
    const dateLabel = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: user.digest_timezone,
    });

    const siteUrl = process.env.SITE_URL ?? "https://news-digest-web.onrender.com";
    const iconUrl = `${siteUrl}/email-icon.png`;
    const SERIF = "Georgia,'Times New Roman',serif";
    const MONO = "'Courier New',ui-monospace,Menlo,Consolas,monospace";

    const sections = feed
      .map((topic, topicIndex) => {
        const items = topic.articles
          .slice(0, 5)
          .map((a: { url: string; title: string; source: string | null }, i: number) => {
            const outlet = extractOutlet(a.title, a.source);
            const headline = stripOutletSuffix(a.title);
            const borderTop = i === 0 ? "none" : "1px solid #ded2b0";
            const padding = i === 0 ? "0 0 14px" : "14px 0";
            return `<tr><td style="padding:${padding};border-top:${borderTop};">
              <a href="${escapeHtml(a.url)}" style="font-family:${SERIF};font-size:16px;line-height:1.35;font-weight:normal;color:#1c1a15;text-decoration:none;">${escapeHtml(headline)}</a>
              ${outlet ? `<div style="font-family:${MONO};font-size:11px;letter-spacing:0.05em;text-transform:uppercase;color:#635c4b;margin-top:5px;">${escapeHtml(outlet)}</div>` : ""}
            </td></tr>`;
          })
          .join("");
        const body =
          topic.articles.length > 0
            ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${items}</table>`
            : `<p style="font-family:${SERIF};font-style:italic;font-size:14px;color:#635c4b;margin:12px 0 0;">No matches today.</p>`;
        return `<tr><td style="padding-top:${topicIndex === 0 ? 22 : 30}px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr><td style="font-family:${SERIF};font-weight:bold;font-size:19px;letter-spacing:0.01em;text-transform:uppercase;color:#1c1a15;border-bottom:2px solid #1c1a15;padding-bottom:6px;">${escapeHtml(topic.name)}</td></tr>
          </table>
          ${body}
        </td></tr>`;
      })
      .join("");

    const topicCountLabel = `${feed.length} Topic${feed.length === 1 ? "" : "s"}`;
    const preheader = `Today's matches across ${feed.map((t) => t.name).join(", ")}.`;

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>News Digest — ${dateLabel}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1ede2;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:#f1ede2;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border-collapse:collapse;">

<tr><td align="center" style="padding:0 0 14px;">
  <img src="${iconUrl}" width="40" height="40" alt="" style="display:block;margin:0 auto 10px;border:0;" />
  <div style="font-family:${MONO};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#635c4b;margin-bottom:10px;">Est. Daily &mdash; Fresh Every Morning</div>
  <a href="${siteUrl}" style="font-family:${SERIF};font-weight:900;font-size:38px;letter-spacing:-0.01em;text-transform:uppercase;color:#1c1a15;text-decoration:none;">News Digest</a>
  <div style="font-family:${SERIF};font-style:italic;font-size:15px;color:#635c4b;margin-top:6px;">${dateLabel}</div>
</td></tr>

<tr><td style="border-top:3px double #1c1a15;border-bottom:1px solid #1c1a15;padding:8px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td align="left" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#1c1a15;">Vol. I</td>
    <td align="center" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#a3202f;">&#9679; Today's Edition</td>
    <td align="right" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#1c1a15;">${topicCountLabel}</td>
  </tr></table>
</td></tr>

${sections}

<tr><td style="padding-top:34px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
    <td align="center" style="border-top:1px solid #ded2b0;padding-top:20px;">
      <a href="${siteUrl}" style="font-family:${SERIF};font-weight:bold;font-size:14px;color:#a3202f;text-decoration:none;">Read today's full digest &rarr;</a>
      <div style="font-family:${MONO};font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#635c4b;margin-top:10px;">news-digest-web.onrender.com</div>
    </td>
  </tr></table>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

    return await sendEmail(user.email, `News Digest — ${dateLabel}`, html);
  } catch (err) {
    console.error(`Digest email failed for user ${user.id}:`, err);
    return false;
  }
}

// Best-effort, never throws, same shape as sendDigestEmailForUser — a
// failed welcome email shouldn't turn a successful signup into a failed
// one. Sent once, right after signup succeeds (including the claim-an-
// unclaimed-bootstrap-row path — that's still that user's first real login,
// so it gets the same welcome). Shares the digest email's visual system
// (same fonts/colors/masthead shape) but walks through what the site does
// instead of listing today's matches, since there isn't a feed to show yet.
async function sendWelcomeEmailForUser(user: User): Promise<boolean> {
  if (!process.env.BREVO_API_KEY || !process.env.DIGEST_EMAIL_FROM) return false;

  try {
    const siteUrl = process.env.SITE_URL ?? "https://news-digest-web.onrender.com";
    const iconUrl = `${siteUrl}/email-icon.png`;
    const SERIF = "Georgia,'Times New Roman',serif";
    const MONO = "'Courier New',ui-monospace,Menlo,Consolas,monospace";

    const features: { name: string; body: string }[] = [
      {
        name: "Add topics",
        body: "Tell it what you care about — a company, a law, a hobby — and it automatically builds a search feed for it and pulls today's matches right away.",
      },
      {
        name: "Real ranking, not just keyword hits",
        body: "Every article is scored with TF-IDF (weighted by how rare each of your keywords is across everything ingested), shown as a signal-strength meter. Click or tap it to see exactly which keywords hit.",
      },
      {
        name: "Fetches and emails on your schedule",
        body: "Pick your own delivery time and timezone under “Digest settings.” A few minutes before it, your topics are freshly fetched and matched, then emailed to you — like this one, once you're set up.",
      },
      {
        name: "Live tickers",
        body: "Add stock symbols to a sidebar with real-time prices and a 7-day trend line.",
      },
      {
        name: "7-day history",
        body: "Date pills above your feed let you look back at exactly what matched on any of the last 7 days, not just today.",
      },
    ];

    const sections = features
      .map(
        (f, i) => `<tr><td style="padding-top:${i === 0 ? 22 : 26}px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr><td style="font-family:${SERIF};font-weight:bold;font-size:17px;letter-spacing:0.01em;text-transform:uppercase;color:#1c1a15;border-bottom:2px solid #1c1a15;padding-bottom:6px;">${escapeHtml(f.name)}</td></tr>
          </table>
          <p style="font-family:${SERIF};font-size:15px;line-height:1.5;color:#1c1a15;margin:10px 0 0;">${escapeHtml(f.body)}</p>
        </td></tr>`
      )
      .join("");

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Welcome to News Digest</title>
</head>
<body style="margin:0;padding:0;background-color:#f1ede2;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">A quick tour of what News Digest does, now that you've signed up.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:#f1ede2;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border-collapse:collapse;">

<tr><td align="center" style="padding:0 0 14px;">
  <img src="${iconUrl}" width="40" height="40" alt="" style="display:block;margin:0 auto 10px;border:0;" />
  <div style="font-family:${MONO};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#635c4b;margin-bottom:10px;">Welcome Edition</div>
  <a href="${siteUrl}" style="font-family:${SERIF};font-weight:900;font-size:38px;letter-spacing:-0.01em;text-transform:uppercase;color:#1c1a15;text-decoration:none;">News Digest</a>
  <div style="font-family:${SERIF};font-style:italic;font-size:15px;color:#635c4b;margin-top:6px;">You're set up, ${escapeHtml(user.email)}.</div>
</td></tr>

<tr><td style="border-top:3px double #1c1a15;border-bottom:1px solid #1c1a15;padding:8px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td align="left" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#1c1a15;">Vol. I</td>
    <td align="center" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#a3202f;">&#9679; What You Can Do</td>
    <td align="right" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#1c1a15;">${features.length} Features</td>
  </tr></table>
</td></tr>

${sections}

<tr><td style="padding-top:34px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
    <td align="center" style="border-top:1px solid #ded2b0;padding-top:20px;">
      <a href="${siteUrl}" style="font-family:${SERIF};font-weight:bold;font-size:14px;color:#a3202f;text-decoration:none;">Add your first topic &rarr;</a>
      <div style="font-family:${MONO};font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#635c4b;margin-top:10px;">news-digest-web.onrender.com</div>
    </td>
  </tr></table>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

    return await sendEmail(user.email, "Welcome to News Digest", html);
  } catch (err) {
    console.error(`Welcome email failed for user ${user.id}:`, err);
    return false;
  }
}

// Best-effort, never throws, same contract as the other two. resetUrl
// already has the token baked in (?token=...) — the frontend reads it off
// the URL on load and shows a "set new password" form; nothing in this
// email itself needs to know that shape.
async function sendPasswordResetEmailForUser(user: User, resetUrl: string): Promise<boolean> {
  if (!process.env.BREVO_API_KEY || !process.env.DIGEST_EMAIL_FROM) return false;

  try {
    const siteUrl = process.env.SITE_URL ?? "https://news-digest-web.onrender.com";
    const iconUrl = `${siteUrl}/email-icon.png`;
    const SERIF = "Georgia,'Times New Roman',serif";
    const MONO = "'Courier New',ui-monospace,Menlo,Consolas,monospace";

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Reset your News Digest password</title>
</head>
<body style="margin:0;padding:0;background-color:#f1ede2;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Reset your News Digest password — this link expires in an hour.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:#f1ede2;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border-collapse:collapse;">

<tr><td align="center" style="padding:0 0 14px;">
  <img src="${iconUrl}" width="40" height="40" alt="" style="display:block;margin:0 auto 10px;border:0;" />
  <div style="font-family:${MONO};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#635c4b;margin-bottom:10px;">Account Notice</div>
  <a href="${siteUrl}" style="font-family:${SERIF};font-weight:900;font-size:38px;letter-spacing:-0.01em;text-transform:uppercase;color:#1c1a15;text-decoration:none;">News Digest</a>
  <div style="font-family:${SERIF};font-style:italic;font-size:15px;color:#635c4b;margin-top:6px;">Reset your password</div>
</td></tr>

<tr><td style="border-top:3px double #1c1a15;border-bottom:1px solid #1c1a15;padding:8px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td align="left" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#1c1a15;">${escapeHtml(user.email)}</td>
    <td align="right" style="font-family:${MONO};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#a3202f;">&#9679; Expires In 1 Hour</td>
  </tr></table>
</td></tr>

<tr><td style="padding-top:22px;">
  <p style="font-family:${SERIF};font-size:15px;line-height:1.5;color:#1c1a15;margin:0;">We got a request to reset the password on this account. If that was you, set a new one below — the link only works once, and only for the next hour.</p>
</td></tr>

<tr><td style="padding-top:26px;" align="center">
  <a href="${resetUrl}" style="display:inline-block;font-family:${SERIF};font-weight:bold;font-size:15px;color:#f1ede2;text-decoration:none;background-color:#a3202f;padding:12px 28px;">Set a new password &rarr;</a>
</td></tr>

<tr><td style="padding-top:22px;">
  <p style="font-family:${SERIF};font-style:italic;font-size:13px;line-height:1.5;color:#635c4b;margin:0;">Didn't request this? You can ignore this email — your password stays what it was.</p>
</td></tr>

<tr><td style="padding-top:34px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
    <td align="center" style="border-top:1px solid #ded2b0;padding-top:20px;">
      <div style="font-family:${MONO};font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#635c4b;">news-digest-web.onrender.com</div>
    </td>
  </tr></table>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

    return await sendEmail(user.email, "Reset your News Digest password", html);
  } catch (err) {
    console.error(`Password reset email failed for user ${user.id}:`, err);
    return false;
  }
}

function isValidEmail(email: string): boolean {
  // Deliberately loose — just enough to catch obvious typos/garbage, not a
  // full RFC 5322 parser. Real validation is "can they receive the digest
  // email," which nothing short of actually sending one can confirm.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const VALID_TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

function isValidTimezone(tz: string): boolean {
  return VALID_TIMEZONES.has(tz);
}

function isValidTimeString(time: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

// Creates a session and sends the standard { token, user } signup/login
// response shape.
async function respondWithSession(res: Response, userId: number, status: number): Promise<void> {
  const [token, user] = await Promise.all([createSession(userId), getUserById(userId)]);
  res.status(status).json({ token, user });
}

// Signing up with an email that already exists as an unclaimed bootstrap
// row (password_hash IS NULL — see db/schema.sql and the multi-user
// migration) claims that row instead of rejecting as a duplicate. This is
// how the pre-existing owner account's data gets attached to a real login
// the first time they actually sign up.
app.post(
  "/api/signup",
  asyncRoute(async (req, res) => {
    if (authRateLimited(clientIp(req))) {
      res.status(429).json({ error: "Too many attempts. Try again in a minute." });
      return;
    }
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!isValidEmail(email)) {
      res.status(400).json({ error: "A valid email is required." });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters." });
      return;
    }

    const existing = await getUserByEmail(email);
    if (existing) {
      if (existing.password_hash !== null) {
        recordAuthFailure(clientIp(req));
        res.status(409).json({ error: "An account with that email already exists." });
        return;
      }
      await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
        hashPassword(password),
        existing.id,
      ]);
      recordAuthSuccess(clientIp(req));
      await respondWithSession(res, existing.id, 200);
      // Fire-and-forget — don't hold up the signup response on an email
      // API call. Claiming a pre-existing bootstrap account is still this
      // user's first real login, so it gets the same welcome as a fresh one.
      getUserById(existing.id)
        .then((u) => u && sendWelcomeEmailForUser(u))
        .catch((err) => console.error("Welcome email lookup failed:", err));
      return;
    }

    const { rows } = await pool.query<{ id: number }>(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, hashPassword(password)]
    );
    recordAuthSuccess(clientIp(req));
    await respondWithSession(res, rows[0].id, 201);
    getUserById(rows[0].id)
      .then((u) => u && sendWelcomeEmailForUser(u))
      .catch((err) => console.error("Welcome email lookup failed:", err));
  })
);

app.post(
  "/api/login",
  asyncRoute(async (req, res) => {
    if (authRateLimited(clientIp(req))) {
      res.status(429).json({ error: "Too many attempts. Try again in a minute." });
      return;
    }
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    const user = await getUserByEmail(email);
    if (!user || user.password_hash === null || !verifyPassword(password, user.password_hash)) {
      recordAuthFailure(clientIp(req));
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }
    recordAuthSuccess(clientIp(req));
    await respondWithSession(res, user.id, 200);
  })
);

app.post(
  "/api/logout",
  asyncRoute(async (req, res) => {
    const authHeader = req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
    if (token) await deleteSession(token);
    res.status(204).end();
  })
);

// Always responds the same way regardless of whether the email matches a
// real, claimed account — an attacker probing which emails have accounts
// shouldn't be able to tell from the response, only from whether an email
// actually shows up (which they can't observe). Rate-limited same as
// signup/login: this is still a password-adjacent guessing surface (mass
// reset-spam against arbitrary addresses), even though it doesn't check a
// password itself.
app.post(
  "/api/forgot-password",
  asyncRoute(async (req, res) => {
    if (authRateLimited(clientIp(req))) {
      res.status(429).json({ error: "Too many attempts. Try again in a minute." });
      return;
    }
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const user = await getUserByEmail(email);
    // Only a real, already-claimed account can have its password reset —
    // an unclaimed bootstrap row has no password to forget in the first
    // place; that email should go through /api/signup instead.
    if (user && user.password_hash !== null) {
      const token = await createPasswordResetToken(user.id);
      const siteUrl = process.env.SITE_URL ?? "https://news-digest-web.onrender.com";
      const resetUrl = `${siteUrl}/?resetToken=${token}`;
      sendPasswordResetEmailForUser(user, resetUrl).catch((err) =>
        console.error("Password reset email failed:", err)
      );
    }
    recordAuthSuccess(clientIp(req));
    res.json({ ok: true, message: "If that email has an account, a reset link is on its way." });
  })
);

app.post(
  "/api/reset-password",
  asyncRoute(async (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters." });
      return;
    }

    const userId = await getUserIdByPasswordResetToken(token);
    if (!userId) {
      res.status(400).json({ error: "That reset link is invalid or has expired." });
      return;
    }

    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hashPassword(password), userId]);
    await deletePasswordResetToken(token);
    await deleteAllSessionsForUser(userId);
    // Log them straight in with a fresh session rather than sending them
    // back to a login form right after they just proved account ownership.
    await respondWithSession(res, userId, 200);
  })
);

// Lets the frontend restore session state on load (does the stored token
// still work?) without re-sending credentials.
app.get(
  "/api/me",
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = await getUserById(req.userId!);
    res.json(user);
  })
);

app.put(
  "/api/me/digest",
  requireAuth,
  asyncRoute(async (req, res) => {
    const digestTime = typeof req.body?.digestTime === "string" ? req.body.digestTime : "";
    const digestTimezone = typeof req.body?.digestTimezone === "string" ? req.body.digestTimezone : "";
    const digestEnabled = Boolean(req.body?.digestEnabled);

    if (!isValidTimeString(digestTime)) {
      res.status(400).json({ error: "digestTime must be in HH:MM (24-hour) format." });
      return;
    }
    if (!isValidTimezone(digestTimezone)) {
      res.status(400).json({ error: "digestTimezone must be a valid IANA timezone name." });
      return;
    }

    await pool.query(
      "UPDATE users SET digest_time = $1, digest_timezone = $2, digest_enabled = $3 WHERE id = $4",
      [digestTime, digestTimezone, digestEnabled, req.userId]
    );
    res.json(await getUserById(req.userId!));
  })
);

app.get(
  "/api/topics",
  asyncRoute(async (req, res) => {
    const viewerId = await resolveViewerUserId(req);
    if (viewerId === null) {
      res.json([]);
      return;
    }
    const result = await pool.query(
      "SELECT id, name, keywords, created_at FROM topics WHERE user_id = $1 ORDER BY id",
      [viewerId]
    );
    res.json(result.rows);
  })
);

app.post(
  "/api/topics",
  requireAuth,
  asyncRoute(async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const keywords = parseKeywords(req.body?.keywords);

    if (!name) {
      res.status(400).json({ error: "Topic name is required." });
      return;
    }

    let topic;
    try {
      const result = await pool.query(
        "INSERT INTO topics (user_id, name, keywords) VALUES ($1, $2, $3) RETURNING id, name, keywords, created_at",
        [req.userId, name, keywords]
      );
      topic = result.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "A topic with that name already exists." });
        return;
      }
      throw err;
    }

    // Best-effort: give the new topic a feed to search, then pull+match
    // right away so it isn't empty until someone thinks to click "Fetch
    // news." None of this should fail topic creation itself — the topic
    // already exists at this point either way.
    let warning: string | undefined;
    try {
      await pool.query(
        "INSERT INTO feeds (url, name, topic_id) VALUES ($1, $2, $3)",
        [topicFeedUrl(topic.name), `Google News: ${topic.name}`, topic.id]
      );
      await runIngestAndMatchForUser(req.userId!);
    } catch (err) {
      warning = `Topic created, but the first fetch failed: ${
        err instanceof Error ? err.message : "Unknown error"
      }. Try "Fetch news" once things are running again.`;
    }

    res.status(201).json(warning ? { ...topic, warning } : topic);
  })
);

app.put(
  "/api/topics/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid topic id." });
      return;
    }

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const keywords = parseKeywords(req.body?.keywords);

    if (!name) {
      res.status(400).json({ error: "Topic name is required." });
      return;
    }

    let topic;
    try {
      const result = await pool.query(
        "UPDATE topics SET name = $1, keywords = $2 WHERE id = $3 AND user_id = $4 RETURNING id, name, keywords, created_at",
        [name, keywords, id, req.userId]
      );
      if (result.rowCount === 0) {
        res.status(404).json({ error: "Topic not found." });
        return;
      }
      topic = result.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "A topic with that name already exists." });
        return;
      }
      throw err;
    }

    // Keep this topic's feed in sync with the new name — creating one if it
    // never had one (e.g. a topic from before this feature existed), or
    // updating the search query if it did — then re-fetch so matches
    // reflect it.
    let warning: string | undefined;
    try {
      await pool.query(
        `INSERT INTO feeds (url, name, topic_id) VALUES ($1, $2, $3)
         ON CONFLICT (topic_id)
         DO UPDATE SET url = EXCLUDED.url, name = EXCLUDED.name`,
        [topicFeedUrl(topic.name), `Google News: ${topic.name}`, topic.id]
      );
      await runIngestAndMatchForUser(req.userId!);
    } catch (err) {
      warning = `Topic updated, but re-fetching its articles failed: ${
        err instanceof Error ? err.message : "Unknown error"
      }. Try "Fetch news" once things are running again.`;
    }

    res.json(warning ? { ...topic, warning } : topic);
  })
);

app.delete(
  "/api/topics/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid topic id." });
      return;
    }

    // topic_articles rows for this topic are removed automatically via
    // ON DELETE CASCADE in the schema.
    const result = await pool.query("DELETE FROM topics WHERE id = $1 AND user_id = $2", [id, req.userId]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Topic not found." });
      return;
    }
    res.status(204).end();
  })
);

// Cap per-topic article count so an early-morning digest stays a digest,
// not a dump of every article that ever matched.
const ARTICLES_PER_TOPIC = 30;
// No single outlet should be able to fill the whole digest — fetch more raw
// candidates than we need so capping still leaves close to ARTICLES_PER_TOPIC.
const MAX_PER_SOURCE = 3;
const RAW_CANDIDATE_LIMIT = 150;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Recomputed at request time rather than stored — match.ts only keeps the
// final summed score, not which keywords contributed to it. Same
// word-boundary rule match.ts itself uses, so this always agrees with why a
// score is what it is.
function matchedKeywords(text: string, keywords: string[]): string[] {
  const haystack = text.toLowerCase();
  return keywords.filter((keyword) => {
    const pattern = new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`);
    return pattern.test(haystack);
  });
}

// `articles.source` is the feed name (e.g. "Google News: ETF") — since a
// topic typically has exactly one feed, every one of its articles shares
// that same value, making it useless for outlet diversity. The actual
// outlet lives in the title suffix instead (RSS titles from these feeds are
// conventionally "Headline - Outlet"), same convention ingest.ts's own
// dedup already relies on.
function extractOutlet(title: string, fallback: string | null): string {
  const lastDash = title.lastIndexOf(" - ");
  return lastDash > 0 ? title.slice(lastDash + 3).trim() : (fallback ?? "");
}

// Same "Headline - Outlet" convention as extractOutlet, the other half of
// it — used only by the digest email so a headline doesn't show its own
// outlet twice (once inline, once in the byline underneath).
function stripOutletSuffix(title: string): string {
  const lastDash = title.lastIndexOf(" - ");
  return lastDash > 0 ? title.slice(0, lastDash).trim() : title;
}

function capBySource<T extends { title: string; source: string | null }>(
  articles: T[],
  cap: number,
  limit: number
): T[] {
  const counts = new Map<string, number>();
  const result: T[] = [];
  for (const article of articles) {
    const key = extractOutlet(article.title, article.source);
    const count = counts.get(key) ?? 0;
    if (count >= cap) continue;
    counts.set(key, count + 1);
    result.push(article);
    if (result.length >= limit) break;
  }
  return result;
}

interface RawArticle {
  id: number;
  title: string;
  url: string;
  source: string | null;
  summary: string | null;
  published_at: string | null;
  score: number;
}

function buildArticles(candidates: RawArticle[], keywords: string[]) {
  return capBySource(candidates, MAX_PER_SOURCE, ARTICLES_PER_TOPIC).map((a) => ({
    id: a.id,
    title: a.title,
    url: a.url,
    source: a.source,
    published_at: a.published_at,
    score: a.score,
    matched: matchedKeywords(`${a.title} ${a.summary ?? ""}`, keywords),
  }));
}

// Only accepts the last 7 calendar days (today included) — the history view
// is a short lookback, not a full archive browser.
function isValidRecentDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diffDays = Math.round((todayUTC.getTime() - parsed.getTime()) / 86_400_000);
  return diffDays >= 0 && diffDays <= 6;
}

const ARTICLE_COLUMNS = "a.id, a.title, a.url, a.source, a.summary, a.published_at, ta.score";

// Shared by GET /api/feed and the scheduled digest email, so both always
// agree on what "today's feed" actually looks like.
async function buildFeed(dateParam: string | null, userId: number) {
  const { rows: topics } = await pool.query(
    "SELECT id, name, keywords FROM topics WHERE user_id = $1 ORDER BY id",
    [userId]
  );

  return Promise.all(
    topics.map(async (topic) => {
      if (dateParam) {
        // A specific past day was asked for — show exactly what matched
        // then. No "today" fallback; that framing only makes sense when no
        // explicit date was requested.
        const { rows: candidates } = await pool.query<RawArticle>(
          `SELECT ${ARTICLE_COLUMNS}
           FROM topic_articles ta
           JOIN articles a ON a.id = ta.article_id
           WHERE ta.topic_id = $1 AND a.published_at::date = $2::date
           ORDER BY ta.score DESC
           LIMIT $3`,
          [topic.id, dateParam, RAW_CANDIDATE_LIMIT]
        );
        return { ...topic, articles: buildArticles(candidates, topic.keywords), stale: false };
      }

      // "Today" per the server's clock (UTC in local dev) — matches plan.md's
      // punted decision to not deal with per-user timezones yet.
      const { rows: todayCandidates } = await pool.query<RawArticle>(
        `SELECT ${ARTICLE_COLUMNS}
         FROM topic_articles ta
         JOIN articles a ON a.id = ta.article_id
         WHERE ta.topic_id = $1 AND a.published_at::date = CURRENT_DATE
         ORDER BY ta.score DESC
         LIMIT $2`,
        [topic.id, RAW_CANDIDATE_LIMIT]
      );

      if (todayCandidates.length > 0) {
        return { ...topic, articles: buildArticles(todayCandidates, topic.keywords), stale: false };
      }

      // Nothing matched today — fall back to this topic's most recent
      // matches regardless of date, newest first, rather than leaving the
      // card empty. `stale` tells the frontend to label these as such.
      const { rows: recentCandidates } = await pool.query<RawArticle>(
        `SELECT ${ARTICLE_COLUMNS}
         FROM topic_articles ta
         JOIN articles a ON a.id = ta.article_id
         WHERE ta.topic_id = $1
         ORDER BY a.published_at DESC NULLS LAST
         LIMIT $2`,
        [topic.id, RAW_CANDIDATE_LIMIT]
      );
      const articles = buildArticles(recentCandidates, topic.keywords);
      return { ...topic, articles, stale: articles.length > 0 };
    })
  );
}

app.get(
  "/api/feed",
  asyncRoute(async (req, res) => {
    const dateParam = typeof req.query.date === "string" ? req.query.date : null;
    if (dateParam && !isValidRecentDate(dateParam)) {
      res.status(400).json({ error: "date must be YYYY-MM-DD within the last 7 days." });
      return;
    }

    const viewerId = await resolveViewerUserId(req);
    if (viewerId === null) {
      res.json([]);
      return;
    }
    res.json(await buildFeed(dateParam, viewerId));
  })
);

// Machine-to-machine only — the scheduled GitHub Actions tick, using
// FETCH_SECRET (a token that's never shipped to the browser). No fallback
// to a user session: /api/tick acts across every due user in one call, not
// on behalf of whoever happens to be logged in.
function requireFetchAuth(req: Request, res: Response, next: NextFunction) {
  const fetchSecret = process.env.FETCH_SECRET;
  const authHeader = req.header("Authorization");
  if (fetchSecret && authHeader && safeEqual(authHeader, `Bearer ${fetchSecret}`)) {
    next();
    return;
  }
  res.status(401).json({ error: "Fetch secret required." });
}

// Manual, on-demand version of what Milestone 2/3's scripts do by hand —
// always scoped to the logged-in user's own topics. Never sends email;
// that only ever happens from the scheduled per-user tick below, so
// clicking this never spams anyone's inbox.
app.post(
  "/api/fetch",
  requireAuth,
  asyncRoute(async (req, res) => {
    try {
      const { ingest, match } = await runIngestAndMatchForUser(req.userId!);
      res.json({ ok: true, ingest, match });
    } catch (err) {
      const stderr = (err as { stderr?: string })?.stderr;
      const message = stderr?.trim() || (err instanceof Error ? err.message : "Unknown error");
      res.status(502).json({ error: `Fetch failed: ${message}` });
    }
  })
);

// Converts an IANA timezone name into that zone's current local HH:MM and
// YYYY-MM-DD — Intl.DateTimeFormat handles DST correctly on its own, no
// manual offset math. en-CA's date order is conveniently YYYY-MM-DD.
function getLocalTimeAndDate(timezone: string): { time: string; date: string } {
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

function minutesSinceMidnight(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// True if `now` has reached `target` within the last `window` minutes,
// wrapping correctly across midnight (mod 1440) — e.g. a target of 00:02
// with a 5-minute pre-fetch offset lands at 23:57 the previous day.
function withinWindow(nowMinutes: number, targetMinutes: number, windowMinutes: number): boolean {
  const diff = (((nowMinutes - targetMinutes) % 1440) + 1440) % 1440;
  return diff < windowMinutes;
}

// How far apart the pre-send fetch and the send itself are, and how wide a
// tolerance band each gets around its target — both tied to the tick
// cadence (every 5 minutes; see .github/workflows/tick.yml), padded a
// little for GitHub's own scheduler jitter.
const TICK_PRE_FETCH_MINUTES = 5;
const TICK_WINDOW_MINUTES = 10;

// The scheduled heart of per-user delivery: every 5 minutes, for every user
// with digest_enabled, checks whether "now" (in that user's own timezone)
// has just reached their pre-fetch window (fetch + match their topics only)
// or their actual send time (build and email their feed) — each gated by
// last_fetch_date/last_digest_sent_date so a re-trigger within the same
// local day is a no-op. There's no global ingest left at all; every fetch
// here is scoped to exactly one user via runIngestAndMatchForUser.
app.post(
  "/api/tick",
  requireFetchAuth,
  asyncRoute(async (_req, res) => {
    const { rows: users } = await pool.query<User>(
      `SELECT id, email, digest_time, digest_timezone, digest_enabled, last_fetch_date, last_digest_sent_date, created_at
       FROM users WHERE digest_enabled = true`
    );

    const results: { userId: number; fetched: boolean; sent: boolean; error?: string }[] = [];

    for (const user of users) {
      const { time: localTime, date: localDate } = getLocalTimeAndDate(user.digest_timezone);
      const nowMinutes = minutesSinceMidnight(localTime);
      const sendTargetMinutes = minutesSinceMidnight(user.digest_time);
      const fetchTargetMinutes = ((sendTargetMinutes - TICK_PRE_FETCH_MINUTES) % 1440 + 1440) % 1440;

      const dueForFetch =
        withinWindow(nowMinutes, fetchTargetMinutes, TICK_WINDOW_MINUTES) && user.last_fetch_date !== localDate;
      const dueForSend =
        withinWindow(nowMinutes, sendTargetMinutes, TICK_WINDOW_MINUTES) &&
        user.last_digest_sent_date !== localDate;

      if (!dueForFetch && !dueForSend) continue;

      let fetched = false;
      let sent = false;
      let error: string | undefined;

      if (dueForFetch) {
        try {
          await runIngestAndMatchForUser(user.id);
          await pool.query("UPDATE users SET last_fetch_date = $1 WHERE id = $2", [localDate, user.id]);
          fetched = true;
        } catch (err) {
          error = `fetch: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      }

      if (dueForSend) {
        sent = await sendDigestEmailForUser(user);
        if (sent) {
          await pool.query("UPDATE users SET last_digest_sent_date = $1 WHERE id = $2", [localDate, user.id]);
        } else {
          error = error ? `${error}; send failed` : "send failed";
        }
      }

      results.push({ userId: user.id, fetched, sent, error });
    }

    res.json({ ok: true, results });
  })
);

interface Quote {
  symbol: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string | null;
  marketTime: number | null;
  // Up to 7 most recent daily closes, oldest first, for the sidebar
  // sparkline. Empty when unavailable — never blocks showing the price.
  history: number[];
  error?: string;
}

// Yahoo Finance's unofficial chart endpoint — no API key required, same
// no-signup spirit as using Google News RSS for articles. Unofficial and
// could break or rate-limit without notice; each ticker fails independently
// rather than taking the whole panel down (see DECISIONS.md).
async function fetchQuote(symbol: string): Promise<Quote> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`Yahoo returned ${res.status}`);

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta || typeof meta.regularMarketPrice !== "number") {
      throw new Error("Unrecognized symbol or response shape");
    }

    const price = meta.regularMarketPrice;
    const previousClose = meta.previousClose ?? meta.chartPreviousClose ?? price;
    const change = price - previousClose;
    const changePercent = previousClose !== 0 ? (change / previousClose) * 100 : 0;

    const closes: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
    const history = closes
      .filter((c): c is number => typeof c === "number")
      .slice(-7);

    return {
      symbol,
      price,
      change,
      changePercent,
      currency: meta.currency ?? null,
      marketTime: meta.regularMarketTime ?? null,
      history,
    };
  } catch (err) {
    return {
      symbol,
      price: null,
      change: null,
      changePercent: null,
      currency: null,
      marketTime: null,
      history: [],
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

app.get(
  "/api/tickers",
  asyncRoute(async (req, res) => {
    const viewerId = await resolveViewerUserId(req);
    if (viewerId === null) {
      res.json([]);
      return;
    }
    const { rows: tickers } = await pool.query(
      "SELECT id, symbol FROM tickers WHERE user_id = $1 ORDER BY id",
      [viewerId]
    );
    const withQuotes = await Promise.all(
      tickers.map(async (ticker) => ({ ...ticker, quote: await fetchQuote(ticker.symbol) }))
    );
    res.json(withQuotes);
  })
);

app.post(
  "/api/tickers",
  requireAuth,
  asyncRoute(async (req, res) => {
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol.trim().toUpperCase() : "";
    if (!symbol) {
      res.status(400).json({ error: "Ticker symbol is required." });
      return;
    }

    // Confirm it's a real, quotable symbol before storing it — otherwise a
    // typo just sits there as a permanently broken card.
    const quote = await fetchQuote(symbol);
    if (quote.error) {
      res.status(400).json({ error: `Couldn't find a quote for "${symbol}".` });
      return;
    }

    try {
      const result = await pool.query(
        "INSERT INTO tickers (user_id, symbol) VALUES ($1, $2) RETURNING id, symbol",
        [req.userId, symbol]
      );
      res.status(201).json({ ...result.rows[0], quote });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "That ticker is already being watched." });
        return;
      }
      throw err;
    }
  })
);

app.delete(
  "/api/tickers/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid ticker id." });
      return;
    }

    const result = await pool.query("DELETE FROM tickers WHERE id = $1 AND user_id = $2", [id, req.userId]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Ticker not found." });
      return;
    }
    res.status(204).end();
  })
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});
