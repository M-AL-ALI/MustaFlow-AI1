import { openai } from "@workspace/integrations-openai-ai-server";
import { parse as acornParse } from "acorn";
import { logger } from "./logger";
import type { AgentMode } from "./ai";
import type { TaskReport } from "@workspace/db";

const MODEL_FOR_MODE: Record<AgentMode, string> = {
  lite: "gpt-5-mini",
  eco: "gpt-5-mini",
  power: "gpt-5.4",
  pro: "gpt-5.4",
};

const MODE_QUALITY_STANDARDS: Record<AgentMode, string> = {
  lite: `QUALITY STANDARD — Lite (speed-first):
- Minimal working implementation only. Prioritise speed and correctness over polish.
- Single-page preferred. Skip decorative animations and complex layouts.
- Functional forms, basic responsive layout, readable typography.
- Skip empty states, loading skeletons, and complex error handling unless directly requested.`,

  eco: `QUALITY STANDARD — Eco (balanced):
- Clean, readable code without over-engineering.
- Responsive layout with a sensible grid or flex structure.
- Functional and clean UI — avoid decorative complexity.
- Basic error messaging on forms. Consistent spacing and colour usage.`,

  power: `QUALITY STANDARD — Power (production-grade):
- Production-quality code. Completeness and robustness are non-negotiable.
- Full responsive design: mobile-first, tablet, and desktop breakpoints handled.
- Accessible: colour contrast ≥4.5:1 for text, focus-visible outlines on interactive elements, aria-labels on icon-only buttons, semantic HTML elements.
- Loading states on async actions, empty states with helpful copy, client-side form validation with inline error messages.
- Polished UX: smooth hover/focus transitions (150–200ms), consistent spacing scale, no orphaned UI elements.`,

  pro: `QUALITY STANDARD — Pro (highest quality):
- Highest standard of UX, accessibility, and code structure.
- WCAG AA accessibility: contrast ratios, keyboard navigation, screen-reader labels, focus management.
- Full responsive: fluid grids, no overflow on any viewport, touch targets ≥44px.
- Complete error handling: network failures, empty data, validation errors — all states designed.
- Loading skeletons or spinners for every async operation. Optimistic UI where appropriate.
- Rich micro-interactions: hover lift effects, active states, animated transitions. Never feel static.
- Long-term maintainability: logical file structure, named CSS custom properties for theme tokens, no magic numbers.`,
};

const MODE_QUALITY_HINTS: Record<AgentMode, string> = {
  lite: "Speed over polish. Generate minimal, working code quickly. Keep it simple.",
  eco: "Balance quality and brevity. Write clean, readable code without over-engineering.",
  power: "Production-grade quality. Prioritize completeness, accessibility, polished UX, and thorough error handling.",
  pro: "Highest quality. Focus on UX excellence, accessibility, robust error handling, edge cases, clean code structure, and long-term maintainability.",
};

export type BuilderFile = {
  path: string;
  content: string;
  mimeType: string;
};

export type Blueprint = {
  projectName: string;
  projectType: string;
  targetPlatforms: string[];
  pages: Array<{ name: string; route: string }>;
  components: string[];
  data?: string[];
  integrationsNeeded: Array<{
    name: string;
    why: string;
    keysNeeded: string[];
    environment: "test" | "production";
  }>;
  theme?: string;
};

