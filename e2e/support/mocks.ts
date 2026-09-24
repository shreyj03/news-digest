import type { Page, Route } from "@playwright/test";
import { API_URL } from "./env";

// The page (localhost:5273) and the API (localhost:3101) are different
// origins, so a mocked response has to answer CORS itself. `authorization`
// is listed explicitly because a wildcard doesn't cover it.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type,cf-connecting-ip",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
};

interface MockOptions {
  method?: string;
  status?: number;
  body?: unknown;
  // Called with the intercepted request's parsed JSON body, if any.
  onRequest?: (payload: unknown) => void;
}

// Replaces one API endpoint with a canned response for this page only —
// used for things that can't run hermetically (Yahoo Finance quotes) or that
// are hard to trigger for real (a 502, a server-side validation failure).
export async function mockApi(page: Page, path: string, opts: MockOptions = {}): Promise<void> {
  await page.route(`${API_URL}${path}`, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    if (opts.method && request.method() !== opts.method) {
      await route.fallback();
      return;
    }
    opts.onRequest?.(request.postDataJSON());
    await route.fulfill({
      status: opts.status ?? 200,
      headers: { ...CORS_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(opts.body ?? {}),
    });
  });
}

export interface MockQuote {
  price: number | null;
  change: number | null;
  changePercent: number | null;
  history: number[];
  error?: string;
}

export function mockTicker(id: number, symbol: string, quote: MockQuote) {
  return { id, symbol, quote: { currency: "USD", ...quote } };
}
