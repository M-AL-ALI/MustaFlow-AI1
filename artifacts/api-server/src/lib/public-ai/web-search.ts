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

export interface OraWebSearchInput {
  query: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  language?: string;
}

export interface OraWebSearchResult {
  reply: string;
  sources: OraSource[];
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
 * Returns true only for http(s) URLs. Anything else (javascript:, data:,
 * file:, mailto:, etc.) is rejected so a poisoned/malformed citation can never
 * become a clickable link in the UI.
 */
export function isSafeHttpUrl(raw: string): boolean {
  try {
    const proto = new URL(raw).protocol;
    return proto === "http:" || proto === "https:";
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

function buildInstructions(language: string | undefined): string {
  const base = [
    "You are Ora, a helpful assistant with live web access.",
    "Use the web_search tool to find current, accurate information, then answer the user's question concisely and directly.",
    "Base your answer only on what the search returns. Quote specific facts, numbers, and dates where relevant.",
    "If the search returns nothing useful, say so honestly instead of guessing. Never fabricate sources or facts.",
    "Keep the answer focused — a few short paragraphs at most. Do not append a raw list of URLs; the sources are shown separately.",
  ];
  if (language && language !== "auto") {
    base.push(`Respond entirely in "${language}".`);
  }
  return base.join(" ");
}

/**
 * Run a live web search and return a grounded answer plus the cited sources.
 * Throws on provider failure so the route can surface a retryable error.
 */
export async function runOraWebSearch(input: OraWebSearchInput): Promise<OraWebSearchResult> {
  const { query, history = [], language } = input;
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
    instructions: buildInstructions(language),
    // The web_search tool is enabled per request; the model decides when to call it.
    tools: [{ type: "web_search" }] as never,
    input: messages as never,
  })) as { output_text?: string; output?: unknown };

  const reply = (resp.output_text ?? "").trim();
  const sources = dedupeSources(extractSources(resp.output));

  logger.info(
    {
      component: "ora-web-search",
      model,
      latencyMs: Date.now() - start,
      sourceCount: sources.length,
      hasReply: reply.length > 0,
    },
    "Ora web search completed",
  );

  if (!reply) {
    throw new Error("Web search returned an empty answer");
  }
  return { reply, sources };
}
