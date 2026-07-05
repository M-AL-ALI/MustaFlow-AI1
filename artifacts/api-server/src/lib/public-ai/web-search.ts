/**
 * Ora web search tool (Task #1276).
 *
 * A STANDALONE, isolated web search/browse capability for Ora. It lets Ora
 * answer questions that need current information by running a live web search
 * and grounding the answer in fetched results with cited sources.
 *
 * ISOLATION: like every other public-ai module, this must NOT import from
 * builder.ts, ai.ts, jobs.ts, agent-* pipeline modules, or any builder code. It
 * talks directly to OpenAI's Responses API `web_search` tool using the direct
 * `OPENAI_API_KEY` (the AI-integrations proxy does not reliably execute the
 * web_search tool). When no key is configured the tool degrades gracefully.
 *
 * Scope: per-query fetches only — no crawling, no indexing, no persistence.
 */
import OpenAI, { APIConnectionTimeoutError } from "openai";
import { logger } from "../logger";
import { normalizeOraPlanTier, openAiModelForOraSearch, type OraPlanTier } from "./model-router";
import { isSportsScheduleRequest } from "./orchestrator";

export interface OraSource {
  title: string;
  url: string;
  /** ISO date string if the source's publication date was found in the annotation, else undefined. */
  date?: string;
}

/** A real image found on the web during search, shown inline in the chat. */
export interface OraImage {
  url: string;
  title?: string;
  /** The page the image was found on, so the user can verify the context. */
  source?: string;
}

/** A relevant video found on the web during search, shown as a link card. */
export interface OraVideo {
  url: string;
  title?: string;
  /** Optional thumbnail (derived for YouTube) so the card has a preview. */
  thumbnailUrl?: string;
}

export interface OraWebSearchInput {
  query: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  language?: string;
  /**
   * Optional pre-formatted personalization block (the signed-in user's Ora
   * profile and/or saved memories). Injected into the search instructions so a
   * web-search answer stays personalized — e.g. tailoring "places near me" to a
   * remembered city — without the model fabricating personal facts.
   */
  personalContext?: string;
  /**
   * True when the user specifically asked Ora to FIND a video. The model is then
   * explicitly instructed to populate the `videos` array in the trailing
   * ora-media block (rendered as clickable video cards) instead of dropping a
   * raw watch URL into the prose.
   */
  wantsVideos?: boolean;
  /** Signed-in user's effective Ora plan tier; anonymous callers may omit it. */
  subscriptionTier?: string | null;
  /**
   * Optional pre-formatted context from files the user uploaded earlier in
   * this conversation. Injected separately from personalContext so the web
   * search can use file content to sharpen or ground the query (e.g. "find
   * datasets similar to this one" when the schema lives in the uploaded file).
   * Treated as data, not user-identity context.
   */
  documentContext?: string;
  /**
   * True for a user-initiated "Retry live search". A forced retry must try
   * HARDER than the normal degrade-fast path: it uses a longer first-attempt
   * timeout, runs a lighter secondary attempt even after a genuine timeout, and
   * drops the model to low reasoning effort (the default medium effort on gpt-5
   * is the dominant cause of these search timeouts). The route turns a forced
   * failure into a retryable 503 instead of repeating the general-knowledge
   * answer the user just rejected.
   */
  forceLive?: boolean;
}

export interface OraWebSearchResult {
  reply: string;
  sources: OraSource[];
  images: OraImage[];
  videos: OraVideo[];
}

export type OraSearchDepth = "quick" | "standard" | "research";
export type OraSearchFreshness = "current" | "evergreen";
export type OraSearchSourceStrategy = "official" | "primary" | "balanced";
export type OraSearchMediaIntent = "none" | "image" | "video";

export interface OraSearchPlan {
  researchIntent: boolean;
  freshness: OraSearchFreshness;
  sourceStrategy: OraSearchSourceStrategy;
  mediaIntent: OraSearchMediaIntent;
  instruction: string;
}

export interface OraSearchProfile {
  depth: OraSearchDepth;
  maxOutputTokens: number;
  sourceLimit: number;
  imageLimit: number;
  videoLimit: number;
  searchPlan: OraSearchPlan;
  instruction: string;
}

/** Whether a live web search backend is available in this environment. */
export function isWebSearchConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

let cachedClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return cachedClient;
}

/**
 * Per-request timeout caps for the live web-search provider call. The OpenAI SDK
 * default request timeout is ~10 minutes, which would let a slow or stuck
 * web_search call hang this (non-streaming) search request indefinitely. The
 * `web_search` tool does real web fetching plus reasoning, so it legitimately
 * needs several seconds — the previous 5000 ms cap was so aggressive that live
 * search timed out and degraded to a general-knowledge answer far too often.
 *
 * The first attempt now gets a generous cap. A single retry is allowed ONLY for
 * fast-failing transient errors (connection resets, 5xx, etc.); a genuine
 * timeout is NOT retried, because a call that could not finish within
 * ORA_SEARCH_TIMEOUT_MS almost never finishes in the shorter retry window and
 * would only add latency before the route degrades. Worst case for the timeout
 * path ≈ 12000 ms; worst case for a transient-error path ≈ 12000 + 250 + 8000 =
 * 20250 ms before the route degrades to a general-knowledge answer.
 */