export type BuilderResult = {
  blueprint: Blueprint;
  files: BuilderFile[];
  report: TaskReport;
  assistantSummary: string;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

export type ValidationResult = {
  passed: boolean;
  criticalErrors: string[];
  warnings: string[];
};

const PREVIEW_NOTE = `IMPORTANT preview-runtime constraints:
- This is a static preview. Generate only safe, self-contained files: HTML, CSS, vanilla JS (or React via CDN inside <script type="text/babel">), images via public CDNs.
- ALWAYS produce an index.html. Multi-page apps use additional .html files with relative links (e.g. <a href="./about.html">).
- Use Tailwind via the CDN: <script src="https://cdn.tailwindcss.com"></script>. Do NOT reference node_modules, npm packages, or build tools.
- Use lucide icons via CDN if you need icons: <script src="https://unpkg.com/lucide@latest"></script>.
- All <img> src must be absolute https URLs (use https://images.unsplash.com/... or https://picsum.photos/...). Never reference local image files.
- Keep total output under 32,000 characters across all files combined. Pages should be polished and complete — use the full budget freely for rich, high-quality UIs.
- Forms should validate client-side and show a friendly success state — do NOT post to real servers.
- Do not use emojis in copy. Use lucide icons via class="lucide" or inline SVG instead.

MAP / LOCATION APPS:
- For ALL map/location previews, use Leaflet.js + OpenStreetMap — works without any API key:
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  Container: <div id="map" style="height:420px;width:100%;border-radius:12px"></div>
  Init: const map=L.map('map').setView([40.7128,-74.006],13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© <a href="https://osm.org/copyright">OpenStreetMap</a>'}).addTo(map);
- Custom markers: const icon=L.divIcon({html:'<div style="background:#6d28d9;width:12px;height:12px;border-radius:50%;border:2px solid white"></div>',iconSize:[12,12]});
  L.marker([lat,lng],{icon}).addTo(map).bindPopup('Label text');
- Route line: L.polyline([[lat1,lng1],[lat2,lng2]],{color:'#6d28d9',weight:4}).addTo(map);
- Service radius: L.circle([lat,lng],{radius:2000,color:'#6d28d9',fillOpacity:0.1}).addTo(map);
- Always use realistic lat/lng coordinates appropriate to the app's context (city, country).
- For production apps needing Google Maps, Mapbox, or Apple Maps, populate integrationsNeeded — the static preview always uses Leaflet/OSM regardless.
- NEVER hardcode real API keys in generated code. Use placeholder comments: /* API_KEY from project secrets */

BRAND / LOGO GENERATION:
- When user requests brand assets (logo, icon, favicon, brand kit, color palette, typography):
  Store all brand files in a brand/ subdirectory.
  - brand/logo.svg: Clean horizontal logo, viewBox="0 0 240 60", simple shapes + text only, no external fonts
  - brand/icon.svg: Square icon mark, viewBox="0 0 60 60", works at small sizes
  - brand/logo-reversed.svg: White/light version for dark backgrounds
  - brand/brand.css: CSS custom properties: --brand-primary, --brand-secondary, --brand-accent, --brand-bg, --brand-text, --brand-font-heading, --brand-font-body; plus 5-6 named color swatches
  - brand/preview.html: Self-contained brand board (Tailwind CDN) showing logo, icon, all colors with hex labels, typography sample, usage examples (light bg + dark bg)
  - brand/favicon.svg: 32x32 minimal version of the icon
  SVG must use only: rect, circle, ellipse, path, polygon, text. No external resources. Keep files under 3000 chars each.`;


const BUILD_SYSTEM_PROMPT = `You are the MustaFlow AI Builder. You generate complete, beautiful, working web projects from a single user request. You speak no prose in this mode — your only output is valid JSON.

${PREVIEW_NOTE}

OUTPUT STRICT JSON matching this exact shape:
{
  "blueprint": {
    "projectName": string,
    "projectType": string,
    "targetPlatforms": string[],
    "pages": [{ "name": string, "route": string }],
    "components": string[],
    "data": string[],
    "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
    "theme": string
  },
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "summary": string,
  "warnings": string[],
  "nextRecommendation": string
}

The "files" array must contain every file needed. Always include "index.html" as path. CSS/JS files are optional; inline is fine.`;

const REFINE_SYSTEM_PROMPT = `You are the MustaFlow AI Builder in CHANGE MODE. You receive the current project files and a change request. You modify the affected files and return the FULL updated file contents.

For files larger than 3KB, you MAY also return a "patches" array to surgically update specific sections. Each patch has: { "path": string, "find": string, "replace": string } where "find" is a unique excerpt from the file and "replace" is the new content that should replace it.

${PREVIEW_NOTE}

OUTPUT STRICT JSON matching this exact shape:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "patches": [{ "path": string, "find": string, "replace": string }],
  "filesRemoved": string[],
  "summary": string,
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nextRecommendation": string
}

The "files" array should contain ONLY the files that were created or changed (full new content). The "patches" array is optional — use it for large files where only a section changes. The "filesRemoved" array lists files to delete. Do NOT echo files that are unchanged.`;

const PLAN_SYSTEM_PROMPT = `You are the MustaFlow AI Planner. You do NOT generate code in this mode. You output a comprehensive, structured plan as STRICT JSON only.

OUTPUT STRICT JSON matching this exact shape:
{
  "summary": string,
  "goal": string,
  "approach": string,
  "sitemap": [{ "name": string, "route": string, "purpose": string }],
  "pages": string[],
  "backend": string[],
  "database": string[],
  "dataModel": [{ "table": string, "fields": string[] }],
  "apiEndpoints": [{ "method": string, "path": string, "purpose": string }],
  "integrations": string[],
  "keysNeeded": string[],
  "filesAffected": string[],
  "uxNotes": { "PageName": "UX guidance for this page — layout, interactions, tone" },
  "accessibilityNotes": string,
  "complexityScore": integer (1=trivial, 10=very complex),
  "recommendedMode": "lite"|"eco"|"power"|"pro",
  "estimatedBuildSeconds": integer,
  "risks": string[],
  "testPlan": string[]
}

Rules:
- "sitemap" must list every page/screen with route and one-sentence purpose. "pages" is a flat string list of the same names (for backward compat).
- "dataModel" only if the app stores data (even localStorage counts). Empty array otherwise.
- "apiEndpoints" only if the app calls external APIs or needs a backend. Empty array otherwise.
- "uxNotes" must have one entry per page in "sitemap" with 1-3 sentences of UX guidance.
- "accessibilityNotes" is a brief string summarising keyboard, contrast, and ARIA considerations.
- "complexityScore" must be an integer 1-10. Consider pages, data model, integrations, and interactivity.
- "recommendedMode" must be one of: lite (score 1-2), eco (score 3-4), power (score 5-7), pro (score 8-10).
- "estimatedBuildSeconds" is a realistic estimate: simple apps ~20s, medium ~40s, complex ~80s.
- Be concrete and specific. Empty arrays for sections that don't apply.`;

function modelFor(mode: AgentMode): string {
  return MODEL_FOR_MODE[mode] ?? MODEL_FOR_MODE.eco;
}

/**
 * Extract structural summary of a file — function/class names, IDs, key patterns.
 * Used for "related but not directly referenced" files in the tiered manifest.
 */
function extractStructuralSummary(content: string, mimeType: string): string {
  const lines: string[] = [];

  if (mimeType === "text/html" || content.includes("<!DOCTYPE") || content.includes("<html")) {
    const idMatches = content.match(/id="([^"]{1,40})"/g) ?? [];
    const tagMatches = content.match(/<(h[1-6]|nav|main|section|article|form|table)[^>]*>/g) ?? [];
    if (tagMatches.length > 0) lines.push(`Structural tags: ${tagMatches.slice(0, 8).join(", ")}`);
    if (idMatches.length > 0) lines.push(`IDs: ${idMatches.slice(0, 10).join(", ")}`);
  } else if (mimeType === "application/javascript" || mimeType === "text/javascript") {
    const fnMatches = content.match(/(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\())/g) ?? [];
    const classMatches = content.match(/class\s+\w+/g) ?? [];
    if (fnMatches.length > 0) lines.push(`Functions: ${fnMatches.slice(0, 10).join(", ")}`);
    if (classMatches.length > 0) lines.push(`Classes: ${classMatches.slice(0, 5).join(", ")}`);
  } else if (mimeType === "text/css") {
    const selectorMatches = content.match(/^[.#][\w-]+\s*\{/gm) ?? [];
    const varMatches = content.match(/--[\w-]+:/g) ?? [];
    if (selectorMatches.length > 0) lines.push(`Selectors: ${selectorMatches.slice(0, 8).join(", ")}`);
    if (varMatches.length > 0) lines.push(`CSS vars: ${varMatches.slice(0, 8).join(", ")}`);
  }

  return lines.length > 0 ? lines.join("; ") : "";
}

/**
 * Tiered file manifest for refine mode:
 * - Files directly mentioned in the prompt → full content
 * - Files in the same directory as mentioned files → first 800 chars + structural summary
 * - All others → single-line descriptor only
 *
 * Falls back to full content if the total is under 20k chars.
 */
export function makeCompactManifest(
  files: BuilderFile[],
  userPrompt?: string,
): string {
  const full = files
    .map((f) => `--- ${f.path} (${f.mimeType}) ---\n${f.content}`)
    .join("\n\n");
  if (full.length <= 20000) return full;

  const promptLower = (userPrompt ?? "").toLowerCase();
  const directlyReferenced = new Set<string>();
  const referencedDirs = new Set<string>();

  for (const f of files) {
    const fileName = f.path.split("/").pop()?.toLowerCase() ?? "";
    const pathLower = f.path.toLowerCase();
    if (
      promptLower.includes(pathLower) ||
      promptLower.includes(fileName) ||
      f.path === "index.html"
    ) {
      directlyReferenced.add(f.path);
      const dir = f.path.includes("/") ? f.path.split("/").slice(0, -1).join("/") : "";
      referencedDirs.add(dir);
    }
  }

  return files
    .map((f) => {
      if (directlyReferenced.has(f.path)) {
        return `--- ${f.path} (${f.mimeType}, FULL — directly referenced) ---\n${f.content}`;
      }

      const dir = f.path.includes("/") ? f.path.split("/").slice(0, -1).join("/") : "";
      if (referencedDirs.has(dir)) {
        const preview = f.content.slice(0, 800);
        const structural = extractStructuralSummary(f.content, f.mimeType);
        const tail = f.content.length > 800
          ? `\n…(${f.content.length - 800} more chars)${structural ? ` | Structure: ${structural}` : ""}`
          : "";
        return `--- ${f.path} (${f.mimeType}, ${f.content.length} chars — related dir) ---\n${preview}${tail}`;
      }

      const structural = extractStructuralSummary(f.content, f.mimeType);
      const desc = structural ? ` [${structural}]` : "";
      return `--- ${f.path} (${f.mimeType}, ${f.content.length} chars — unchanged)${desc} ---`;
    })
    .join("\n\n");
}

export type FilePatch = {
  path: string;
  find: string;
  replace: string;
};

/**
 * Apply a patch to a file's content. Returns the patched content, or null if
 * the find string was not found (caller should fall back to full replacement).
 */
export function applyPatch(content: string, patch: FilePatch): string | null {
  const idx = content.indexOf(patch.find);
  if (idx === -1) {
    logger.warn({ path: patch.path, findPreview: patch.find.slice(0, 80) }, "Patch find string not located — falling back to full replacement");
    return null;
  }
  return content.slice(0, idx) + patch.replace + content.slice(idx + patch.find.length);
}

/**
 * Runtime-guard a raw patch from AI output. Returns a valid FilePatch or null
 * if the object is malformed — prevents crashes from unexpected AI output shapes.
 */
function guardPatch(raw: unknown): FilePatch | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as Record<string, unknown>).path !== "string" ||
    typeof (raw as Record<string, unknown>).find !== "string" ||
    typeof (raw as Record<string, unknown>).replace !== "string"
  ) {
    logger.warn({ raw }, "Malformed patch entry from AI — skipping");
    return null;
  }
  return raw as FilePatch;
}

