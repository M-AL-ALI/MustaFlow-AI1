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
import OpenAI from "openai";
import { logger } from "../logger";

export interface OraSource {
  title: string;
  url: string;
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
}

export interface OraWebSearchResult {
  reply: string;
  sources: OraSource[];
  images: OraImage[];
  videos: OraVideo[];
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
        sources.push({ title: title ?? hostnameOf(cleaned), url: cleaned });
      }
    }
  }
  return sources;
}

/** Dedupe sources by normalized URL (host + path), preserving first-seen order. */
export function dedupeSources(sources: OraSource[], limit = 6): OraSource[] {
  const seen = new Set<string>();
  const out: OraSource[] = [];
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
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
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
 * Pull the trailing ```ora-media JSON block (or a JSON block carrying
 * `images`/`videos` keys) out of the model reply, returning the cleaned answer
 * text plus the sanitized media. Never throws on malformed JSON.
 */
export function parseOraMediaBlock(reply: string): {
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
    images: sanitizeImages(parsed.images),
    videos: sanitizeVideos(parsed.videos),
  };
}

export function buildInstructions(
  language: string | undefined,
  personalContext?: string,
  wantsVideos?: boolean,
): string {
  const base = [
    "You are Ora, a helpful assistant with live web access.",
    "Use the web_search tool thoroughly to find current, accurate information from reputable sources, then answer the user's question (or help troubleshoot) concisely and directly.",
    "Base your answer only on what the search returns. Quote specific facts, numbers, and dates where relevant, and prefer authoritative or official sources so the user can trust the result.",
    "If the search returns nothing useful, say so honestly instead of guessing. Never fabricate sources, facts, or URLs.",
    "Keep the answer focused — a few short paragraphs at most. Do not append a raw list of URLs; the sources are shown separately.",
    // Media: real images + videos found during search, returned as a structured
    // trailing block the server parses and strips before display.
    "When (and only when) the user would benefit from seeing them, include relevant media you ACTUALLY found via web search. Use direct image file URLs (jpg/png/webp/gif) for images and watch-page URLs for videos. Never invent or guess a URL — omit anything you are not confident is real and reachable.",
    'At the very END of your reply, append exactly one fenced code block tagged ora-media containing JSON of the form {"images":[{"url":"https://...","title":"...","source":"https://page-it-was-on"}],"videos":[{"url":"https://...","title":"..."}]}. Use up to 4 images and up to 3 videos. If you found none, use {"images":[],"videos":[]}. Put nothing after this block.',
  ];
  if (wantsVideos) {
    // The user explicitly asked for a video. Make the videos array the primary
    // deliverable: the UI renders each entry as a clickable video card, so the
    // watch URLs MUST go in the media block, not the prose.
    base.push(
      'The user is specifically asking for a video. Use web_search to find one or more real, relevant videos on the topic (prefer YouTube watch-page URLs, e.g. https://www.youtube.com/watch?v=...). You MUST list every video you found in the "videos" array of the trailing ora-media block — never paste a video URL into your prose, because the videos array is rendered as clickable cards. Keep your text reply to a short sentence or two introducing them. Only include real, reachable URLs you actually found; if you genuinely found none, say so and leave the videos array empty.',
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
  return instructions;
}

/**
 * Run a live web search and return a grounded answer plus the cited sources.
 * Throws on provider failure so the route can surface a retryable error.
 */
export async function runOraWebSearch(input: OraWebSearchInput): Promise<OraWebSearchResult> {
  const { query, history = [], language, personalContext, wantsVideos } = input;
  const model = process.env.ORA_SEARCH_MODEL ?? "gpt-4o";

  // Build a compact input: recent turns for follow-up context, then the query.
  const messages = [
    ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: query },
  ];

  const start = Date.now();
  const client = getClient();
  const resp = (await client.responses.create({
    model,
    instructions: buildInstructions(language, personalContext, wantsVideos),
    // The web_search tool is enabled per request; the model decides when to call it.
    tools: [{ type: "web_search" }] as never,
    input: messages as never,
  })) as { output_text?: string; output?: unknown };

  const rawReply = (resp.output_text ?? "").trim();
  const sources = dedupeSources(extractSources(resp.output));
  const { text: reply, images, videos: parsedVideos } = parseOraMediaBlock(rawReply);
  // The videos array is the model's own recollection, not grounded by the
  // search tool, so confirm each one is a real, embeddable video before
  // surfacing it. Anything unverifiable (hallucinated/dead YouTube IDs) is
  // dropped here so the UI never renders a broken player or a dead link.
  const videos = await verifyVideos(parsedVideos);

  logger.info(
    {
      component: "ora-web-search",
      model,
      latencyMs: Date.now() - start,
      sourceCount: sources.length,
      imageCount: images.length,
      videoCount: videos.length,
      droppedVideoCount: parsedVideos.length - videos.length,
      hasReply: reply.length > 0,
    },
    "Ora web search completed",
  );

  if (!reply) {
    throw new Error("Web search returned an empty answer");
  }
  return { reply, sources, images, videos };
}