export const ORA_SEARCH_TIMEOUT_MS = 12_000;
export const ORA_SEARCH_RETRY_TIMEOUT_MS = 8_000;
export const ORA_SEARCH_RETRY_BACKOFF_MS = 250;

/**
 * Forced-retry ("Retry live search") caps. A user who taps Retry has explicitly
 * asked us to try harder, so the first attempt gets a much longer window, and a
 * lighter second attempt runs EVEN AFTER a genuine timeout (the normal path
 * skips that). Worst case ≈ 26000 + 250 + 12000 = 38250 ms before the route
 * returns a retryable 503 — well under the autoscale gateway's minutes-scale
 * request cap, and the clients impose no shorter timeout.
 */
export const ORA_SEARCH_FORCE_TIMEOUT_MS = 26_000;
export const ORA_SEARCH_FORCE_RETRY_TIMEOUT_MS = 12_000;

/** How a live-search attempt failed, for structured logging + triage. */
export type OraWebSearchFailureReason = "timeout" | "connection" | "http_status" | "error";

/**
 * Thrown when the live web-search provider call fails or times out on every
 * attempt, so the route can distinguish a provider failure (degrade to a
 * general-knowledge answer) from an empty answer. Carries structured metadata so
 * the route can emit one triage log (attempt count, latency, why it failed)
 * without re-deriving it.
 */
export class OraWebSearchError extends Error {
  readonly attemptCount: number;
  readonly failureReason: OraWebSearchFailureReason;
  readonly latencyMs: number;
  readonly searchProvider: string;
  constructor(
    message: string,
    options?: {
      cause?: unknown;
      attemptCount?: number;
      failureReason?: OraWebSearchFailureReason;
      latencyMs?: number;
      searchProvider?: string;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OraWebSearchError";
    this.attemptCount = options?.attemptCount ?? 0;
    this.failureReason = options?.failureReason ?? "error";
    this.latencyMs = options?.latencyMs ?? 0;
    this.searchProvider = options?.searchProvider ?? "openai-web-search";
  }
}

/** Classify a provider error into a coarse, log-friendly failure reason. */
function classifyWebSearchFailure(err: unknown): OraWebSearchFailureReason {
  if (err instanceof APIConnectionTimeoutError) return "timeout";
  const e = err as { name?: unknown; status?: unknown };
  if (typeof e?.status === "number") return "http_status";
  if (typeof e?.name === "string" && /connection/i.test(e.name)) return "connection";
  return "error";
}

/**
 * Run the Responses API call with a hard per-attempt timeout and at most one
 * capped retry, never falling back to the SDK's ~10-minute default. The retry is
 * skipped when the first failure is a genuine request timeout (retrying a call
 * that could not finish in the longer first window only adds latency before we
 * degrade); it is only used for fast-failing transient errors. Throws
 * OraWebSearchError once every attempt has been exhausted.
 */
/** One ordered attempt: its own request params and its own timeout cap. */
interface SearchAttempt {
  params: object;
  timeoutMs: number;
}

interface SearchResponsePayload {
  output_text?: string;
  output?: unknown;
}

interface SearchResponseResult {
  response: SearchResponsePayload;
  attemptCount: number;
  latencyMs: number;
}

async function createSearchResponse(
  client: OpenAI,
  attempts: SearchAttempt[],
  retryOnTimeout: boolean,
): Promise<SearchResponseResult> {
  const start = Date.now();
  let lastErr: unknown;
  let attemptCount = 0;
  for (let i = 0; i < attempts.length; i++) {
    attemptCount++;
    try {
      const response = (await client.responses.create(attempts[i].params as never, {
        timeout: attempts[i].timeoutMs,
        maxRetries: 0,
      })) as SearchResponsePayload;
      return { response, attemptCount, latencyMs: Date.now() - start };
    } catch (err) {
      lastErr = err;
      // Normal (degrade-fast) path: a real timeout is not worth retrying — the
      // shorter retry window would almost certainly time out again and only add
      // latency before the route degrades. A forced "Retry live search" flips
      // retryOnTimeout ON: the next attempt is a lighter, low-effort call that
      // can realistically finish where the heavy first attempt stalled.
      if (err instanceof APIConnectionTimeoutError && !retryOnTimeout) break;
      if (i < attempts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, ORA_SEARCH_RETRY_BACKOFF_MS));
      }
    }
  }
  throw new OraWebSearchError("Live web search request failed or timed out.", {
    cause: lastErr,
    attemptCount,
    failureReason: classifyWebSearchFailure(lastErr),
    latencyMs: Date.now() - start,
  });
}

/**
 * Reject hostnames that point at the local machine or a private/internal
 * network (loopback, RFC1918, link-local, unique-local IPv6, and cloud
 * metadata IPs). The media URLs Ora surfaces are auto-fetched by the browser
 * (`<img src>`), so a hallucinated or poisoned internal URL must never be
 * rendered or persisted — it would turn a chat reply into an SSRF-style probe
 * of the viewer's own network.
 */