/**
 * Apply a list of patches to a set of existing files.
 * Returns:
 *   patched — map of path → successfully patched content
 *   failed  — paths where one or more patches could not be applied (find string not found)
 *
 * Malformed patch entries are ignored with a warning (never crash the pipeline).
 * Callers must fall back to full file replacement for failed paths.
 */
export function applyPatches(
  existingFiles: BuilderFile[],
  rawPatches: unknown[],
): { patched: Map<string, string>; failed: string[] } {
  const byPath = new Map(existingFiles.map((f) => [f.path, f.content]));
  const patched = new Map<string, string>();
  const failed: string[] = [];

  const grouped = new Map<string, FilePatch[]>();
  for (const raw of rawPatches) {
    const patch = guardPatch(raw);
    if (!patch) continue;
    const list = grouped.get(patch.path) ?? [];
    list.push(patch);
    grouped.set(patch.path, list);
  }

  for (const [path, filePatches] of grouped) {
    let content = byPath.get(path);
    if (content === undefined) {
      logger.warn({ path }, "Patch targets unknown file — skipping");
      failed.push(path);
      continue;
    }
    let allApplied = true;
    for (const patch of filePatches) {
      const result = applyPatch(content, patch);
      if (result === null) {
        allApplied = false;
        break;
      }
      content = result;
    }
    if (allApplied) {
      patched.set(path, content);
    } else {
      failed.push(path);
    }
  }

  return { patched, failed };
}

