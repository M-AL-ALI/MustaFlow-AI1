/**
 * Agent Senses Pack (Task #529)
 *
 * Implements five "vision" tools the agent loop can invoke during a build/refine:
 *   - take_screenshot     — capture a PNG of the project's live preview or any URL
 *   - web_fetch           — fetch a URL, return cleaned text/markdown
 *   - web_search          — query Brave Search API (env-gated; graceful no-op)
 *   - extract_branding    — parse a site's meta tags for colors / fonts / logo
 *   - read_diagnostics    — run tsc/pyright/node --check on a path inside the
 *                           project's container and return structured diagnostics
 *
 * All functions are pure, side-effect-light (HTTP only), and never throw —
 * they always return a structured result so the loop can feed it back to the
 * model as an observation. Credit accounting is handled by the caller.
 */

import { Parser } from "htmlparser2";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { logger } from "./logger";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_BYTES = 1_000_000; // 1MB cap on web_fetch response
const MAX_TEXT_CHARS = 6_000;
const USER_AGENT = "MustaFlowAgent/1.0 (+https://mustaflow.app)";

// ─────────────────────────────────────────────────────────────────────────────
// Shared HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

async function httpGet(
  url: string,
  signal: AbortSignal,
  opts?: { acceptHtml?: boolean },
): Promise<{ ok: boolean; status: number; contentType: string; body: string; error?: string }> {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), FETCH_TIMEOUT_MS);
  const compound = mergeSignals(signal, timeoutCtrl.signal);
  try {
    const fetched = await safeFetch(url, {
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: opts?.acceptHtml ? "text/html,application/xhtml+xml" : "*/*",
      },
      signal: compound,
    });
    if ("error" in fetched) {
      return { ok: false, status: 0, contentType: "", body: "", error: fetched.error };
    }
    const { res } = fetched;
    const contentType = res.headers.get("content-type") ?? "";
    const reader = res.body?.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FETCH_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          break;
        }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return { ok: res.ok, status: res.status, contentType, body };
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    return { ok: false, status: 0, contentType: "", body: "", error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return ctrl.signal;
}

function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Reject hostnames that resolve to private/internal address ranges to prevent
 * SSRF (cloud metadata, RFC1918, loopback, link-local). Hostname-only check —
 * does not perform DNS lookup; defends against the obvious literal cases plus
 * common bypasses (0.0.0.0, [::], localhost). For deeper protection a DNS
 * resolve + IP-range check would be required.
 */
const PRIVATE_HOST_RE =
  /^(?:localhost|0(?:\.0){0,3}|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|172\.(?:1[6-9]|2\d|3[01])\.[\d.]+|169\.254\.[\d.]+|fc[\da-f]{2}:.*|fd[\da-f]{2}:.*|::1?|fe80:.*|metadata\.google\.internal|169\.254\.169\.254)$/i;

export function isSafePublicUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host) return false;
    if (PRIVATE_HOST_RE.test(host)) return false;
    if (host.endsWith(".local") || host.endsWith(".internal")) return false;
    return true;
  } catch {
    return false;
  }
}

/** IPv4 private/loopback/link-local/metadata + IPv6 loopback/ULA/link-local. */
function isPrivateIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (fam === 6) {
    const lc = ip.toLowerCase();
    if (lc === "::" || lc === "::1") return true;
    if (lc.startsWith("fc") || lc.startsWith("fd")) return true; // ULA
    if (lc.startsWith("fe80:")) return true; // link-local
    if (lc.startsWith("::ffff:")) {
      const v4 = lc.slice(7);
      if (isIP(v4) === 4) return isPrivateIp(v4);
    }
    return false;
  }
  return false;
}

/**
 * Resolve the URL's hostname (skipping lookup if it's already an IP literal),
 * then reject if any resolved address points to a private/internal range.
 * Combined with isSafePublicUrl, this defends against DNS rebinding + literal
 * private-IP hostnames.
 */