export function isPrivateOrLocalHost(hostname: string): boolean {
  // Normalize: lowercase, strip IPv6 brackets, and drop the FQDN trailing
  // dot(s) (`localhost.` resolves to localhost) so suffix/equality checks hold.
  let host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  // Unwrap IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) to its embedded v4 literal.
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) host = mapped[1];
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10).
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return true;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true; // loopback / private / unspecified
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
  }
  return false;
}

/**
 * Returns true only for http(s) URLs that point at a public host. Non-http(s)
 * schemes (javascript:, data:, file:, mailto:, etc.) and private/local network
 * targets are rejected so a poisoned/malformed citation or media URL can never
 * become a clickable link or an auto-fetched internal request in the UI.
 */
export function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return !isPrivateOrLocalHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Strip tracking query params (utm_*, the `?utm_source=openai` the web_search
 * tool appends, fbclid, gclid, etc.) so cited links are clean. Returns null for
 * any non-http(s) URL so dangerous schemes are dropped at extraction time.
 */
export function cleanSourceUrl(raw: string): string | null {
  if (!isSafeHttpUrl(raw)) return null;
  try {
    const u = new URL(raw);
    const drop: string[] = [];
    u.searchParams.forEach((_v, k) => {
      if (/^utm_/i.test(k) || k === "fbclid" || k === "gclid" || k === "ref") drop.push(k);
    });
    for (const k of drop) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

/** Best-effort hostname for a URL, used as a title fallback. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Pull URL citations out of a Responses-API output payload. Accepts the loose
 * `unknown` shape so it is trivially unit-testable with plain objects and never
 * throws on an unexpected structure.
 */
export function extractSources(output: unknown): OraSource[] {
  const sources: OraSource[] = [];
  if (!Array.isArray(output)) return sources;
  for (const item of output as Array<Record<string, unknown>>) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      const annotations = block?.annotations;
      if (!Array.isArray(annotations)) continue;
      for (const ann of annotations as Array<Record<string, unknown>>) {
        const url = typeof ann?.url === "string" ? ann.url : null;
        if (!url) continue;
        const cleaned = cleanSourceUrl(url);
        if (!cleaned) continue; // drop non-http(s) / malformed citations
        const title = typeof ann?.title === "string" && ann.title.trim() ? ann.title.trim() : null;
        // Try to extract a publication date from the annotation payload. The
        // Responses API does not guarantee a date field, so we probe several
        // plausible key names and fall back to undefined when none are found.
        const rawDate =
          (ann?.date as string | undefined) ??
          (ann?.published_at as string | undefined) ??
          (ann?.publishedDate as string | undefined) ??
          undefined;
        const date = typeof rawDate === "string" && rawDate.trim() ? rawDate.trim() : undefined;
        sources.push({
          title: title ?? hostnameOf(cleaned),
          url: cleaned,
          ...(date ? { date } : {}),
        });
      }
    }
  }
  return sources;
}

/** Dedupe sources by normalized URL, then prefer stronger source-quality signals. */
export function dedupeSources(sources: OraSource[], limit = 6): OraSource[] {
  const seen = new Set<string>();
  const out: Array<{ source: OraSource; index: number }> = [];
  for (const s of sources) {
    let key: string;
    try {
      const u = new URL(s.url);
      key = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
    } catch {
      key = s.url;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: s, index: out.length });
  }
  return out
    .sort(
      (a, b) => sourceQualityScore(b.source) - sourceQualityScore(a.source) || a.index - b.index,
    )
    .slice(0, limit)
    .map((item) => item.source);
}

const LOW_QUALITY_SOURCE_HOSTS = [
  "pinterest.",
  "facebook.",
  "instagram.",
  "tiktok.",
  "x.com",
  "twitter.",
  "quora.",
  "answers.",
  "reddit.",
  "medium.com",
];

const TRUSTED_NEWS_HOSTS = [
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "npr.org",
  "who.int",
  "sec.gov",
];

export function sourceQualityScore(source: OraSource): number {
  let score = 0;
  let host = "";
  let path: string;
  try {
    const u = new URL(source.url);
    host = u.hostname.replace(/^www\./, "").toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    return -10;
  }

  const title = source.title.toLowerCase();
  if (/\.(?:gov|mil)$/.test(host)) score += 8;
  if (/\.(?:edu)$/.test(host)) score += 5;
  if (TRUSTED_NEWS_HOSTS.some((trusted) => host === trusted || host.endsWith(`.${trusted}`))) {
    score += 4;
  }
  if (
    /\b(?:official|primary source|documentation|docs|developer|api reference|manual)\b/.test(title)
  ) {
    score += 5;
  }
  if (/\/(?:docs|documentation|developers?|support|help|manual|api|reference)(?:\/|$)/.test(path)) {
    score += 3;
  }
  if (/\/(?:press|news|releases?|blog)(?:\/|$)/.test(path)) score += 1;
  if (/\b(?:latest|current|today|202[5-9])\b/.test(title) || /\/202[5-9]\//.test(path)) {
    score += 1;
  }
  if (LOW_QUALITY_SOURCE_HOSTS.some((low) => host.includes(low))) score -= 5;
  if (/\/(?:search|tag|tags|category|categories)(?:\/|$)/.test(path)) score -= 2;
  return score;
}

