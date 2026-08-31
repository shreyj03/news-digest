import { useEffect, useState, type FormEvent } from "react";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3001";
const TICKER_REFRESH_MS = 60_000;
const AUTH_TOKEN_KEY = "news-digest-auth-token";

interface Article {
  id: number;
  title: string;
  url: string;
  source: string | null;
  ai_summary: string | null;
  published_at: string | null;
  score: number;
  matched: string[];
  // The single article an AI pass picked as this topic's biggest story for
  // the day it matched on — see topic_recaps in db/schema.sql.
  top_story: boolean;
}

interface TopicFeed {
  id: number;
  name: string;
  keywords: string[];
  articles: Article[];
  // true when nothing matched today, so `articles` is a fallback of the
  // topic's most recent matches (any date), newest first.
  stale: boolean;
  // AI-written 2-3 sentence recap of the day this feed reflects — null
  // when unset (no GEMINI_API_KEY) or when `stale` (a recap only ever
  // describes one specific day).
  recap: string | null;
}

interface Quote {
  price: number | null;
  change: number | null;
  changePercent: number | null;
  currency: string | null;
  history: number[];
  error?: string;
}

interface Ticker {
  id: number;
  symbol: string;
  quote: Quote;
}

interface CurrentUser {
  id: number;
  email: string;
  digest_time: string;
  digest_timezone: string;
  digest_enabled: boolean;
}

function parseKeywordsInput(input: string): string[] {
  return input
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error ?? fallback;
}

// Show the strongest matches first; the rest are a click away rather than
// dumped in one wall of rows — a digest should read like one, even when the
// API is holding up to 30 per topic.
const VISIBLE_ARTICLES = 5;

const todayLabel = new Date().toLocaleDateString(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

// The last 7 days (today first), computed in UTC to match the server's own
// "today" — see /api/feed's comment on why that's the operating definition.
function lastSevenDays(): { value: string; label: string }[] {
  const now = new Date();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const value = d.toISOString().slice(0, 10);
    const label =
      i === 0
        ? "Today"
        : i === 1
          ? "Yesterday"
          : d.toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" });
    days.push({ value, label });
  }
  return days;
}

/**
 * Match strength, normalized against the best-scoring article in the same
 * topic. A raw TF-IDF float doesn't mean anything on its own — this turns it
 * into something scannable, while the exact score stays visible underneath
 * for anyone who wants it.
 */
function SignalMeter({
  score,
  topScore,
  matched,
  isOpen,
  onToggle,
}: {
  score: number;
  topScore: number;
  matched: string[];
  isOpen: boolean;
  onToggle: () => void;
}) {
  // Native `title` hover is kept (slow, but still useful on desktop) *and*
  // click/tap toggles a caption open for touch devices where hover doesn't
  // exist at all. Open state is owned by the parent (see openMatchId) so opening
  // one closes any other, and a click anywhere else closes it too.
  const ratio = topScore > 0 ? score / topScore : 0;
  const lit = Math.max(1, Math.min(5, Math.round(ratio * 5)));
  const why = matched.length > 0 ? `Matched: ${matched.join(", ")}` : "No keyword matched directly";

  return (
    <button
      type="button"
      className="meter"
      title={why}
      aria-label={`Match strength ${lit} of 5, score ${score.toFixed(2)}. ${why}. Tap for details.`}
      aria-expanded={isOpen}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <div className="meter-bars" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((bar) => (
          <span key={bar} className={bar <= lit ? "lit" : ""} />
        ))}
      </div>
      <span className="meter-score" aria-hidden="true">
        {score.toFixed(2)}
      </span>
      {isOpen && (
        <span className="meter-why" aria-hidden="true">
          {why}
        </span>
      )}
    </button>
  );
}