export async function isSafeResolvedUrl(u: string): Promise<boolean> {
  if (!isSafePublicUrl(u)) return false;
  try {
    const host = new URL(u).hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return !isPrivateIp(host);
    const addrs = await dns.lookup(host, { all: true, verbatim: true });
    if (addrs.length === 0) return false;
    return addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

/**
 * Fetch with manual redirect handling. Each hop's resolved address is checked
 * against the private-IP block-list so a public host cannot redirect to a
 * private/internal target (SSRF defense).
 */
const MAX_REDIRECTS = 5;
async function safeFetch(
  initialUrl: string,
  init: RequestInit & { signal: AbortSignal },
): Promise<{ res: Response; finalUrl: string } | { error: string }> {
  let url = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isSafeResolvedUrl(url))) {
      return {
        error: `URL ${hop === 0 ? "" : "(after redirect) "}points to a private/internal host`,
      };
    }
    let res: Response;
    try {
      res = await fetch(url, { ...init, redirect: "manual" });
    } catch (err) {
      return { error: String((err as Error).message ?? err) };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { res, finalUrl: url };
      try {
        url = new URL(loc, url).toString();
      } catch {
        return { error: "invalid redirect location" };
      }
      continue;
    }
    return { res, finalUrl: url };
  }
  return { error: "too many redirects" };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML → plain text (small, dependency-light using htmlparser2)
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_TAGS = new Set(["script", "style", "noscript", "iframe", "svg"]);
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "main",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
  "tr",
  "pre",
]);