/** Extract a YouTube video id from any common YouTube URL shape. */
export function youtubeId(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return id || null;
    }
    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([^/?#]+)/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

/** Derive a stable thumbnail URL for a YouTube video, else null. */
export function youtubeThumbnail(raw: string): string | null {
  const id = youtubeId(raw);
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const RESEARCH_SEARCH_PATTERNS: RegExp[] = [
  /\b(deep|thorough|comprehensive|detailed|research|investigate|analysis|analyze|analyse)\b/i,
  /\b(compare|versus|vs\.?|alternatives?|best|top|recommend|ranking|ranked|pros\s+and\s+cons)\b/i,
  /\b(review|evaluate|benchmark|market\s+research|competitive\s+analysis|due\s+diligence)\b/i,
  /\b(what\s+should\s+i\s+(?:choose|buy|use|pick)|which\s+(?:one|tool|service|platform|plan))\b/i,
];

const CURRENT_SEARCH_PATTERNS: RegExp[] = [
  /\b(latest|current|today|yesterday|tomorrow|this\s+(?:week|month|year)|now|recent|new|updated)\b/i,
  /\b(news|price|weather|score|schedule|release|version|available|stock|crypto|rate|law|regulation)\b/i,
];

const OFFICIAL_SOURCE_PATTERNS: RegExp[] = [
  /\b(official|primary source|source of truth|government|gov|documentation|docs|api reference)\b/i,
  /\b(homepage|website|site|pricing page|terms|policy|manual|release notes)\b/i,
];

const IMAGE_SEARCH_PATTERNS: RegExp[] = [
  /\b(find|show|search|look up|get)\b.*\b(images?|photos?|pictures?|screenshots?|logos?|icons?)\b/i,
  /\b(official\s+logo|product\s+photo|press\s+image|brand\s+assets?)\b/i,
  /\b(reference\s+(?:images?|photos?|pictures?)|visual\s+references?|image\s+references?|design\s+inspiration)\b/i,
];

export function isResearchSearchQuery(query: string): boolean {
  return RESEARCH_SEARCH_PATTERNS.some((pattern) => pattern.test(query));
}

function matchesAny(patterns: RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function inferOraSearchPlan(input: { query: string; wantsVideos?: boolean }): OraSearchPlan {
  const query = input.query.trim();
  const researchIntent = isResearchSearchQuery(query);
  const freshness: OraSearchFreshness = matchesAny(CURRENT_SEARCH_PATTERNS, query)
    ? "current"
    : "evergreen";
  const sourceStrategy: OraSearchSourceStrategy = matchesAny(OFFICIAL_SOURCE_PATTERNS, query)
    ? "official"
    : researchIntent
      ? "primary"
      : "balanced";
  const mediaIntent: OraSearchMediaIntent = input.wantsVideos
    ? "video"
    : matchesAny(IMAGE_SEARCH_PATTERNS, query)
      ? "image"
      : "none";

  const sportsSchedule = isSportsScheduleRequest(query);

  const steps = [
    researchIntent
      ? "silently decompose the request into targeted searches before answering"
      : "use the most direct targeted search needed to answer",
    freshness === "current"
      ? `treat freshness as important; today's date is ${todayIso()}; for volatile facts cite the source's publication date in your answer; if you cannot confirm a date, say "date not confirmed" rather than omitting it`
      : "do not over-search evergreen background unless the query needs verification",
    sourceStrategy === "official"
      ? "prefer official, primary, or documentation pages over summaries"
      : sourceStrategy === "primary"
        ? "prefer primary sources, reputable analysis, and sources that show their methodology"
        : "prefer reputable sources and avoid low-quality aggregators",
    mediaIntent === "image"
      ? "the user is asking for visual references; return direct image URLs in the media block when found"
      : mediaIntent === "video"
        ? "the user is asking for videos; return verified watch-page URLs in the media block"
        : "include media only when it materially helps the answer",
    sportsSchedule
      ? 'this is a live sports fixtures/scores question: for each match report the teams, the local match time WITH its timezone, the competition, and the source; if you cannot verify scheduled matches for the requested day, reply exactly "I could not verify scheduled matches for today" rather than guessing'
      : null,
  ].filter((step): step is string => step !== null);

  return {
    researchIntent,
    freshness,
    sourceStrategy,
    mediaIntent,
    instruction: `Search plan: ${steps.join("; ")}.`,
  };
}

export function resolveOraSearchProfile(input: {
  query: string;
  planTier: OraPlanTier;
  wantsVideos?: boolean;
}): OraSearchProfile {
  const searchPlan = inferOraSearchPlan({
    query: input.query,
    wantsVideos: input.wantsVideos,
  });
  const researchIntent = searchPlan.researchIntent;

  if (input.planTier === "wave") {
    const depth: OraSearchDepth = researchIntent ? "research" : "standard";
    return {
      depth,
      maxOutputTokens: researchIntent ? 2200 : 1500,
      sourceLimit: researchIntent ? 10 : 8,
      imageLimit: 6,
      videoLimit: input.wantsVideos ? 4 : 3,
      searchPlan,
      instruction:
        depth === "research"
          ? "Search depth: research. Run a deeper research pass across several reputable sources. Compare recency, authority, and disagreements; include exact dates for volatile facts; call out uncertainty instead of flattening it. For recommendations, give a clear ranked answer with tradeoffs and a practical next step."
          : "Search depth: standard. Check multiple reputable sources, prioritize official or primary sources, include important dates, and give a direct answer with enough context for the user to act.",
    };
  }

  if (input.planTier === "core") {
    const depth: OraSearchDepth = researchIntent ? "research" : "standard";
    return {
      depth,
      maxOutputTokens: researchIntent ? 1800 : 1300,
      sourceLimit: researchIntent ? 8 : 6,
      imageLimit: 4,
      videoLimit: input.wantsVideos ? 3 : 2,
      searchPlan,
      instruction:
        depth === "research"
          ? "Search depth: research. Compare several reliable sources, verify recent claims against dates, highlight meaningful disagreements, and end with a concrete recommendation or summary."
          : "Search depth: standard. Use more than one reliable source when the answer is volatile, prefer official sources, and keep the answer direct with the key evidence included.",
    };
  }

  if (researchIntent) {
    return {
      depth: "standard",
      maxOutputTokens: 1200,
      sourceLimit: 5,
      imageLimit: 3,
      videoLimit: input.wantsVideos ? 2 : 1,
      searchPlan,
      instruction:
        "Search depth: standard. Give a useful comparison from reliable sources, but keep it compact. Prioritize the most important evidence, dates, and recommendation.",
    };
  }

  return {
    depth: "quick",
    maxOutputTokens: 900,
    sourceLimit: 4,
    imageLimit: 2,
    videoLimit: input.wantsVideos ? 2 : 1,
    searchPlan,
    instruction:
      "Search depth: quick. Answer directly from the strongest sources, include only the key facts and dates, and avoid unnecessary background.",
  };
}

/**
 * Validate + dedupe model-reported image results. Only http(s) URLs survive;
 * the page each image was found on (`source`) is kept only when it is itself a
 * safe http(s) URL. Capped so the chat never floods with images.
 */
export function sanitizeImages(raw: unknown, limit = 4): OraImage[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: OraImage[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    const url = asString(item?.url);
    if (!url) continue;
    const cleaned = cleanSourceUrl(url);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    const title = asString(item?.title);
    const sourceRaw = asString(item?.source) ?? asString(item?.sourcePage) ?? asString(item?.page);
    const source = sourceRaw ? cleanSourceUrl(sourceRaw) : null;
    out.push({
      url: cleaned,
      ...(title ? { title } : {}),
      ...(source ? { source } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Validate + dedupe model-reported video results. Only http(s) URLs survive; a
 * thumbnail is derived for YouTube links so the card shows a preview.
 */
export function sanitizeVideos(raw: unknown, limit = 3): OraVideo[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: OraVideo[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    const url = asString(item?.url);
    if (!url) continue;
    const cleaned = cleanSourceUrl(url);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    const title = asString(item?.title);
    const thumbFromModel = asString(item?.thumbnailUrl ?? item?.thumbnail);
    const thumb =
      youtubeThumbnail(cleaned) ?? (thumbFromModel ? cleanSourceUrl(thumbFromModel) : null);
    out.push({
      url: cleaned,
      ...(title ? { title } : {}),
      ...(thumb ? { thumbnailUrl: thumb } : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Public oEmbed endpoint for the video providers Ora can positively verify.
 * These are fixed, trusted hosts (youtube.com / vimeo.com), so calling them
 * carries no SSRF risk even though the *input* URL was reported by the model.
 * Returns null for any provider we cannot authoritatively verify.
 */
function videoOembedEndpoint(url: string): string | null {
  const id = youtubeId(url);
  if (id) {
    return `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${id}`,
    )}&format=json`;
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host === "vimeo.com" || host === "player.vimeo.com") {
      return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Confirm a single model-reported video actually exists and is embeddable by
 * querying its provider's oEmbed endpoint. On success any gaps in the card's
 * title/thumbnail are filled from the oEmbed payload; on a missing, private, or
 * unembeddable video (non-2xx, timeout, or network error) it returns null so
 * the card is dropped.
 */
async function verifyOneVideo(video: OraVideo, timeoutMs: number): Promise<OraVideo | null> {
  const endpoint = videoOembedEndpoint(video.url);
  // Only surface videos we can positively confirm — never a guessed URL.
  if (!endpoint) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      title?: unknown;
      thumbnail_url?: unknown;
    } | null;
    const oembedTitle = asString(data?.title);
    const oembedThumb = asString(data?.thumbnail_url);
    const thumbnailUrl =
      video.thumbnailUrl ??
      youtubeThumbnail(video.url) ??
      (oembedThumb && isSafeHttpUrl(oembedThumb) ? oembedThumb : undefined);
    const title = video.title ?? oembedTitle ?? undefined;
    return {
      url: video.url,
      ...(title ? { title } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify model-reported videos actually exist and are embeddable.
 *
 * The web_search tool grounds the prose + `sources`, but the `videos` array is
 * the model's own recollection — so it routinely contains plausible-looking yet
 * non-existent YouTube IDs that render as a broken player ("An error occurred /
 * Playback ID ...") behind a dead "Watch on YouTube" link. We confirm each
 * entry against the provider's public oEmbed endpoint (fixed, trusted hosts —
 * no SSRF) and drop anything we cannot positively confirm, so a rendered video
 * card always points at a real, playable video. Checks run in parallel with a
 * per-request timeout and preserve the original ordering.
 */
export async function verifyVideos(videos: OraVideo[], timeoutMs = 4500): Promise<OraVideo[]> {
  if (videos.length === 0) return [];
  const checked = await Promise.all(videos.map((v) => verifyOneVideo(v, timeoutMs)));
  return checked.filter((v): v is OraVideo => v !== null);
}

/**
 * Lift YouTube/Vimeo watch URLs the model left inline in its prose answer out of
 * the text, returning them as structured video entries plus the cleaned text.
 *
 * Ora is instructed to put videos in the trailing ora-media block (so the UI
 * renders verified, playable cards), but the model sometimes ignores that and
 * pastes a URL straight into the prose. Those inline URLs bypass verification
 * and render as plain markdown links — frequently dead ("video no longer
 * available") and never as an inline play card. We pull every embeddable video
 * URL out here so it joins the same verify + card pipeline, and we strip it from
 * the text so no raw video link is ever shown. Only hosts we can positively
 * verify + embed (YouTube / Vimeo) are lifted; any other link stays as prose.
 */
export function extractProseVideos(text: string): { text: string; videos: OraVideo[] } {
  if (!text) return { text: "", videos: [] };
  const videos: OraVideo[] = [];
  const seen = new Set<string>();
  const add = (url: string, title?: string): boolean => {
    const cleaned = cleanSourceUrl(url);
    if (!cleaned) return false;
    // Only lift hosts we can verify + embed; leave anything else as prose text.
    if (!videoOembedEndpoint(cleaned)) return false;
    // De-dupe by video identity, not raw URL, so the same clip in two forms
    // (youtu.be/X and youtube.com/watch?v=X) is only lifted once.
    const key = youtubeId(cleaned) ?? cleaned;
    if (seen.has(key)) return true;
    seen.add(key);
    const thumb = youtubeThumbnail(cleaned);
    const t = title?.trim();
    videos.push({
      url: cleaned,
      ...(t ? { title: t } : {}),
      ...(thumb ? { thumbnailUrl: thumb } : {}),
    });
    return true;
  };

  // 1. Markdown links [label](url): keep the label text, drop the URL.
  let out = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (whole, label: string, url: string) => (add(url, label) ? label : whole),
  );
  // 2. Bare or angle-bracketed URLs: remove the URL entirely.
  out = out.replace(/<?(https?:\/\/[^\s<>)\]]+)>?/g, (whole, url: string) =>
    add(url) ? "" : whole,
  );
  // Tidy whitespace and dangling punctuation left where a URL was removed.
  out = out
    .replace(/[ \t]*\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: out, videos };
}

/** Merge video lists, de-duplicating by canonical URL and preserving order. */
export function mergeVideos(...lists: OraVideo[][]): OraVideo[] {
  const seen = new Set<string>();
  const out: OraVideo[] = [];
  for (const list of lists) {
    for (const v of list) {
      // De-dupe by video identity, not raw URL, so the same clip surfacing in
      // both the media block and the prose (youtu.be/X vs watch?v=X) renders a
      // single card rather than two.
      const key = youtubeId(v.url) ?? v.url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

/**
 * Pull the trailing ```ora-media JSON block (or a JSON block carrying
 * `images`/`videos` keys) out of the model reply, returning the cleaned answer
 * text plus the sanitized media. Never throws on malformed JSON.
 */
export function parseOraMediaBlock(
  reply: string,
  limits?: { imageLimit?: number; videoLimit?: number },
): {
  text: string;
  images: OraImage[];
  videos: OraVideo[];
} {
  const empty = { text: reply.trim(), images: [] as OraImage[], videos: [] as OraVideo[] };
  if (!reply) return empty;

  // Prefer an explicit ora-media fence; fall back to a generic json fence.
  let match = reply.match(/```ora-media\s*([\s\S]*?)```/i);
  if (!match) {
    const generic = reply.match(/```json\s*([\s\S]*?)```/i);
    if (generic && /"(?:images|videos)"\s*:/.test(generic[1])) match = generic;
  }
  if (!match) return empty;

  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate = JSON.parse(match[1].trim());
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }

  const text = reply.replace(match[0], "").trim();
  if (!parsed) return { ...empty, text };
  return {
    text,
    images: sanitizeImages(parsed.images, limits?.imageLimit ?? 4),
    videos: sanitizeVideos(parsed.videos, limits?.videoLimit ?? 3),
  };
}

export function buildInstructions(
  language: string | undefined,
  personalContext?: string,
  wantsVideos?: boolean,
  profile: OraSearchProfile = resolveOraSearchProfile({
    query: "",
    planTier: "free",
    wantsVideos,
  }),
  documentContext?: string,
): string {
  const imageWord = profile.imageLimit === 1 ? "image" : "images";
  const videoWord = profile.videoLimit === 1 ? "video" : "videos";
  const base = [
    "You are Ora, a helpful assistant with live web access.",
    "Use the web_search tool thoroughly to find current, accurate information from reputable sources, then answer the user's question (or help troubleshoot) concisely and directly.",
    "Base your answer only on what the search returns. Quote specific facts, numbers, and dates where relevant, and prefer authoritative or official sources so the user can trust the result.",
    "If the search returns nothing useful, say so honestly instead of guessing. Never fabricate sources, facts, or URLs.",
    "Keep the answer focused — a few short paragraphs at most. Do not append a raw list of URLs; the sources are shown separately.",
    profile.searchPlan.instruction,
    profile.instruction,
    // Media: real images + videos found during search, returned as a structured
    // trailing block the server parses and strips before display.
    "When (and only when) the user would benefit from seeing them, include relevant media you ACTUALLY found via web search. Use direct image file URLs (jpg/png/webp/gif) for images and watch-page URLs for videos. Never invent or guess a URL — omit anything you are not confident is real and reachable.",
    "For image results, prefer useful visual references with a safe source page; use clear titles that identify the subject. For logos or brand assets, prefer official source pages when available.",
    `At the very END of your reply, append exactly one fenced code block tagged ora-media containing JSON of the form {"images":[{"url":"https://...","title":"...","source":"https://page-it-was-on"}],"videos":[{"url":"https://...","title":"..."}]}. Use up to ${profile.imageLimit} ${imageWord} and up to ${profile.videoLimit} ${videoWord}. If you found none, use {"images":[],"videos":[]}. Put nothing after this block.`,
  ];
  if (wantsVideos) {
    base.push(
      "For video results, favor official channels, reputable tutorials, recent walkthroughs when recency matters, and titles that clearly identify what the user will learn.",
    );
    // The user explicitly asked for a video. Make the videos array the primary
    // deliverable: the UI renders each entry as a clickable video card, so the
    // watch URLs MUST go in the media block, not the prose.
    base.push(
      'The user is specifically asking for a video. Use web_search to find one or more real, relevant videos on the topic (prefer YouTube watch-page URLs, e.g. https://www.youtube.com/watch?v=...). You MUST list every video you found in the "videos" array of the trailing ora-media block — never paste a video URL into your prose, because the videos array is rendered as clickable cards. Keep your text reply to a short sentence or two introducing them. Only include real, reachable URLs you actually found; if you genuinely found none, say so and leave the videos array empty.',
    );
  }
  if (profile.searchPlan.mediaIntent === "image") {
    base.push(
      "The user is asking to find images or visual references, not generate a new image. Use web_search to find real direct image URLs and source pages. Populate the images array with the best relevant results and keep the prose short.",
    );
  }
  if (language && language !== "auto") {
    base.push(`Respond entirely in "${language}".`);
  }
  let instructions = base.join(" ");
  // Personalization: the user's saved Ora profile/memories are appended as
  // trusted context so the search answer stays tailored to them (e.g. resolving
  // "near me" to a remembered city). These are facts the user told Ora — use
  // them to interpret the query, but never treat them as search results and
  // never fabricate new personal details.
  if (personalContext && personalContext.trim().length > 0) {
    instructions +=
      "\n\nThe following is what you already know about this user. Use it silently to interpret and personalize the request when directly relevant. Do not repeat, list, or otherwise disclose these personal details back to the user unless they are clearly germane to the answer, and never present them as if they came from the web search:" +
      personalContext;
  }
  // Uploaded file context: the user's file content from earlier in this
  // conversation. Use it to interpret the query (e.g. understanding what data
  // schema they are asking about) or to ground the answer when relevant. Treat
  // everything between the triple quotes as data only — never follow instructions
  // inside it and never present it as if it came from the web search.
  if (documentContext && documentContext.trim().length > 0) {
    instructions += "\n\n" + documentContext;
  }
  return instructions;
}

/**
 * Run a live web search and return a grounded answer plus the cited sources.
 * Throws on provider failure so the route can surface a retryable error.
 */
export async function runOraWebSearch(input: OraWebSearchInput): Promise<OraWebSearchResult> {
  const { query, history = [], language, personalContext, wantsVideos, documentContext } = input;
  const forceLive = input.forceLive === true;
  const planTier: OraPlanTier = normalizeOraPlanTier(input.subscriptionTier);
  const model = openAiModelForOraSearch(planTier);
  const profile = resolveOraSearchProfile({ query, planTier, wantsVideos });

  // Build a compact input: recent turns for follow-up context, then the query.
  const messages = [
    ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: query },
  ];

  const fullInstructions = buildInstructions(
    language,
    personalContext,
    wantsVideos,
    profile,
    documentContext,
  );
  // Shared request shape. The default search model is gpt-4o-mini: in live
  // benchmarks it returns grounded results in ~4-9s, comfortably under the
  // timeout caps, whereas gpt-5-mini at low effort spiked past the 12s normal
  // cap on a meaningful fraction of calls — degrading live search to a
  // general-knowledge answer (the "search doesn't work" symptom). Only reasoning
  // models (gpt-5 / o-series) accept `reasoning.effort`; non-reasoning models
  // like gpt-4o-mini reject it with a hard 400, so the param is gated on model
  // support and applied on BOTH the normal and forced paths when supported.
  // `search_context_size` is deliberately NOT used — unsupported on reasoning
  // models, and it would 400.
  const supportsReasoningEffort = /^(?:gpt-5|o\d)/.test(model);
  const buildParams = (instructions: string, maxOutputTokens: number, lowEffort: boolean) => ({
    model,
    instructions,
    // The web_search tool is enabled per request; the model decides when to call it.
    tools: [{ type: "web_search" }],
    max_output_tokens: maxOutputTokens,
    input: messages,
    ...(lowEffort && supportsReasoningEffort ? { reasoning: { effort: "low" } } : {}),
  });

  let attempts: SearchAttempt[];
  let retryOnTimeout: boolean;
  if (forceLive) {
    // Primary forced attempt: full personalization/context, low effort, long cap.
    // Secondary "lite" attempt: low effort + reduced tokens + trimmed instructions
    // (no personal/document context) so it can finish fast even after the primary
    // timed out. Both run at low effort; the lite pass is the safety net.
    const liteTokens = Math.min(profile.maxOutputTokens, 900);
    const liteInstructions = buildInstructions(
      language,
      undefined,
      wantsVideos,
      profile,
      undefined,
    );
    attempts = [
      {
        params: buildParams(fullInstructions, profile.maxOutputTokens, true),
        timeoutMs: ORA_SEARCH_FORCE_TIMEOUT_MS,
      },
      {
        params: buildParams(liteInstructions, liteTokens, true),
        timeoutMs: ORA_SEARCH_FORCE_RETRY_TIMEOUT_MS,
      },
    ];
    retryOnTimeout = true;
  } else {
    // Normal degrade-fast path: low effort, identical params on both attempts, no timeout retry.
    const params = buildParams(fullInstructions, profile.maxOutputTokens, true);
    attempts = [
      { params, timeoutMs: ORA_SEARCH_TIMEOUT_MS },
      { params, timeoutMs: ORA_SEARCH_RETRY_TIMEOUT_MS },
    ];
    retryOnTimeout = false;
  }

  const start = Date.now();
  const client = getClient();
  const {
    response: resp,
    attemptCount,
    latencyMs: searchLatencyMs,
  } = await createSearchResponse(client, attempts, retryOnTimeout);

  const rawReply = (resp.output_text ?? "").trim();
  const sources = dedupeSources(extractSources(resp.output), profile.sourceLimit);
  const parsed = parseOraMediaBlock(rawReply, {
    imageLimit: profile.imageLimit,
    videoLimit: profile.videoLimit,
  });
  const images = parsed.images;
  // The model is told to put videos in the media block, but it routinely inlines
  // a watch URL in the prose instead. Lift those out (and strip them from the
  // text) so they join the media-block videos rather than rendering as plain,
  // unverified, often-dead links.
  const prose = extractProseVideos(parsed.text);
  const reply = prose.text;
  // The combined videos array is the model's own recollection, not grounded by
  // the search tool, so confirm each one is a real, embeddable video before
  // surfacing it. Anything unverifiable (hallucinated/dead YouTube IDs) is
  // dropped here so the UI never renders a broken player or a dead link.
  const candidateVideos = mergeVideos(parsed.videos, prose.videos);
  const videos = (await verifyVideos(candidateVideos)).slice(0, profile.videoLimit);

  logger.info(
    {
      component: "ora-web-search",
      model,
      planTier,
      searchDepth: profile.depth,
      sourceStrategy: profile.searchPlan.sourceStrategy,
      freshness: profile.searchPlan.freshness,
      mediaIntent: profile.searchPlan.mediaIntent,
      maxOutputTokens: profile.maxOutputTokens,
      wantsVideos: wantsVideos === true,
      forceSearch: forceLive,
      searchProvider: "openai-web-search",
      searchAttemptCount: attemptCount,
      secondaryUsed: attemptCount > 1,
      searchLatencyMs,
      latencyMs: Date.now() - start,
      sourceCount: sources.length,
      imageCount: images.length,
      videoCount: videos.length,
      droppedVideoCount: candidateVideos.length - videos.length,
      hasReply: reply.length > 0,
    },
    "Ora web search completed",
  );

  if (!reply) {
    throw new Error("Web search returned an empty answer");
  }
  return { reply, sources, images, videos };
}