/**
 * Check whether a CDN URL is reachable using a HEAD request with a short timeout.
 * Returns true if reachable, false otherwise. Best-effort — never throws.
 */
async function checkUrlReachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeoutId);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Parse a JS string using acorn and return the first syntax error message, or null if valid.
 */
function parseJsSyntax(code: string): string | null {
  try {
    acornParse(code, { ecmaVersion: "latest", sourceType: "script" });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const APPROVED_CDN_HOSTNAMES = new Set([
  "cdn.tailwindcss.com",
  "unpkg.com",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "images.unsplash.com",
  "picsum.photos",
  "tile.openstreetmap.org",
  "js.stripe.com",
  "maps.googleapis.com",
  "www.gstatic.com",
]);

/**
 * Lightweight self-validation of generated/changed files.
 * Validates ALL file types in the given array:
 * - HTML: structure check + inline <script> acorn parse + CDN URL reachability
 * - JS/MJS standalone files: full acorn parse
 * Async because CDN reachability requires network calls.
 */
export async function validateFiles(files: BuilderFile[]): Promise<ValidationResult> {
  const criticalErrors: string[] = [];
  const warnings: string[] = [];
  const cdnUrlsToCheck: string[] = [];

  for (const f of files) {
    const isHtml = f.mimeType === "text/html" || f.path.endsWith(".html") || f.path.endsWith(".htm");
    const isJs = f.mimeType === "application/javascript" ||
      f.mimeType === "text/javascript" ||
      f.path.endsWith(".js") ||
      f.path.endsWith(".mjs");

    if (isHtml) {
      const c = f.content;

      // Check for basic HTML structure
      if (!c.includes("<html") && !c.includes("<!DOCTYPE")) {
        warnings.push(`${f.path}: Missing <!DOCTYPE> or <html> — may render incorrectly`);
      }
      if (!c.includes("<head") && !c.includes("<body")) {
        criticalErrors.push(`${f.path}: Missing <head> and <body> — incomplete HTML structure`);
      }

      // Check for unbalanced common tags (heuristic)
      const openCount = (tag: string) => (c.match(new RegExp(`<${tag}[\\s>]`, "gi")) ?? []).length;
      const closeCount = (tag: string) => (c.match(new RegExp(`</${tag}>`, "gi")) ?? []).length;
      for (const tag of ["div", "ul", "ol", "table", "form", "script", "style"]) {
        const opens = openCount(tag);
        const closes = closeCount(tag);
        if (opens > 0 && Math.abs(opens - closes) > opens * 0.3) {
          warnings.push(`${f.path}: Possibly unbalanced <${tag}> tags (${opens} open, ${closes} close)`);
        }
      }

      // Collect CDN URLs for reachability check
      const scriptSrcs = [...c.matchAll(/src="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!);
      const linkHrefs = [...c.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!);
      for (const url of [...scriptSrcs, ...linkHrefs]) {
        try {
          const hostname = new URL(url).hostname;
          if (!APPROVED_CDN_HOSTNAMES.has(hostname)) {
            warnings.push(`${f.path}: External URL from unrecognised host may not load in preview: ${url.slice(0, 100)}`);
          } else {
            cdnUrlsToCheck.push(url);
          }
        } catch {
          warnings.push(`${f.path}: Malformed URL detected: ${url.slice(0, 100)}`);
        }
      }

      // Parse inline <script> blocks (non-babel, non-src) with acorn
      const scriptBlocks = [
        ...c.matchAll(/<script(?![^>]*type=["']text\/babel["'])(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi),
      ];
      for (const match of scriptBlocks) {
        const code = (match[1] ?? "").trim();
        if (code.length === 0) continue;
        const syntaxError = parseJsSyntax(code);
        if (syntaxError) {
          criticalErrors.push(`${f.path}: JavaScript syntax error in inline <script>: ${syntaxError}`);
        }
      }
    }

    if (isJs) {
      // Parse standalone JS files with acorn
      const code = f.content.trim();
      if (code.length > 0) {
        const syntaxError = parseJsSyntax(code);
        if (syntaxError) {
          criticalErrors.push(`${f.path}: JavaScript syntax error: ${syntaxError}`);
        }
      }
    }
  }

  // CDN reachability — check up to 3 unique CDN URLs (bounded to keep validation fast)
  const uniqueCdnUrls = [...new Set(cdnUrlsToCheck)].slice(0, 3);
  for (const url of uniqueCdnUrls) {
    const reachable = await checkUrlReachable(url);
    if (!reachable) {
      warnings.push(`CDN URL may not be reachable in preview: ${url.slice(0, 100)}`);
    }
  }

  return { passed: criticalErrors.length === 0, criticalErrors, warnings };
}

async function callWithRetry(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  model: string,
  maxTokens: number,
  label: string,
): Promise<Record<string, unknown>> {
  let lastError: Error = new Error("Unknown error");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model,
        max_completion_tokens: maxTokens,
        messages,
        response_format: { type: "json_object" },
      });

      const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch (parseErr) {
        logger.warn(
          { attempt, raw: raw.slice(0, 300), label },
          "JSON parse failed, will retry",
        );
        lastError = new Error(
          `AI returned malformed JSON on attempt ${attempt + 1}. Retrying…`,
        );
        if (attempt === 0) {
          messages = [
            ...messages,
            {
              role: "assistant" as const,
              content: "(previous response was not valid JSON)",
            },
            {
              role: "user" as const,
              content:
                "Your previous response was not valid JSON. Please respond with ONLY valid JSON matching the schema — no markdown, no code fences, no extra text.",
            },
          ];
        }
      }
    } catch (apiErr) {
      lastError =
        apiErr instanceof Error ? apiErr : new Error(String(apiErr));
      logger.error({ err: apiErr, attempt, label }, "OpenAI API call failed");
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }

  throw lastError;
}

/**
 * Run correction pass after validation failure.
 *
 * Accepts the current full file set so it can merge corrections in — the model
 * may return only the fixed file(s), so we merge into the originals rather than
 * replacing them. The merged set is then re-validated.
 *
 * Returns the merged+corrected file set if re-validation passes, otherwise null
 * (caller persists originals and flags validation_failed).
 */
async function runCorrectionPass(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  parsed: Record<string, unknown>,
  criticalErrors: string[],
  currentFiles: BuilderFile[],
  mode: AgentMode,
  label: string,
  requireIndexHtml = false,
): Promise<BuilderFile[] | null> {
  try {
    const correctionMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      ...messages,
      { role: "assistant", content: JSON.stringify(parsed) },
      {
        role: "user",
        content: `Your generated files have the following critical errors that must be fixed:\n${criticalErrors.join("\n")}\n\nReturn ONLY the files that need corrections (with full corrected content). Other files are unchanged.`,
      },
    ];
    const corrected = await callWithRetry(correctionMessages, modelFor(mode), 32000, label);
    const rawFiles = Array.isArray(corrected.files) ? corrected.files : [];
    const correctedSubset: BuilderFile[] = rawFiles
      .filter(
        (f): f is { path: string; content: string; mimeType?: string } =>
          typeof f === "object" && f !== null &&
          typeof (f as { path?: unknown }).path === "string" &&
          typeof (f as { content?: unknown }).content === "string",
      )
      .map((f) => ({
        path: normalizePath(f.path),
        content: f.content,
        mimeType: typeof f.mimeType === "string" ? f.mimeType : guessMime(f.path),
      }));

    if (correctedSubset.length === 0) return null;

    // Merge corrected files into the full current set — never drop uncorrected files
    const mergedMap = new Map(currentFiles.map((f) => [f.path, f]));
    for (const cf of correctedSubset) {
      mergedMap.set(cf.path, cf);
    }
    const mergedFiles = [...mergedMap.values()];

    // Hard invariant for builds: merged set must still contain index.html
    if (requireIndexHtml && !mergedFiles.some((f) => f.path === "index.html")) {
      logger.warn({ label }, "Correction pass did not preserve index.html — falling back to original");
      return null;
    }

    // Re-validate the full merged set — only accept if critical errors are cleared
    const revalidation = await validateFiles(mergedFiles);
    if (revalidation.passed) {
      logger.info({ label }, "Correction pass succeeded — merged output passed re-validation");
      return mergedFiles;
    }

    logger.warn({ label, stillFailing: revalidation.criticalErrors }, "Correction pass output still has critical errors — falling back to original");
    return null;
  } catch (err) {
    logger.warn({ err, label }, "Correction pass threw — falling back to original");
    return null;
  }
}

/** Validate that a plan response contains the required new fields and retry if key ones are missing */
function validatePlanResponse(parsed: Record<string, unknown>): boolean {
  const hasGoal = typeof parsed.goal === "string" && (parsed.goal as string).length > 0;
  const hasApproach = typeof parsed.approach === "string" && (parsed.approach as string).length > 0;
  const hasSitemap = Array.isArray(parsed.sitemap) && (parsed.sitemap as unknown[]).length > 0;
  const hasComplexity =
    typeof parsed.complexityScore === "number" &&
    (parsed.complexityScore as number) >= 1 &&
    (parsed.complexityScore as number) <= 10;
  const validModes = ["lite", "eco", "power", "pro"];
  const hasRecommendedMode =
    typeof parsed.recommendedMode === "string" &&
    validModes.includes(parsed.recommendedMode as string);
  const hasEstimate =
    typeof parsed.estimatedBuildSeconds === "number" &&
    (parsed.estimatedBuildSeconds as number) > 0;
  return hasGoal && hasApproach && hasSitemap && hasComplexity && hasRecommendedMode && hasEstimate;
}

export async function runBuildPipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  integrationContext?: string;
  onEvent?: (type: string, message: string) => Promise<void>;
}): Promise<BuilderResult> {
  const { projectName, projectKind, userPrompt, agentMode, conversationHistory, knowledgeContext, integrationContext, onEvent } = args;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: BUILD_SYSTEM_PROMPT },
    {
      role: "system",
      content: `Project: "${projectName}" (kind: ${projectKind}).`,
    },
  ];

  if (knowledgeContext) {
    messages.push({
      role: "system",
      content: `LEARNED LESSONS — apply these to every build without being asked:\n${knowledgeContext}`,
    });
  }

  if (integrationContext) {
    messages.push({
      role: "system",
      content: integrationContext,
    });
  }

  messages.push({
    role: "system",
    content: MODE_QUALITY_STANDARDS[agentMode],
  });

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  messages.push({ role: "user", content: userPrompt });

  await onEvent?.("generating_code", "Generating app blueprint and code…");
  const parsed = await callWithRetry(messages, modelFor(agentMode), 32000, "build");

  const blueprint = (parsed.blueprint ?? {
    projectName,
    projectType: projectKind,
    targetPlatforms: ["web"],
    pages: [],
    components: [],
    integrationsNeeded: [],
  }) as Blueprint;

  const rawFiles = Array.isArray(parsed.files) ? parsed.files : [];
  let files: BuilderFile[] = rawFiles
    .filter(
      (f): f is { path: string; content: string; mimeType?: string } =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as { path?: unknown }).path === "string" &&
        typeof (f as { content?: unknown }).content === "string",
    )
    .map((f) => ({
      path: normalizePath(f.path),
      content: f.content,
      mimeType: typeof f.mimeType === "string" ? f.mimeType : guessMime(f.path),
    }));

  if (!files.some((f) => f.path === "index.html")) {
    throw new Error("AI builder did not produce an index.html file.");
  }

  // Self-validation pass
  await onEvent?.("validating_output", "Validating generated files…");
  const validation = await validateFiles(files);
  let correctionFailed = false;
  let postCorrectionWarnings: string[] = [];

  if (!validation.passed) {
    logger.warn({ criticalErrors: validation.criticalErrors }, "Build validation found critical errors — running correction pass");
    await onEvent?.("validating_output", `Validation found ${validation.criticalErrors.length} issue(s) — running correction…`);

    const corrected = await runCorrectionPass(messages, parsed, validation.criticalErrors, files, agentMode, "build-correction", true);
    if (corrected !== null) {
      files = corrected;
    } else {
      correctionFailed = true;
      postCorrectionWarnings = validation.criticalErrors.map((e) => `[validation_failed] ${e}`);
    }
  } else {
    // Validation passed — surface non-critical warnings (CDN, unbalanced tags, etc.)
    postCorrectionWarnings = validation.warnings;
  }

  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const warnings = correctionFailed
    ? [...aiWarnings, ...validation.warnings, ...postCorrectionWarnings]
    : [...aiWarnings, ...postCorrectionWarnings];

  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : "Open the Preview tab to see your app, then tell me what to change.";

  const summary =
    typeof parsed.summary === "string"
      ? parsed.summary
      : `Generated ${files.length} files for ${projectName}.`;

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: blueprint as unknown as Record<string, unknown>,
    filesCreated: files.map((f) => f.path),
    filesChanged: [],
    filesRemoved: [],
    previewUpdated: true,
    warnings,
    integrationsNeeded: blueprint.integrationsNeeded ?? [],
    nextRecommendation,
  };

  return { blueprint, files, report, assistantSummary: summary };
}