export function htmlToText(html: string): { title: string; text: string } {
  let title = "";
  let inTitle = false;
  const skipStack: string[] = [];
  const parts: string[] = [];
  const parser = new Parser(
    {
      onopentag(name) {
        const tag = name.toLowerCase();
        if (tag === "title") inTitle = true;
        if (SKIP_TAGS.has(tag)) skipStack.push(tag);
        if (BLOCK_TAGS.has(tag)) parts.push("\n");
      },
      ontext(text) {
        if (skipStack.length > 0) return;
        if (inTitle) {
          title += text;
          return;
        }
        const t = text.replace(/\s+/g, " ");
        if (t.trim()) parts.push(t);
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (tag === "title") inTitle = false;
        if (SKIP_TAGS.has(tag)) skipStack.pop();
        if (BLOCK_TAGS.has(tag)) parts.push("\n");
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();
  const text = parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return { title: title.trim().slice(0, 200), text: text.slice(0, MAX_TEXT_CHARS) };
}

// ─────────────────────────────────────────────────────────────────────────────
// take_screenshot
// ─────────────────────────────────────────────────────────────────────────────

export interface ScreenshotInput {
  /** URL to capture. Use the project preview URL when capturing the user's own app. */
  url: string;
  /** Viewport width in px (default 1280, max 1920). */
  width?: number;
  /** Viewport height in px (default 800, max 1200). */
  height?: number;
  /** Capture the full scrollable page (default false). */
  fullPage?: boolean;
  signal: AbortSignal;
  /** Optional inline HTML to render instead of fetching the URL (static-html). */
  inlineHtml?: string;
}

export interface ScreenshotResult {
  ok: boolean;
  /** Base64-encoded PNG. */
  base64?: string;
  /** Byte count of the decoded PNG (useful for budget tracking). */
  bytes?: number;
  width?: number;
  height?: number;
  error?: string;
}

const CHROMIUM_PATHS = [
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  "/nix/store/chromium",
  "/nix/var/nix/profiles/default/bin/chromium",
  "/run/current-system/sw/bin/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
].filter(Boolean) as string[];

export async function takeScreenshot(input: ScreenshotInput): Promise<ScreenshotResult> {
  if (!input.inlineHtml) {
    if (!isHttpUrl(input.url)) return { ok: false, error: "URL must be http(s)" };
    if (!(await isSafeResolvedUrl(input.url)))
      return { ok: false, error: "URL points to a private/internal host" };
  }
  const w = Math.min(Math.max(input.width ?? 1280, 320), 1920);
  const h = Math.min(Math.max(input.height ?? 800, 240), 1200);

  let chromium: typeof import("playwright").chromium;
  try {
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch (err) {
    return { ok: false, error: `playwright unavailable: ${String((err as Error).message ?? err)}` };
  }

  let browser: import("playwright").Browser | null = null;
  try {
    // Try bundled browser first; fall back to system chromium paths.
    let launched = false;
    for (const exePath of [undefined, ...CHROMIUM_PATHS]) {
      try {
        browser = await chromium.launch({
          headless: true,
          executablePath: exePath,
          args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        });
        launched = true;
        break;
      } catch (err) {
        logger.debug({ err, exePath }, "agent-senses: chromium launch attempt failed");
      }
    }
    if (!launched || !browser) {
      return { ok: false, error: "no chromium binary available" };
    }
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      // Block JS in inline-HTML snapshots: the model controls the HTML and
      // could otherwise issue fetch/XHR to internal IPs from within the
      // browser process (SSRF). For external URL captures we keep JS enabled
      // since per-request interception (below) enforces the same allow-list.
      javaScriptEnabled: !input.inlineHtml,
    });
    // SSRF guard: intercept every subresource/redirect the page tries to load
    // (images, fonts, fetch, redirects, iframes, etc.) and abort any request
    // whose resolved address is private/internal. Applies to BOTH inline HTML
    // and URL-based captures so neither path can pivot through the browser
    // process to a metadata/loopback target.
    const page = await ctx.newPage();
    await page.route("**/*", async (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.startsWith("data:") || reqUrl.startsWith("about:")) {
        return route.continue();
      }
      if (!(await isSafeResolvedUrl(reqUrl))) {
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    if (input.inlineHtml) {
      await page.setContent(input.inlineHtml, { waitUntil: "load", timeout: 15_000 });
    } else {
      await page.goto(input.url, { waitUntil: "load", timeout: 20_000 });
    }
    // Settle a moment for CSS/fonts
    await page.waitForTimeout(300);
    const buf = await page.screenshot({ type: "png", fullPage: !!input.fullPage });
    const base64 = Buffer.from(buf).toString("base64");
    return { ok: true, base64, bytes: buf.length, width: w, height: h };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// web_fetch
// ─────────────────────────────────────────────────────────────────────────────

export interface WebFetchInput {
  url: string;
  signal: AbortSignal;
}

export interface WebFetchResult {
  ok: boolean;
  status: number;
  contentType: string;
  title?: string;
  text?: string;
  url: string;
  error?: string;
}

export async function webFetch(input: WebFetchInput): Promise<WebFetchResult> {
  if (!isHttpUrl(input.url)) {
    return { ok: false, status: 0, contentType: "", url: input.url, error: "URL must be http(s)" };
  }
  if (!isSafePublicUrl(input.url)) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      url: input.url,
      error: "URL points to a private/internal host",
    };
  }
  const res = await httpGet(input.url, input.signal, { acceptHtml: true });
  if (!res.ok && res.status === 0) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      url: input.url,
      error: res.error ?? "request failed",
    };
  }
  const isHtml =
    res.contentType.includes("text/html") || /<html[\s>]/i.test(res.body.slice(0, 400));
  if (isHtml) {
    const { title, text } = htmlToText(res.body);
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.contentType,
      title,
      text,
      url: input.url,
    };
  }
  // Treat as plain text (JSON, XML, .txt, etc.)
  return {
    ok: res.ok,
    status: res.status,
    contentType: res.contentType,
    text: res.body.slice(0, MAX_TEXT_CHARS),
    url: input.url,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// web_search (Brave Search API)
// ─────────────────────────────────────────────────────────────────────────────

export interface WebSearchInput {
  query: string;
  limit?: number;
  signal: AbortSignal;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  ok: boolean;
  hits: WebSearchHit[];
  provider: string;
  error?: string;
}

export async function webSearch(input: WebSearchInput): Promise<WebSearchResult> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY ?? "";
  const query = input.query.trim();
  if (!query) {
    return { ok: false, hits: [], provider: "none", error: "empty query" };
  }
  if (!apiKey) {
    return {
      ok: false,
      hits: [],
      provider: "none",
      error:
        "web search not configured (set BRAVE_SEARCH_API_KEY). Fall back to fetching known URLs with web_fetch.",
    };
  }
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
        "User-Agent": USER_AGENT,
      },
      signal: mergeSignals(input.signal, timeoutCtrl.signal),
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        hits: [],
        provider: "brave",
        error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const hits: WebSearchHit[] = (data.web?.results ?? []).slice(0, limit).map((r) => ({
      title: (r.title ?? "").slice(0, 200),
      url: r.url ?? "",
      snippet: (r.description ?? "").replace(/<[^>]+>/g, "").slice(0, 280),
    }));
    return { ok: true, hits, provider: "brave" };
  } catch (err) {
    return {
      ok: false,
      hits: [],
      provider: "brave",
      error: String((err as Error).message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// extract_branding
// ─────────────────────────────────────────────────────────────────────────────

export interface BrandingInput {
  url: string;
  signal: AbortSignal;
}

export interface BrandingResult {
  ok: boolean;
  url: string;
  title?: string;
  description?: string;
  themeColor?: string;
  ogImage?: string;
  favicons: string[];
  fonts: string[];
  colors: string[];
  error?: string;
}

const COLOR_RE = /#(?:[0-9a-fA-F]{3}){1,2}\b|rgba?\([^)]+\)|hsla?\([^)]+\)/g;

export async function extractBranding(input: BrandingInput): Promise<BrandingResult> {
  if (!isHttpUrl(input.url)) {
    return {
      ok: false,
      url: input.url,
      favicons: [],
      fonts: [],
      colors: [],
      error: "URL must be http(s)",
    };
  }
  if (!isSafePublicUrl(input.url)) {
    return {
      ok: false,
      url: input.url,
      favicons: [],
      fonts: [],
      colors: [],
      error: "URL points to a private/internal host",
    };
  }
  const res = await httpGet(input.url, input.signal, { acceptHtml: true });
  if (!res.ok && res.status === 0) {
    return {
      ok: false,
      url: input.url,
      favicons: [],
      fonts: [],
      colors: [],
      error: res.error ?? "request failed",
    };
  }

  const base = (() => {
    try {
      return new URL(input.url);
    } catch {
      return null;
    }
  })();
  const resolve = (href: string) => {
    if (!href) return "";
    try {
      return base ? new URL(href, base).toString() : href;
    } catch {
      return href;
    }
  };

  let title = "";
  let description = "";
  let themeColor = "";
  let ogImage = "";
  const favicons = new Set<string>();
  const fonts = new Set<string>();
  const colorCounts = new Map<string, number>();

  let inStyle = false;
  let inTitle = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const tag = name.toLowerCase();
        if (tag === "title") inTitle = true;
        if (tag === "style") inStyle = true;
        if (tag === "meta") {
          const nm = (attrs.name ?? "").toLowerCase();
          const prop = (attrs.property ?? "").toLowerCase();
          const content = attrs.content ?? "";
          if (nm === "description" && !description) description = content.slice(0, 300);
          if (nm === "theme-color" && !themeColor) themeColor = content.trim();
          if (prop === "og:image" && !ogImage) ogImage = resolve(content);
          if (prop === "og:title" && !title) title = content.slice(0, 200);
          if (prop === "og:description" && !description) description = content.slice(0, 300);
        }
        if (tag === "link") {
          const rel = (attrs.rel ?? "").toLowerCase();
          const href = attrs.href ?? "";
          if (rel.includes("icon") && href) favicons.add(resolve(href));
          if (rel === "stylesheet" && href.includes("fonts.googleapis.com")) {
            const m = href.match(/family=([^&:]+)/g) ?? [];
            for (const fam of m) {
              fonts.add(decodeURIComponent(fam.replace(/^family=/, "").replace(/\+/g, " ")));
            }
          }
        }
      },
      ontext(text) {
        if (inTitle && !title) title += text;
        if (inStyle) {
          const matches = text.match(COLOR_RE);
          if (matches) {
            for (const c of matches) {
              const key = c.toLowerCase();
              colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
            }
          }
          // Crude font-family extraction
          const ffMatches = text.match(/font-family\s*:\s*([^;}\n]+)/gi) ?? [];
          for (const ff of ffMatches) {
            const value = ff.replace(/^font-family\s*:\s*/i, "");
            for (const name of value.split(",")) {
              const cleaned = name.replace(/['"]/g, "").trim();
              if (
                cleaned &&
                !["inherit", "initial", "unset", "sans-serif", "serif", "monospace"].includes(
                  cleaned.toLowerCase(),
                )
              ) {
                fonts.add(cleaned);
              }
            }
          }
        }
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (tag === "title") inTitle = false;
        if (tag === "style") inStyle = false;
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(res.body);
  parser.end();

  // Default favicon fallback
  if (favicons.size === 0 && base) favicons.add(`${base.origin}/favicon.ico`);

  const colors = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([c]) => c);

  return {
    ok: true,
    url: input.url,
    title: title.trim().slice(0, 200) || undefined,
    description: description || undefined,
    themeColor: themeColor || undefined,
    ogImage: ogImage || undefined,
    favicons: [...favicons].slice(0, 5),
    fonts: [...fonts].slice(0, 10),
    colors,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// read_diagnostics  (container-side type/syntax probe)
// ─────────────────────────────────────────────────────────────────────────────

export interface DiagnosticsInput {
  /**
   * Project file path or glob inside the container (e.g. "src/App.tsx",
   * "src/**\/*.ts"). Required. Globs are passed to the underlying tool as-is
   * and expanded by the shell — they must consist only of safe path chars.
   */
  path: string;
  /** Tool to run. Auto-detected from extension if absent. */
  tool?: "tsc" | "node" | "python" | "eslint" | "auto";
}

export interface Diagnostic {
  file: string;
  line: number | null;
  col: number | null;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface DiagnosticsResult {
  ok: boolean;
  tool: string;
  path: string;
  diagnostics: Diagnostic[];
  raw: string;
  error?: string;
}

/** Parse `tsc --noEmit` style output into structured diagnostics. */
function parseTscOutput(raw: string, filterPath: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const isGlob = /[*?\[]/.test(filterPath);
  for (const line of raw.split(/\r?\n/)) {
    // file.ts(12,5): error TS2304: Cannot find name 'foo'.
    const m = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+([A-Z]+\d+)?:?\s*(.*)$/);
    if (!m) continue;
    const [, file, lineNo, col, sev, code, msg] = m;
    if (filterPath && !isGlob && !file.includes(filterPath)) continue;
    out.push({
      file,
      line: Number(lineNo) || null,
      col: Number(col) || null,
      severity: sev as Diagnostic["severity"],
      message: (code ? `${code}: ${msg}` : msg).slice(0, 280),
    });
  }
  return out.slice(0, 50);
}

/** Parse `python -m py_compile` / SyntaxError output. */
function parsePythonOutput(raw: string, path: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  // "  File "x.py", line 12"   …   "SyntaxError: invalid syntax"
  const fileMatch = raw.match(/File\s+"([^"]+)",\s+line\s+(\d+)/);
  const errMatch = raw.match(/(SyntaxError|IndentationError|NameError|TypeError):\s+(.*)/);
  if (fileMatch || errMatch) {
    out.push({
      file: fileMatch?.[1] ?? path,
      line: fileMatch ? Number(fileMatch[2]) : null,
      col: null,
      severity: "error",
      message: errMatch ? `${errMatch[1]}: ${errMatch[2]}`.slice(0, 280) : raw.slice(0, 280),
    });
  }
  return out;
}

/** Parse `node --check` syntax error output. */
function parseNodeOutput(raw: string, path: string): Diagnostic[] {
  const m = raw.match(/^(.+?):(\d+)\s*\n[\s\S]*?SyntaxError:\s*(.+)$/m);
  if (!m) return [];
  return [
    {
      file: m[1] ?? path,
      line: Number(m[2]) || null,
      col: null,
      severity: "error",
      message: `SyntaxError: ${m[3]}`.slice(0, 280),
    },
  ];
}

export async function readDiagnostics(input: {
  args: DiagnosticsInput;
  containerId: string | null;
  projectId: number;
  signal: AbortSignal;
}): Promise<DiagnosticsResult> {
  const { args, containerId, projectId, signal } = input;
  if (!args.path) {
    return {
      ok: false,
      tool: "unknown",
      path: "",
      diagnostics: [],
      raw: "",
      error: "path required",
    };
  }
  if (!containerId) {
    return {
      ok: false,
      tool: "unknown",
      path: args.path,
      diagnostics: [],
      raw: "",
      error: "no container available — start the project container first",
    };
  }

  // Sanitize path: reject absolute paths, traversal, control chars, or shell
  // metacharacters. Glob chars (* ? [ ]) are explicitly allowed so callers can
  // pass patterns like "src/**/*.ts".
  if (
    args.path.length > 512 ||
    args.path.startsWith("/") ||
    args.path.includes("..") ||
    /[\u0000-\u001f\u007f'"`$\\;&|<>(){}\n\r ]/.test(args.path)
  ) {
    return {
      ok: false,
      tool: "unknown",
      path: args.path,
      diagnostics: [],
      raw: "",
      error:
        "invalid path: must be a relative project path (globs allowed) with no shell metacharacters",
    };
  }
  const isGlob = /[*?\[]/.test(args.path);
  const ext = isGlob ? "" : (args.path.split(".").pop()?.toLowerCase() ?? "");
  const auto =
    args.tool && args.tool !== "auto" ? args.tool : isGlob ? "tsc" : detectToolFromExt(ext);

  const quotedPath = shellQuote(args.path);
  let argv: string[];
  if (auto === "tsc") {
    // For a single file, filter tsc output by literal path match. For a glob,
    // there's no usable literal substring, so return the full tsc output and
    // let the model match by file extension/directory in its reasoning.
    argv = isGlob
      ? ["sh", "-lc", `npx --yes tsc --noEmit --pretty false 2>&1 | head -n 50`]
      : [
          "sh",
          "-lc",
          `npx --yes tsc --noEmit --pretty false 2>&1 | grep -F ${quotedPath} | head -n 50`,
        ];
  } else if (auto === "node") {
    argv = ["sh", "-lc", `node --check ${quotedPath} 2>&1`];
  } else if (auto === "python") {
    argv = ["sh", "-lc", `python -m py_compile ${quotedPath} 2>&1`];
  } else if (auto === "eslint") {
    argv = [
      "sh",
      "-lc",
      `npx --yes eslint --no-color --format compact ${quotedPath} 2>&1 | head -n 200`,
    ];
  } else {
    return {
      ok: false,
      tool: "unknown",
      path: args.path,
      diagnostics: [],
      raw: "",
      error: `no diagnostic tool for extension ".${ext}"`,
    };
  }

  let execOut: { ok: boolean; output: string };
  try {
    const { execInContainer } = await import("./container");
    if (signal.aborted) {
      return { ok: false, tool: auto, path: args.path, diagnostics: [], raw: "", error: "aborted" };
    }
    execOut = await execInContainer(containerId, argv, projectId);
  } catch (err) {
    return {
      ok: false,
      tool: auto,
      path: args.path,
      diagnostics: [],
      raw: "",
      error: String((err as Error).message ?? err),
    };
  }

  const raw = execOut.output.slice(0, 4000);
  let diagnostics: Diagnostic[] = [];
  if (auto === "tsc") diagnostics = parseTscOutput(raw, args.path);
  else if (auto === "python") diagnostics = parsePythonOutput(raw, args.path);
  else if (auto === "node") diagnostics = parseNodeOutput(raw, args.path);
  else if (auto === "eslint") diagnostics = parseEslintOutput(raw);

  return {
    ok: true,
    tool: auto,
    path: args.path,
    diagnostics,
    raw: diagnostics.length === 0 ? raw.slice(0, 400) : "",
  };
}

function detectToolFromExt(ext: string): "tsc" | "node" | "python" | "unknown" {
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "tsc";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "node";
  if (["py", "pyi"].includes(ext)) return "python";
  return "unknown";
}

/**
 * Parse `eslint --format compact` output:
 *   /abs/path/file.ts: line 12, col 5, Error - Unexpected console (no-console)
 */
function parseEslintOutput(raw: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(
      /^(.+?):\s+line\s+(\d+),\s+col\s+(\d+),\s+(Error|Warning|Info)\s+-\s+(.*)$/,
    );
    if (!m) continue;
    const [, file, lineNo, col, sev, msg] = m;
    const severity: Diagnostic["severity"] =
      sev === "Error" ? "error" : sev === "Warning" ? "warning" : "info";
    out.push({
      file,
      line: Number(lineNo) || null,
      col: Number(col) || null,
      severity,
      message: msg.slice(0, 280),
    });
  }
  return out.slice(0, 50);
}

function shellQuote(s: string): string {
  if (!/[^a-zA-Z0-9_./\-]/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