// A tiny inline trend line — up to 7 daily closes, oldest first. Height and
// color communicate direction at a glance; exact numbers stay in the price
// line above it.
function Sparkline({ history }: { history: number[] }) {
  if (history.length < 2) return null;

  const width = 60;
  const height = 20;
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = max - min || 1;
  const points = history
    .map((value, i) => {
      const x = (i / (history.length - 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const isUp = history[history.length - 1] >= history[0];

  return (
    <svg
      className={`sparkline ${isUp ? "up" : "down"}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
    >
      <polyline points={points} fill="none" strokeWidth="1.5" />
    </svg>
  );
}

function TickerRow({
  ticker,
  onRemove,
}: {
  ticker: Ticker;
  onRemove?: (id: number) => void;
}) {
  const { quote } = ticker;
  const isUp = (quote.change ?? 0) >= 0;

  return (
    <div className="ticker-row">
      <div className="ticker-top">
        <span className="ticker-symbol">{ticker.symbol}</span>
        {onRemove && (
          <button
            className="ticker-remove"
            onClick={() => onRemove(ticker.id)}
            aria-label={`Stop watching ${ticker.symbol}`}
          >
            ×
          </button>
        )}
      </div>
      {quote.error || quote.price === null ? (
        <span className="ticker-unavailable">Price unavailable</span>
      ) : (
        <div className="ticker-price-line">
          <span className="ticker-price">${quote.price.toFixed(2)}</span>
          <span className={`ticker-change ${isUp ? "up" : "down"}`}>
            {isUp ? "▲" : "▼"} {Math.abs(quote.changePercent ?? 0).toFixed(2)}%
          </span>
          <Sparkline history={quote.history} />
        </div>
      )}
    </div>
  );
}

function App() {
  const [feed, setFeed] = useState<TopicFeed[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [feedLoaded, setFeedLoaded] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editKeywords, setEditKeywords] = useState("");

  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [expandedTopics, setExpandedTopics] = useState<Set<number>>(new Set());

  const [newName, setNewName] = useState("");
  const [newKeywords, setNewKeywords] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [addingTopic, setAddingTopic] = useState(false);

  const [savingEdit, setSavingEdit] = useState(false);

  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState<string | null>(null);

  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [newTicker, setNewTicker] = useState("");
  const [tickerError, setTickerError] = useState<string | null>(null);
  const [addingTicker, setAddingTicker] = useState(false);

  // null = today, with the server's own stale-fallback behavior. A specific
  // YYYY-MM-DD shows exactly that day with no fallback (see /api/feed).
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const dateOptions = lastSevenDays();

  // Which article's "why did this match" caption is open, if any — owned
  // here (not locally in SignalMeter) so opening one closes any other, and
  // any click outside a meter closes it too.
  const [openMatchId, setOpenMatchId] = useState<number | null>(null);
  useEffect(() => {
    const closeOnOutsideClick = () => setOpenMatchId(null);
    document.addEventListener("click", closeOnOutsideClick);
    return () => document.removeEventListener("click", closeOnOutsideClick);
  }, []);

  // Per-user account state — replaces the old shared SITE_PASSWORD model
  // entirely. No token/no valid session = viewing the read-only demo (the
  // account GET routes fall back to server-side); a valid session scopes
  // everything to that user's own topics/tickers.
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem(AUTH_TOKEN_KEY));
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup" | "forgot" | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);

  // Set only when the page loads with ?resetToken=... (from the email link)
  // — takes over the whole auth-row area with a "set new password" form
  // regardless of authMode while it's active.
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [resetPasswordInput, setResetPasswordInput] = useState("");
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("resetToken");
    if (!token) return;
    setResetToken(token);
    // Strip it from the URL so a refresh doesn't re-show/resubmit it.
    params.delete("resetToken");
    const rest = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : ""));
  }, []);

  const [showDigestSettings, setShowDigestSettings] = useState(false);
  const [digestTime, setDigestTime] = useState("07:00");
  const [digestTimezone, setDigestTimezone] = useState("America/Los_Angeles");
  const [digestEnabled, setDigestEnabled] = useState(true);
  const [savingDigest, setSavingDigest] = useState(false);
  const [digestError, setDigestError] = useState<string | null>(null);

  // Accepts an optional override so callers that just changed the token
  // (login/signup/logout) can use the fresh value immediately — setAuthToken
  // is async, so a call made in the same handler would otherwise still read
  // the stale value from this render's closure.
  function authHeaders(tokenOverride?: string | null): Record<string, string> {
    const token = tokenOverride !== undefined ? tokenOverride : authToken;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function clearAuth() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    setAuthToken(null);
    setCurrentUser(null);
  }

  // Shared 401 handling for every mutating call below: the stored session
  // (if any) turned out to be invalid or expired, so drop it and fall back
  // to the demo view rather than silently failing.
  function handleUnauthorized() {
    clearAuth();
    setAuthMode("login");
    setAuthError("Session expired — please log in again.");
  }

  // Restores a session from a stored token on load (does it still work?),
  // and — separately — fetches the digest settings form's own initial state
  // once a user is confirmed. A stale/invalid token just falls back to the
  // demo view rather than erroring.
  useEffect(() => {
    if (!authToken) {
      setAuthChecked(true);
      return;
    }
    fetch(`${API_BASE}/api/me`, { headers: authHeaders() })
      .then((res) => {
        if (!res.ok) throw new Error("invalid session");
        return res.json();
      })
      .then((user: CurrentUser) => {
        setCurrentUser(user);
        setDigestTime(user.digest_time.slice(0, 5));
        setDigestTimezone(user.digest_timezone);
        setDigestEnabled(user.digest_enabled);
      })
      .catch(() => clearAuth())
      .finally(() => setAuthChecked(true));
    // Only re-run if the token itself changes (login/logout) — not on every
    // render, and not keyed to authHeaders() which is a new object each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  async function handleAuthSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!authMode) return;
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setAuthError(body?.error ?? `${authMode === "login" ? "Login" : "Sign up"} failed.`);
        return;
      }

      localStorage.setItem(AUTH_TOKEN_KEY, body.token);
      setAuthToken(body.token);
      setCurrentUser(body.user);
      setDigestTime(body.user.digest_time.slice(0, 5));
      setDigestEnabled(body.user.digest_enabled);
      setAuthEmail("");
      setAuthPassword("");
      setAuthMode(null);

      // New accounts start on the DB's blanket default timezone
      // (America/Los_Angeles) — nudge it to whatever the browser itself
      // reports right away, a much more likely-correct starting point than
      // a fixed default, without asking during signup itself.
      if (authMode === "signup") {
        const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        setDigestTimezone(detectedTz);
        fetch(`${API_BASE}/api/me/digest`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${body.token}` },
          body: JSON.stringify({
            digestTime: body.user.digest_time.slice(0, 5),
            digestTimezone: detectedTz,
            digestEnabled: body.user.digest_enabled,
          }),
        }).catch(() => {
          // Best-effort — the account still works fine with the DB default.
        });
      } else {
        setDigestTimezone(body.user.digest_timezone);
      }

      loadFeed(selectedDate, body.token);
      loadTickers(body.token);
    } catch {
      setAuthError("Couldn't reach the API.");
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleForgotPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAuthError(null);
    setForgotSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authEmail }),
      });
      const body = await res.json().catch(() => null);
      // Always the same message regardless of whether the email matched an
      // account — matches the API's own intentionally-generic response.
      setForgotMessage(body?.message ?? "If that email has an account, a reset link is on its way.");
    } catch {
      setAuthError("Couldn't reach the API.");
    } finally {
      setForgotSubmitting(false);
    }
  }

  async function handleResetPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setResetError(null);
    setResetSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resetToken, password: resetPasswordInput }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setResetError(body?.error ?? "That reset link is invalid or has expired.");
        return;
      }

      localStorage.setItem(AUTH_TOKEN_KEY, body.token);
      setAuthToken(body.token);
      setCurrentUser(body.user);
      setDigestTime(body.user.digest_time.slice(0, 5));
      setDigestTimezone(body.user.digest_timezone);
      setDigestEnabled(body.user.digest_enabled);
      setResetToken(null);
      setResetPasswordInput("");
      loadFeed(selectedDate, body.token);
      loadTickers(body.token);
    } catch {
      setResetError("Couldn't reach the API.");
    } finally {
      setResetSubmitting(false);
    }
  }

  async function handleLogout() {
    fetch(`${API_BASE}/api/logout`, { method: "POST", headers: authHeaders() }).catch(() => {
      // Logging out locally is what matters — a failed server-side delete
      // just means the token expires on its own later.
    });
    clearAuth();
    loadFeed(selectedDate, null);
    loadTickers(null);
  }

  async function handleSaveDigest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDigestError(null);
    setSavingDigest(true);
    try {
      const res = await fetch(`${API_BASE}/api/me/digest`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ digestTime, digestTimezone, digestEnabled }),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        setDigestError(body?.error ?? `Failed to save (${res.status})`);
        return;
      }
      setCurrentUser(body);
      setShowDigestSettings(false);
    } finally {
      setSavingDigest(false);
    }
  }

  function loadFeed(date: string | null = selectedDate, tokenOverride?: string | null) {
    const url = date ? `${API_BASE}/api/feed?date=${date}` : `${API_BASE}/api/feed`;
    fetch(url, { headers: authHeaders(tokenOverride) })
      .then((res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        return res.json();
      })
      .then((data) => {
        setFeed(data);
        setFeedLoaded(true);
      })
      .catch((err) => setError(err.message));
  }

  function selectDate(value: string) {
    const isToday = value === dateOptions[0].value;
    const next = isToday ? null : value;
    setSelectedDate(next);
    loadFeed(next);
  }

  function loadTickers(tokenOverride?: string | null) {
    fetch(`${API_BASE}/api/tickers`, { headers: authHeaders(tokenOverride) })
      .then((res) => {
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        return res.json();
      })
      .then(setTickers)
      .catch(() => {
        // Quiet failure — the ticker panel is a nice-to-have, not core to
        // the page, so it just keeps showing its last-known prices.
      });
  }

  useEffect(() => {
    loadFeed();
    loadTickers();
    const interval = setInterval(loadTickers, TICKER_REFRESH_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAddTopic(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const name = newName.trim();
    if (!name) {
      setFormError("Topic name is required.");
      return;
    }

    setAddingTopic(true);
    try {
      const res = await fetch(`${API_BASE}/api/topics`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name, keywords: parseKeywordsInput(newKeywords) }),
      });
      const body = await res.json().catch(() => null);

      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        setFormError(body?.error ?? `Failed to add topic (${res.status})`);
        return;
      }

      setNewName("");
      setNewKeywords("");
      if (body?.warning) setFetchStatus(body.warning);
      loadFeed();
    } finally {
      setAddingTopic(false);
    }
  }

  function startEdit(topic: TopicFeed) {
    setConfirmDeleteId(null);
    setEditingId(topic.id);
    setEditName(topic.name);
    setEditKeywords(topic.keywords.join(", "));
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function handleFetchNews() {
    setFetching(true);
    setFetchStatus(null);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/fetch`, {
        method: "POST",
        headers: authHeaders(),
      });
      const body = await res.json().catch(() => null);

      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        setError(body?.error ?? `Fetch failed (${res.status})`);
        return;
      }

      const parts = [body?.ingest, body?.match].filter(Boolean);
      setFetchStatus(parts.length > 0 ? parts.join(" — ") : "Fetch complete.");
      loadFeed();
    } catch {
      setError("Fetch failed — is the API running?");
    } finally {
      setFetching(false);
    }
  }

  function toggleExpanded(id: number) {
    setExpandedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveEdit(id: number) {
    const name = editName.trim();
    if (!name) return;

    setSavingEdit(true);
    try {
      const res = await fetch(`${API_BASE}/api/topics/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name, keywords: parseKeywordsInput(editKeywords) }),
      });
      const body = await res.json().catch(() => null);

      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        setError(body?.error ?? `Failed to save topic (${res.status})`);
        return;
      }

      if (body?.warning) setFetchStatus(body.warning);
      setEditingId(null);
      loadFeed();
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDeleteClick(id: number) {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }

    const res = await fetch(`${API_BASE}/api/topics/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    setConfirmDeleteId(null);

    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!res.ok) {
      setError(await readErrorMessage(res, `Failed to delete topic (${res.status})`));
      return;
    }

    loadFeed();
  }

  async function handleAddTicker(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTickerError(null);
    const symbol = newTicker.trim();
    if (!symbol) return;

    setAddingTicker(true);
    try {
      const res = await fetch(`${API_BASE}/api/tickers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ symbol }),
      });
      const body = await res.json().catch(() => null);

      if (res.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!res.ok) {
        setTickerError(body?.error ?? `Failed to add ticker (${res.status})`);
        return;
      }

      setNewTicker("");
      loadTickers();
    } finally {
      setAddingTicker(false);
    }
  }

  async function handleRemoveTicker(id: number) {
    const res = await fetch(`${API_BASE}/api/tickers/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (res.status === 401) {
      handleUnauthorized();
      return;
    }
    if (res.ok) loadTickers();
  }

  const timezoneOptions = Intl.supportedValuesOf("timeZone");

  return (
    <div className="page">
      <main className="content">
        <header className="masthead">
          <h1>News Digest</h1>
          <p className="tagline">Your topics, matched against fresh articles every morning.</p>
          <div className="dateline">
            <span className="date">{todayLabel}</span>
            {currentUser ? (
              <>
                <span className="fetch-status">
                  {fetching
                    ? "Fetching…"
                    : (fetchStatus ?? "Pulls fresh articles, then re-scores your topics.")}
                </span>
                <button onClick={handleFetchNews} disabled={fetching}>
                  {fetching ? "Fetching…" : "Refresh my feed"}
                </button>
              </>
            ) : (
              <span className="fetch-status">Live example — sign up to build your own.</span>
            )}
          </div>
          <div className="date-picker">
            {dateOptions.map((day) => {
              const isToday = day.value === dateOptions[0].value;
              const active = isToday ? selectedDate === null : selectedDate === day.value;
              return (
                <button
                  key={day.value}
                  className={active ? "active" : ""}
                  onClick={() => selectDate(day.value)}
                >
                  {day.label}
                </button>
              );
            })}
          </div>
          <div className="auth-row">
            {resetToken ? (
              <form className="unlock-form" onSubmit={handleResetPassword}>
                <input
                  type="password"
                  value={resetPasswordInput}
                  onChange={(e) => setResetPasswordInput(e.target.value)}
                  placeholder="New password"
                  autoFocus
                />
                <button type="submit" disabled={resetSubmitting}>
                  {resetSubmitting ? "…" : "Set new password"}
                </button>
                <button type="button" className="auth-toggle" onClick={() => setResetToken(null)}>
                  Cancel
                </button>
                {resetError && <span className="auth-error">{resetError}</span>}
              </form>
            ) : !authChecked ? null : currentUser ? (
              <>
                <span className="auth-status">{currentUser.email}</span>
                <button className="auth-toggle" onClick={() => setShowDigestSettings((v) => !v)}>
                  Digest settings
                </button>
                <button className="auth-toggle" onClick={handleLogout}>
                  Log out
                </button>
              </>
            ) : authMode === "forgot" ? (
              forgotMessage ? (
                <>
                  <span className="auth-status">{forgotMessage}</span>
                  <button
                    className="auth-toggle"
                    onClick={() => {
                      setAuthMode("login");
                      setForgotMessage(null);
                    }}
                  >
                    Back to login
                  </button>
                </>
              ) : (
                <form className="unlock-form" onSubmit={handleForgotPassword}>
                  <input
                    type="email"
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="Email"
                    autoFocus
                  />
                  <button type="submit" disabled={forgotSubmitting}>
                    {forgotSubmitting ? "…" : "Send reset link"}
                  </button>
                  <button type="button" className="auth-toggle" onClick={() => setAuthMode("login")}>
                    Cancel
                  </button>
                  {authError && <span className="auth-error">{authError}</span>}
                </form>
              )
            ) : authMode ? (
              <form className="unlock-form" onSubmit={handleAuthSubmit}>
                <input
                  type="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="Email"
                  autoFocus
                />
                <input
                  type="password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="Password"
                />
                <button type="submit" disabled={authSubmitting}>
                  {authSubmitting ? "…" : authMode === "login" ? "Log in" : "Sign up"}
                </button>
                <button
                  type="button"
                  className="auth-toggle"
                  onClick={() => setAuthMode(authMode === "login" ? "signup" : "login")}
                >
                  {authMode === "login" ? "Need an account?" : "Have an account?"}
                </button>
                {authMode === "login" && (
                  <button type="button" className="auth-toggle" onClick={() => setAuthMode("forgot")}>
                    Forgot password?
                  </button>
                )}
                <button type="button" className="auth-toggle" onClick={() => setAuthMode(null)}>
                  Cancel
                </button>
                {authError && <span className="auth-error">{authError}</span>}
              </form>
            ) : (
              <>
                <span className="demo-banner">You're viewing a demo.</span>
                <button className="auth-toggle" onClick={() => setAuthMode("signup")}>
                  Sign up
                </button>
                <button className="auth-toggle" onClick={() => setAuthMode("login")}>
                  Log in
                </button>
              </>
            )}
          </div>
          {currentUser && showDigestSettings && (
            <form className="digest-settings" onSubmit={handleSaveDigest}>
              <label>
                Send my digest at
                <input
                  type="time"
                  value={digestTime}
                  onChange={(e) => setDigestTime(e.target.value)}
                />
              </label>
              <label>
                in
                <select value={digestTimezone} onChange={(e) => setDigestTimezone(e.target.value)}>
                  {timezoneOptions.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </label>
              <label className="digest-enabled">
                <input
                  type="checkbox"
                  checked={digestEnabled}
                  onChange={(e) => setDigestEnabled(e.target.checked)}
                />
                Email me a daily digest
              </label>
              <button type="submit" disabled={savingDigest}>
                {savingDigest ? "Saving…" : "Save"}
              </button>
              {digestError && <p className="error">{digestError}</p>}
            </form>
          )}
        </header>

        {currentUser && (
          <section className="add-topic">
            <h2>Add a topic</h2>
            <form onSubmit={handleAddTopic}>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Topic name"
              />
              <input
                value={newKeywords}
                onChange={(e) => setNewKeywords(e.target.value)}
                placeholder="Keywords, comma separated (optional)"
              />
              <button type="submit" disabled={addingTopic}>
                {addingTopic ? "Adding…" : "Add topic"}
              </button>
              {formError && <p className="error">{formError}</p>}
            </form>
            <p className="hint">
              We'll search Google News for this topic's name and pull today's matches right away —
              leave keywords blank (or sparse) and we'll round them out automatically.
            </p>
          </section>
        )}

        {error && <p className="page-error">{error}</p>}

        {feedLoaded && currentUser && feed.length === 0 && (
          <p className="empty-account">
            You don't have any topics yet — add one above to start your feed.
          </p>
        )}

        <div className="topics-grid">
          {feed.map((topic) => {
            const topScore = topic.articles.reduce((max, a) => Math.max(max, a.score), 0);
            const expanded = expandedTopics.has(topic.id);
            const visibleArticles = expanded
              ? topic.articles
              : topic.articles.slice(0, VISIBLE_ARTICLES);
            const hiddenCount = topic.articles.length - visibleArticles.length;

            return (
              <section key={topic.id} className="topic">
                {editingId === topic.id ? (
                  <div className="edit-form">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Topic name"
                    />
                    <input
                      value={editKeywords}
                      onChange={(e) => setEditKeywords(e.target.value)}
                      placeholder="Keywords, comma separated"
                    />
                    <div className="topic-actions">
                      <button onClick={() => saveEdit(topic.id)} disabled={savingEdit}>
                        {savingEdit ? "Saving…" : "Save"}
                      </button>
                      <button onClick={cancelEdit} disabled={savingEdit}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="topic-header">
                    <div>
                      <h2>{topic.name}</h2>
                      <p className="keywords">
                        {topic.keywords.join(" · ")}
                        {topic.articles.length > 0 && (
                          <span className="count"> — {topic.articles.length} matched</span>
                        )}
                      </p>
                    </div>
                    {currentUser && (
                      <div className="topic-actions">
                        <button onClick={() => startEdit(topic)}>Edit</button>
                        <button onClick={() => handleDeleteClick(topic.id)} className="danger">
                          {confirmDeleteId === topic.id ? "Confirm delete" : "Delete"}
                        </button>
                        {confirmDeleteId === topic.id && (
                          <button onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {topic.recap && <p className="recap">{topic.recap}</p>}

                {topic.articles.length === 0 ? (
                  <p className="empty">
                    {selectedDate ? "No matches on this day." : 'No matches today yet. Try "Fetch news".'}
                  </p>
                ) : (
                  <>
                    {topic.stale && (
                      <p className="stale-note">
                        Nothing matched today — showing the most recent matches.
                      </p>
                    )}
                    <ul className="articles">
                      {visibleArticles.map((article) => (
                        <li key={article.id}>
                          <SignalMeter
                            score={article.score}
                            topScore={topScore}
                            matched={article.matched}
                            isOpen={openMatchId === article.id}
                            onToggle={() =>
                              setOpenMatchId((current) => (current === article.id ? null : article.id))
                            }
                          />
                          <div className="article-body">
                            {article.top_story && <span className="top-story">Top story</span>}
                            <a href={article.url} target="_blank" rel="noreferrer">
                              {article.title}
                            </a>
                            {article.ai_summary && (
                              <p className="ai-summary">{article.ai_summary}</p>
                            )}
                            <div className="meta">
                              {article.source ?? "Unknown source"}
                              {article.published_at &&
                                ` · ${new Date(article.published_at).toLocaleDateString()}`}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                    {(hiddenCount > 0 || expanded) && topic.articles.length > VISIBLE_ARTICLES && (
                      <button className="show-more" onClick={() => toggleExpanded(topic.id)}>
                        {expanded ? "Show fewer" : `Show ${hiddenCount} more`}
                      </button>
                    )}
                  </>
                )}
              </section>
            );
          })}
        </div>
      </main>

      <aside className="tickers-panel">
        <h2>Tickers</h2>
        <div className="ticker-list">
          {tickers.map((ticker) => (
            <TickerRow key={ticker.id} ticker={ticker} onRemove={currentUser ? handleRemoveTicker : undefined} />
          ))}
        </div>
        {currentUser && (
          <>
            <form className="add-ticker" onSubmit={handleAddTicker}>
              <input
                value={newTicker}
                onChange={(e) => setNewTicker(e.target.value)}
                placeholder="Symbol, e.g. AAPL"
              />
              <button type="submit" disabled={addingTicker}>
                {addingTicker ? "Adding…" : "Add"}
              </button>
            </form>
            {tickerError && <p className="error">{tickerError}</p>}
          </>
        )}
      </aside>
    </div>
  );
}

export default App;