export async function runRefinePipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  existingFiles: BuilderFile[];
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  integrationContext?: string;
  onEvent?: (type: string, message: string) => Promise<void>;
}): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  report: TaskReport;
  assistantSummary: string;
}> {
  const { projectName, projectKind, userPrompt, agentMode, existingFiles, conversationHistory, knowledgeContext, integrationContext, onEvent } = args;

  const fileManifest = makeCompactManifest(existingFiles, userPrompt);

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: REFINE_SYSTEM_PROMPT },
    {
      role: "system",
      content: `Project: "${projectName}" (kind: ${projectKind}).\n\nCURRENT PROJECT FILES:\n${fileManifest}`,
    },
  ];

  if (knowledgeContext) {
    messages.push({
      role: "system",
      content: `LEARNED LESSONS — apply these to every change without being asked:\n${knowledgeContext}`,
    });
  }

  if (integrationContext) {
    messages.push({
      role: "system",
      content: integrationContext,
    });
  }

  messages.push({
    role: "system",
    content: MODE_QUALITY_STANDARDS[agentMode],
  });

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  messages.push({ role: "user", content: userPrompt });

  await onEvent?.("generating_code", "Applying change request with AI…");
  const parsed = await callWithRetry(messages, modelFor(agentMode), 32000, "refine");

  // Build changedFiles from full replacements returned by AI
  const rawFiles = Array.isArray(parsed.files) ? parsed.files : [];
  const changedFiles: BuilderFile[] = rawFiles
    .filter(
      (f): f is { path: string; content: string; mimeType?: string } =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as { path?: unknown }).path === "string" &&
        typeof (f as { content?: unknown }).content === "string",
    )
    .map((f) => ({
      path: normalizePath(f.path),
      content: f.content,
      mimeType: typeof f.mimeType === "string" ? f.mimeType : guessMime(f.path),
    }));

  const fullReplacementPaths = new Set(changedFiles.map((f) => f.path));

  // Apply runtime-guarded patches for large files if provided
  const rawPatches = Array.isArray(parsed.patches) ? parsed.patches : [];
  const patchWarnings: string[] = [];

  if (rawPatches.length > 0) {
    const { patched: patchedContents, failed: failedPaths } = applyPatches(existingFiles, rawPatches);

    // Merge successfully patched files (full replacement wins if also present)
    for (const [path, patchedContent] of patchedContents) {
      if (!fullReplacementPaths.has(path)) {
        const original = existingFiles.find((f) => f.path === path);
        changedFiles.push({
          path,
          content: patchedContent,
          mimeType: original?.mimeType ?? guessMime(path),
        });
        fullReplacementPaths.add(path);
      }
    }

    // For failed patches: fall back to full replacement from files[] if available,
    // otherwise keep original content (no change) and warn.
    for (const failedPath of failedPaths) {
      if (!fullReplacementPaths.has(failedPath)) {
        patchWarnings.push(`Patch could not be applied to ${failedPath} — the file was not changed. Try rephrasing the request.`);
        logger.warn({ failedPath }, "Patch failed and no full replacement available — file unchanged");
      }
    }
  }

  // Self-validation pass on ALL changed files (HTML + standalone JS)
  const filesToValidate = changedFiles.filter(
    (f) =>
      f.mimeType === "text/html" ||
      f.path.endsWith(".html") ||
      f.path.endsWith(".htm") ||
      f.mimeType === "application/javascript" ||
      f.mimeType === "text/javascript" ||
      f.path.endsWith(".js") ||
      f.path.endsWith(".mjs"),
  );

  let correctionFailed = false;
  let validationWarnings: string[] = [];

  if (filesToValidate.length > 0) {
    await onEvent?.("validating_output", "Validating changed files…");
    const validation = await validateFiles(filesToValidate);

    if (!validation.passed) {
      logger.warn({ criticalErrors: validation.criticalErrors }, "Refine validation found critical errors — running correction pass");
      await onEvent?.("validating_output", `Validation found ${validation.criticalErrors.length} issue(s) — running correction…`);

      // Pass changedFiles as currentFiles — runCorrectionPass merges the corrected subset in
      const corrected = await runCorrectionPass(messages, parsed, validation.criticalErrors, changedFiles, agentMode, "refine-correction", false);
      if (corrected !== null) {
        // corrected is already the fully merged set — replace changedFiles in-place
        changedFiles.splice(0, changedFiles.length, ...corrected);
        // Correction succeeded — only surface non-critical warnings
        validationWarnings = validation.warnings;
      } else {
        correctionFailed = true;
        validationWarnings = [
          ...validation.warnings,
          ...validation.criticalErrors.map((e) => `[validation_failed] ${e}`),
        ];
      }
    } else {
      // Passed — surface non-critical warnings (CDN reachability, tag balance, etc.)
      validationWarnings = validation.warnings;
    }
  }

  const removedPaths = Array.isArray(parsed.filesRemoved)
    ? parsed.filesRemoved
        .filter((p): p is string => typeof p === "string")
        .map(normalizePath)
    : [];

  const summary =
    typeof parsed.summary === "string"
      ? parsed.summary
      : `Updated ${changedFiles.length} file(s).`;

  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const warnings = [...aiWarnings, ...validationWarnings, ...patchWarnings];

  const integrationsNeeded = Array.isArray(parsed.integrationsNeeded)
    ? (parsed.integrationsNeeded as TaskReport["integrationsNeeded"])
    : [];
  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : "Refresh the Preview tab to see the change.";

  const existingPaths = new Set(existingFiles.map((f) => f.path));
  const filesCreated = changedFiles
    .filter((f) => !existingPaths.has(f.path))
    .map((f) => f.path);
  const filesChanged = changedFiles
    .filter((f) => existingPaths.has(f.path))
    .map((f) => f.path);

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: null,
    filesCreated,
    filesChanged,
    filesRemoved: removedPaths,
    previewUpdated: changedFiles.length > 0 || removedPaths.length > 0,
    warnings,
    integrationsNeeded,
    nextRecommendation,
  };

  return { changedFiles, removedPaths, report, assistantSummary: summary };
}

export async function runPlanPipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
}): Promise<{ summary: string; plan: Record<string, unknown> | null }> {
  const { projectName, projectKind, userPrompt, agentMode, conversationHistory } = args;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: PLAN_SYSTEM_PROMPT },
    {
      role: "system",
      content: `Project: "${projectName}" (kind: ${projectKind}).`,
    },
  ];

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-4)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  messages.push({ role: "user", content: userPrompt });

  let plan: Record<string, unknown> | null = null;
  try {
    plan = await callWithRetry(messages, modelFor(agentMode), 8000, "plan");

    // Retry once if required new fields are missing
    if (plan && !validatePlanResponse(plan)) {
      logger.info({ projectName }, "Plan missing required fields, retrying with stricter prompt");
      messages.push({
        role: "assistant",
        content: JSON.stringify(plan),
      });
      messages.push({
        role: "user",
        content: "Your plan is missing required fields. Please regenerate with ALL fields: complexityScore (integer 1-10), recommendedMode (lite/eco/power/pro), sitemap (array of objects with name/route/purpose), uxNotes (object keyed by page name), estimatedBuildSeconds (integer). Output ONLY valid JSON.",
      });
      plan = await callWithRetry(messages, modelFor(agentMode), 8000, "plan-retry");
    }
  } catch {
    plan = null;
  }

  // Ensure backward compat: if sitemap exists but pages doesn't, derive pages from sitemap
  if (plan && Array.isArray(plan.sitemap) && !Array.isArray(plan.pages)) {
    plan.pages = (plan.sitemap as Array<{ name: string }>).map((s) => s.name);
  }

  const summary =
    typeof plan?.summary === "string"
      ? plan.summary
      : "Here's a plan. Tell me to build it in the Main Agent or run it in the Background Agent.";
  return { summary, plan };
}

export function normalizePath(p: string): string {
  let clean = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (clean.includes("..")) {
    throw new Error(`Unsafe file path: ${p}`);
  }
  if (clean === "") clean = "index.html";
  return clean;
}

export function guessMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs"))
    return "application/javascript";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
  return "text/plain";
}

