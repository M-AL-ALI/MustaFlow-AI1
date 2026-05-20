import { openai } from "@workspace/integrations-openai-ai-server";
import { parse as acornParse } from "acorn";
import { logger } from "./logger";
import type { AgentMode } from "./ai";
import type { TaskReport } from "@workspace/db";
import { scanCdnUrls, autoUpgradeCdnUrl } from "./cdn-allowlist";
import type { CdnUpgrade } from "./cdn-allowlist";

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

const _MODE_QUALITY_HINTS: Record<AgentMode, string> = {
  lite: "Speed over polish. Generate minimal, working code quickly. Keep it simple.",
  eco: "Balance quality and brevity. Write clean, readable code without over-engineering.",
  power:
    "Production-grade quality. Prioritize completeness, accessibility, polished UX, and thorough error handling.",
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
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
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

const CODE_QUALITY_RULES = `CODE QUALITY RULES — apply unconditionally to every file you generate:

SEMANTIC HTML:
- Use correct heading hierarchy (h1→h2→h3). One h1 per page.
- Use semantic landmarks: <header>, <nav>, <main>, <footer>, <section>, <article>.
- Every <img> must have a meaningful alt attribute (empty alt="" for purely decorative images).
- Use <button> for clickable actions, <a href> for navigation only.
- Use <label> elements associated with every form input via for/id or wrapping.

SECURITY:
- NEVER use eval(), new Function(), or document.write().
- NEVER assign innerHTML to a value derived from user input — use textContent for user-provided strings.
- NEVER use synchronous XMLHttpRequest (open(..., false)).
- NEVER hardcode API keys, secrets, or credentials. Use placeholder comments: /* API_KEY from project secrets */

ACCESSIBILITY:
- Add aria-label to icon-only buttons and interactive elements without visible text.
- Use role="alert" or aria-live="polite" for dynamic status messages.
- Aim for colour contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text.
- All focusable elements must have a visible :focus-visible outline.

MAINTAINABILITY:
- Use descriptive variable and function names (no single-letter names except loop counters i/j/k).
- Avoid magic numbers — store meaningful constants in named variables.
- Add a short comment on non-obvious logic.
- No empty catch blocks — at minimum display or log the error.

REQUIRED META TAGS (every HTML file, no exceptions):
- <meta charset="UTF-8"> in <head>
- <meta name="viewport" content="width=device-width, initial-scale=1.0"> in <head>
- <meta name="description" content="..."> summarising the page in <head>
- <title> derived from the project name in <head>`;

const SELF_REVIEW_CLAUSE = `SELF-REVIEW REQUIREMENT: Before finalising your JSON response, silently review every generated file against the CODE QUALITY RULES. Fix any violations before writing the final response. Do not mention this review step in the output.`;

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

${CODE_QUALITY_RULES}

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

For files larger than 3KB, you MAY also return a "patches" array to surgically update specific sections. Each patch has: { "path": string, "find": string, "replace": string } where "find" is a unique excerpt from the file and "replace" is the new content that should replace it. Prefer patches over full-file rewrites for large files with localised changes — smaller payloads, fewer regressions.

${PREVIEW_NOTE}

${CODE_QUALITY_RULES}

OUTPUT STRICT JSON matching this exact shape:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "patches": [{ "path": string, "find": string, "replace": string }],
  "filesRemoved": string[],
  "unchangedFiles": string[],
  "summary": string,
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nextRecommendation": string
}

The "files" array should contain ONLY the files that were created or changed (full new content). The "patches" array is optional — use it for large files where only a section changes. The "filesRemoved" array lists files to delete. The "unchangedFiles" array MUST list every filename you are deliberately not touching — this allows the system to skip regenerating those files. Do NOT echo files that are unchanged in the "files" array.`;

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
 * Extract all external CDN URLs referenced via src or href attributes in a file's content.
 * Only returns absolute https:// URLs.
 */
function extractCdnUrls(content: string): string[] {
  const urls: string[] = [];
  const pattern = /(?:src|href)=["'](https?:\/\/[^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match[1]) urls.push(match[1]);
  }
  return urls;
}

/**
 * Scan all HTML/JS files in a file list for CDN vulnerabilities and return structured notices.
 */
function scanFilesForCdnIssues(
  files: BuilderFile[],
): NonNullable<TaskReport["securityNotices"]> {
  const allUrls: string[] = [];
  for (const f of files) {
    if (
      f.mimeType === "text/html" ||
      f.mimeType === "text/javascript" ||
      f.mimeType === "application/javascript"
    ) {
      allUrls.push(...extractCdnUrls(f.content));
    }
  }
  const unique = [...new Set(allUrls)];
  const findings = scanCdnUrls(unique);
  return findings.map((f) => ({
    packageName: f.packageName,
    description: f.description,
    upgradeTo: f.upgradeTo,
    severity: f.severity,
    ...(f.cve ? { cve: f.cve } : {}),
  }));
}

/**
 * Pro-mode two-stage generation: lightweight planning micro-call (gpt-5-mini, max 300 tokens)
 * that outputs the intended file list and each file's responsibility.
 * Inject this outline as a constraint into the main generation prompt to reduce
 * hallucinated or redundant file splits.
 */
async function runProPlanMicroCall(projectName: string, userPrompt: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            'You are a web app file planner. Output ONLY valid JSON with no prose: {"files": [{"path": string, "responsibility": string}]}. List every file the app needs with one sentence explaining its responsibility.',
        },
        { role: "user", content: `Project: "${projectName}". Request: ${userPrompt}` },
      ],
      response_format: { type: "json_object" },
    });
    const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
    const parsed = JSON.parse(raw) as { files?: Array<{ path: string; responsibility: string }> };
    if (!Array.isArray(parsed.files) || parsed.files.length === 0) return "";
    const outline = parsed.files.map((f) => `- ${f.path}: ${f.responsibility}`).join("\n");
    return `## Planned File Structure (follow this exactly — do not add or remove files without good reason)\n${outline}`;
  } catch {
    return "";
  }
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
  } else if (
    mimeType === "application/javascript" ||
    mimeType === "text/javascript" ||
    mimeType === "application/typescript"
  ) {
    // Extract function signatures with parameter names
    const fnWithParams = [
      ...content.matchAll(
        /(?:(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)|const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>)/g,
      ),
    ]
      .slice(0, 10)
      .map((m) => {
        const name = m[1] ?? m[3] ?? "?";
        const params = (m[2] ?? m[4] ?? "").replace(/\s+/g, " ").trim();
        return params ? `${name}(${params})` : `${name}()`;
      });
    // Extract module-scope const/let declarations
    const constLetMatches = [...content.matchAll(/^(?:export\s+)?(?:const|let)\s+([\w$]+)/gm)]
      .slice(0, 8)
      .map((m) => m[1]!);
    // Extract first JSDoc comment if present
    const jsdocMatch = content.match(/\/\*\*\s*([\s\S]*?)\*\//);
    const jsdocLine = jsdocMatch
      ? jsdocMatch[1]
          ?.split("\n")
          .find((l) => l.trim().replace(/^\*\s*/, "").length > 0)
          ?.trim()
          .replace(/^\*\s*/, "")
          .slice(0, 80)
      : null;
    const classMatches = content.match(/class\s+\w+/g) ?? [];
    if (fnWithParams.length > 0) lines.push(`Functions: ${fnWithParams.join(", ")}`);
    if (constLetMatches.length > 0) lines.push(`Exports: ${constLetMatches.join(", ")}`);
    if (classMatches.length > 0) lines.push(`Classes: ${classMatches.slice(0, 5).join(", ")}`);
    if (jsdocLine) lines.push(`Desc: ${jsdocLine}`);
  } else if (mimeType === "text/css") {
    const selectorMatches = content.match(/^[.#][\w-]+\s*\{/gm) ?? [];
    const varMatches = content.match(/--[\w-]+:/g) ?? [];
    if (selectorMatches.length > 0)
      lines.push(`Selectors: ${selectorMatches.slice(0, 8).join(", ")}`);
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
  unchangedFilesHint?: string[],
): string {
  const full = files.map((f) => `--- ${f.path} (${f.mimeType}) ---\n${f.content}`).join("\n\n");
  if (full.length <= 20000) return full;

  const promptLower = (userPrompt ?? "").toLowerCase();
  const directlyReferenced = new Set<string>();
  const referencedDirs = new Set<string>();
  // Files the model declared unchanged in the prior turn — deprioritise to a path-only stub
  const priorUnchanged = new Set<string>(unchangedFilesHint ?? []);

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
        const tail =
          f.content.length > 800
            ? `\n…(${f.content.length - 800} more chars)${structural ? ` | Structure: ${structural}` : ""}`
            : "";
        return `--- ${f.path} (${f.mimeType}, ${f.content.length} chars — related dir) ---\n${preview}${tail}`;
      }

      // Files the model explicitly left untouched in the previous turn get a path-only stub.
      // This saves tokens without losing structural context for files that haven't been touched.
      if (priorUnchanged.has(f.path)) {
        return `--- ${f.path} (${f.mimeType}, ${f.content.length} chars — unchanged last turn, skip unless this request affects it) ---`;
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
 * Normalise a single line: collapse runs of spaces/tabs to a single space and
 * trim trailing whitespace. Used for per-line fuzzy comparison in patch matching.
 */
function normalizeLine(line: string): string {
  return line.replace(/[ \t]+/g, " ").trimEnd();
}

/**
 * Apply a patch to a file's content. Returns the patched content, or null if
 * the find string was not found (caller should fall back to full replacement).
 *
 * Attempt 1: exact string match (zero cost, preserves all whitespace).
 * Attempt 2: line-based fuzzy match — compare each line of the find string against
 *   a sliding window of the original content lines using per-line whitespace
 *   normalisation. Only the matched window is replaced; all other original lines
 *   are preserved verbatim. This avoids the whole-file normalisation side-effects
 *   of operating on a collapsed copy of the content.
 * If both fail, returns null so the caller can fall back to full-file replacement.
 */
export function applyPatch(content: string, patch: FilePatch): string | null {
  const exactIdx = content.indexOf(patch.find);
  if (exactIdx !== -1) {
    return content.slice(0, exactIdx) + patch.replace + content.slice(exactIdx + patch.find.length);
  }

  // Line-based fuzzy fallback — preserves original text outside the matched window
  const contentLines = content.split("\n");
  const findLines = patch.find.split("\n").map(normalizeLine);
  const findLen = findLines.length;
  for (let i = 0; i <= contentLines.length - findLen; i++) {
    const window = contentLines.slice(i, i + findLen).map(normalizeLine);
    if (window.every((l, j) => l === findLines[j])) {
      logger.info(
        { path: patch.path, lineOffset: i, findPreview: patch.find.slice(0, 80) },
        "Patch applied via line-based fuzzy match",
      );
      return [...contentLines.slice(0, i), patch.replace, ...contentLines.slice(i + findLen)].join(
        "\n",
      );
    }
  }

  logger.warn(
    { path: patch.path, findPreview: patch.find.slice(0, 80) },
    "Patch find string not located — falling back to full replacement",
  );
  return null;
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
 * Validate mobile (Expo/React Native) project files.
 * Checks for required Expo structure: app.json (with name/slug/version),
 * app/_layout.tsx, and app/index.tsx. Synchronous — no network calls.
 */
export function validateMobileFiles(files: BuilderFile[]): ValidationResult {
  const criticalErrors: string[] = [];
  const warnings: string[] = [];

  const hasAppJson = files.some((f) => f.path === "app.json");
  const hasLayout = files.some((f) => f.path === "app/_layout.tsx" || f.path === "app/_layout.ts");
  const hasIndex = files.some((f) => f.path === "app/index.tsx" || f.path === "app/index.ts");
  const hasPackageJson = files.some((f) => f.path === "package.json");

  if (!hasAppJson) {
    criticalErrors.push("Missing app.json — required for Expo projects");
  } else {
    const appJsonFile = files.find((f) => f.path === "app.json");
    if (appJsonFile) {
      try {
        const json = JSON.parse(appJsonFile.content) as Record<string, unknown>;
        const expo = json.expo as Record<string, unknown> | undefined;
        if (!expo) {
          criticalErrors.push('app.json: Missing "expo" root key');
        } else {
          if (!expo.name) criticalErrors.push("app.json: Missing expo.name");
          if (!expo.slug) criticalErrors.push("app.json: Missing expo.slug");
          if (!expo.version) warnings.push("app.json: Missing expo.version — defaulting to 1.0.0");
        }
      } catch {
        criticalErrors.push("app.json: Invalid JSON content");
      }
    }
  }

  if (!hasLayout) {
    criticalErrors.push("Missing app/_layout.tsx — required for Expo Router navigation");
  }

  if (!hasIndex) {
    warnings.push("Missing app/index.tsx — the app may not have a home screen");
  }

  if (hasPackageJson) {
    const pkgFile = files.find((f) => f.path === "package.json");
    if (pkgFile) {
      try {
        const pkg = JSON.parse(pkgFile.content) as Record<string, unknown>;
        const deps = {
          ...((pkg.dependencies as Record<string, string>) ?? {}),
          ...((pkg.devDependencies as Record<string, string>) ?? {}),
        };
        const requiredPkgs = ["expo", "react-native", "expo-router"];
        for (const req of requiredPkgs) {
          if (!deps[req]) {
            warnings.push(`package.json: Missing required dependency "${req}"`);
          }
        }
      } catch {
        warnings.push("package.json: Could not parse JSON to check dependencies");
      }
    }
  }

  return { passed: criticalErrors.length === 0, criticalErrors, warnings };
}

/**
 * Validate required meta tags in an HTML file.
 * Returns warnings (not critical errors) so builds are never blocked.
 */
function validateRequiredMeta(f: BuilderFile): string[] {
  const warnings: string[] = [];
  const c = f.content;
  if (!/<meta\s[^>]*charset/i.test(c)) {
    warnings.push(`${f.path}: Missing <meta charset> — should be <meta charset="UTF-8">`);
  }
  if (!/<meta\s[^>]*name=["']viewport["']/i.test(c)) {
    warnings.push(`${f.path}: Missing <meta name="viewport"> — required for mobile responsiveness`);
  }
  if (!/<title>/i.test(c)) {
    warnings.push(`${f.path}: Missing <title> — every HTML page must have a descriptive title`);
  }
  if (!/<meta\s[^>]*name=["']description["']/i.test(c)) {
    warnings.push(`${f.path}: Missing <meta name="description"> — improves SEO and link previews`);
  }
  // CSP: detect absence of Content-Security-Policy meta tag
  if (!/<meta\s[^>]*http-equiv=["']Content-Security-Policy["']/i.test(c)) {
    warnings.push(
      `${f.path}: Missing Content-Security-Policy <meta> tag — consider adding a CSP to restrict resource origins`,
    );
  }
  // CSP: detect unsafe-inline/unsafe-eval in any existing CSP meta
  const cspMeta = c.match(
    /<meta\s[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content=["']([^"']+)["']/i,
  );
  if (cspMeta?.[1] && /(unsafe-inline|unsafe-eval)/i.test(cspMeta[1])) {
    warnings.push(
      `${f.path}: CSP contains 'unsafe-inline' or 'unsafe-eval' — these undermine injection protection`,
    );
  }
  return warnings;
}

/**
 * Scan for dangerous patterns in HTML/JS files.
 * Violations are appended as warnings (not critical errors) — builds are not blocked.
 */
function validateNoDangerousPatterns(f: BuilderFile): string[] {
  const warnings: string[] = [];
  const c = f.content;
  const patterns: Array<{ re: RegExp; label: string }> = [
    { re: /\beval\s*\(/, label: "eval() — potential code injection vulnerability" },
    { re: /document\.write\s*\(/, label: "document.write() — deprecated and unsafe" },
    {
      re: /\.innerHTML\s*=\s*(?![`"'](?:[^`"'\\]|\\.)*[`"']\s*[;,)])/,
      label: "innerHTML with potentially dynamic value — use textContent or sanitise",
    },
    {
      re: /new\s+XMLHttpRequest[\s\S]{0,100}\.open\s*\([^,]+,[^,]+,\s*false\s*\)/,
      label: "synchronous XMLHttpRequest — blocks the UI thread",
    },
  ];
  for (const { re, label } of patterns) {
    if (re.test(c)) {
      warnings.push(`${f.path}: Security/quality warning — ${label}`);
    }
  }
  return warnings;
}

/**
 * Validate a single file and return its critical errors + warnings.
 * Async because CDN reachability requires network I/O.
 */
async function validateSingleFile(
  f: BuilderFile,
): Promise<{ criticalErrors: string[]; warnings: string[] }> {
  const criticalErrors: string[] = [];
  const warnings: string[] = [];

  const isHtml = f.mimeType === "text/html" || f.path.endsWith(".html") || f.path.endsWith(".htm");
  const isJs =
    f.mimeType === "application/javascript" ||
    f.mimeType === "text/javascript" ||
    f.path.endsWith(".js") ||
    f.path.endsWith(".mjs");

  if (isHtml) {
    const c = f.content;

    if (!c.includes("<html") && !c.includes("<!DOCTYPE")) {
      warnings.push(`${f.path}: Missing <!DOCTYPE> or <html> — may render incorrectly`);
    }
    if (!c.includes("<head") && !c.includes("<body")) {
      criticalErrors.push(`${f.path}: Missing <head> and <body> — incomplete HTML structure`);
    }

    const openCount = (tag: string) => (c.match(new RegExp(`<${tag}[\\s>]`, "gi")) ?? []).length;
    const closeCount = (tag: string) => (c.match(new RegExp(`</${tag}>`, "gi")) ?? []).length;
    for (const tag of ["div", "ul", "ol", "table", "form", "script", "style"]) {
      const opens = openCount(tag);
      const closes = closeCount(tag);
      if (opens > 0 && Math.abs(opens - closes) > opens * 0.3) {
        warnings.push(
          `${f.path}: Possibly unbalanced <${tag}> tags (${opens} open, ${closes} close)`,
        );
      }
    }

    // Required meta tags check
    warnings.push(...validateRequiredMeta(f));

    // Dangerous-pattern scan
    warnings.push(...validateNoDangerousPatterns(f));

    // Duplicate id="..." attributes — each id must be unique within the document
    const allIds = [...c.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!);
    const seenIds = new Set<string>();
    for (const id of allIds) {
      if (seenIds.has(id)) {
        criticalErrors.push(
          `${f.path}: Duplicate element id="${id}" — id values must be unique per document`,
        );
      }
      seenIds.add(id);
    }

    // Shadow DOM / encapsulation conflict: attachShadow() alongside document.getElementById
    // suggests the developer is querying the light DOM from within a shadow root, which fails.
    if (c.includes("attachShadow") && /document\.(getElementById|querySelector)\b/.test(c)) {
      warnings.push(
        `${f.path}: Shadow DOM detected alongside document.getElementById/querySelector — light-DOM queries won't reach elements inside a shadow root`,
      );
    }

    // CDN allowlist + reachability — collect unique approved URLs and check up to 3
    const scriptSrcs = [...c.matchAll(/src="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!);
    const linkHrefs = [...c.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!);
    const cdnUrlsToCheck: string[] = [];
    for (const url of [...scriptSrcs, ...linkHrefs]) {
      try {
        const hostname = new URL(url).hostname;
        if (!APPROVED_CDN_HOSTNAMES.has(hostname)) {
          warnings.push(
            `${f.path}: External URL from unrecognised host may not load in preview: ${url.slice(0, 100)}`,
          );
        } else {
          cdnUrlsToCheck.push(url);
        }
      } catch {
        warnings.push(`${f.path}: Malformed URL detected: ${url.slice(0, 100)}`);
      }
    }
    const uniqueCdnUrls = [...new Set(cdnUrlsToCheck)].slice(0, 3);
    const reachabilityResults = await Promise.all(
      uniqueCdnUrls.map((url) => checkUrlReachable(url).then((ok) => ({ url, ok }))),
    );
    for (const { url, ok } of reachabilityResults) {
      if (!ok) {
        // Approved CDN URL is unreachable — escalate to critical so correction pass fires
        criticalErrors.push(
          `${f.path}: CDN URL is unreachable in preview (replace with working alternative): ${url.slice(0, 100)}`,
        );
      }
    }

    // Parse inline <script> blocks (non-babel, non-src) with acorn
    const scriptBlocks = [
      ...c.matchAll(
        /<script(?![^>]*type=["']text\/babel["'])(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi,
      ),
    ];
    for (const match of scriptBlocks) {
      const code = (match[1] ?? "").trim();
      if (code.length === 0) continue;
      const syntaxError = parseJsSyntax(code);
      if (syntaxError) {
        criticalErrors.push(
          `${f.path}: JavaScript syntax error in inline <script>: ${syntaxError}`,
        );
      }
    }
  }

  if (isJs) {
    const code = f.content.trim();
    if (code.length > 0) {
      const syntaxError = parseJsSyntax(code);
      if (syntaxError) {
        criticalErrors.push(`${f.path}: JavaScript syntax error: ${syntaxError}`);
      }
    }
    // Dangerous-pattern scan for standalone JS files too
    warnings.push(...validateNoDangerousPatterns(f));
  }

  return { criticalErrors, warnings };
}

/**
 * Lightweight self-validation of generated/changed files.
 * Validates ALL file types in the given array — runs all per-file validators
 * concurrently via Promise.all so CDN network I/O doesn't block sequentially.
 */
export async function validateFiles(files: BuilderFile[]): Promise<ValidationResult> {
  const results = await Promise.all(files.map(validateSingleFile));
  const criticalErrors: string[] = [];
  const warnings: string[] = [];
  for (const r of results) {
    criticalErrors.push(...r.criticalErrors);
    warnings.push(...r.warnings);
  }
  return { passed: criticalErrors.length === 0, criticalErrors, warnings };
}

/**
 * Classify validation critical errors by type to route targeted correction prompts.
 */
type CorrectionType = "js-syntax" | "html-structure" | "cdn-substitution" | "generic";

function classifyCriticalErrors(criticalErrors: string[]): CorrectionType {
  const hasJsErrors = criticalErrors.some(
    (e) => e.includes("JavaScript syntax error") || e.includes("SyntaxError"),
  );
  const hasHtmlErrors = criticalErrors.some(
    (e) =>
      e.includes("<head>") ||
      e.includes("<body>") ||
      e.includes("DOCTYPE") ||
      e.includes("HTML structure"),
  );
  const hasCdnErrors = criticalErrors.some((e) => e.includes("CDN") || e.includes("reachable"));
  if (hasJsErrors) return "js-syntax";
  if (hasHtmlErrors) return "html-structure";
  if (hasCdnErrors) return "cdn-substitution";
  return "generic";
}

/**
 * Return a targeted correction instruction based on the error type.
 * Targeted prompts reduce the chance of the correction introducing unrelated regressions.
 */
function getCorrectionInstruction(type: CorrectionType, criticalErrors: string[]): string {
  const errorList = criticalErrors.join("\n");
  switch (type) {
    case "js-syntax":
      return `Your generated JavaScript has syntax errors that must be fixed:\n${errorList}\n\nFocus exclusively on the JavaScript syntax. Check for: unclosed brackets/braces/parentheses, missing commas in arrays/objects, invalid arrow function syntax, and stray characters. Return ONLY the files that need corrections with their full corrected content. Do NOT change any HTML or CSS.`;
    case "html-structure":
      return `Your generated HTML has structural problems:\n${errorList}\n\nFocus only on fixing the HTML document structure: ensure proper <!DOCTYPE html>, <html lang="en">, <head>, and <body> elements are present and properly nested. Check for unbalanced tags. Return ONLY the files that need corrections with their full corrected content.`;
    case "cdn-substitution":
      return `Some CDN URLs in your generated code may not be reachable:\n${errorList}\n\nReplace any unreachable or unrecognised CDN URLs with working alternatives from the approved list:\n- Tailwind CSS: https://cdn.tailwindcss.com\n- Lucide icons: https://unpkg.com/lucide@latest\n- Leaflet maps: https://unpkg.com/leaflet@1.9.4\n- Chart.js: https://cdn.jsdelivr.net/npm/chart.js\n- Alpine.js: https://cdn.jsdelivr.net/npm/alpinejs@3\nReturn ONLY the files that need corrections with their full corrected content.`;
    default:
      return `Your generated files have the following critical errors that must be fixed:\n${errorList}\n\nReturn ONLY the files that need corrections (with full corrected content). Other files are unchanged.`;
  }
}

/**
 * Inject any missing required meta tags into an HTML file.
 * Acts as a safety net after AI generation — ensures every HTML file has
 * charset, viewport, and title even if the model missed them.
 */
function injectRequiredMetaTags(file: BuilderFile, projectName: string): BuilderFile {
  if (
    file.mimeType !== "text/html" &&
    !file.path.endsWith(".html") &&
    !file.path.endsWith(".htm")
  ) {
    return file;
  }
  let content = file.content;

  if (!/<meta\s[^>]*charset/i.test(content)) {
    content = content.replace(/(<head[^>]*>)/i, '$1\n<meta charset="UTF-8">');
  }
  if (!/<meta\s[^>]*name=["']viewport["']/i.test(content)) {
    content = content.replace(
      /(<head[^>]*>)/i,
      '$1\n<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    );
  }
  if (!/<title>/i.test(content)) {
    const safeTitle = projectName.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    content = content.replace(/(<\/head>)/i, `<title>${safeTitle}</title>\n$1`);
    if (!/<title>/i.test(content)) {
      content = content.replace(/(<head[^>]*>)/i, `$1\n<title>${safeTitle}</title>`);
    }
  }
  if (!/<meta\s[^>]*name=["']description["']/i.test(content)) {
    const safeDesc = projectName.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const descTag = `<meta name="description" content="Built with MustaFlow — ${safeDesc}">`;
    content = content.replace(/(<\/head>)/i, `${descTag}\n$1`);
    if (!/<meta\s[^>]*name=["']description["']/i.test(content)) {
      content = content.replace(/(<head[^>]*>)/i, `$1\n${descTag}`);
    }
  }

  return content === file.content ? file : { ...file, content };
}

/**
 * Sanitise a raw user prompt before injecting it into system context.
 * Strips known prompt-injection patterns (role overrides, ignore-previous phrases, etc.)
 * and returns the cleaned prompt plus a flag indicating whether anything was modified.
 * Never throws — safe to call unconditionally.
 */
export function sanitisePrompt(prompt: string): { cleaned: string; wasModified: boolean } {
  const INJECTION_PATTERNS: RegExp[] = [
    /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?/gi,
    /disregard\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?/gi,
    /forget\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?/gi,
    /override\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions?/gi,
    /you\s+are\s+now\s+(?:a|an)\s+\w/gi,
    /act\s+as\s+(?:a|an)\s+(?:different|new|unfiltered|unrestricted|uncensored)/gi,
    /(?:system|developer|admin|root)\s+(?:override|prompt|mode|command|instruction)/gi,
    /\[SYSTEM\]\s*:/gi,
    /\[INST\]/gi,
    /<\|(?:im_start|im_end|system|endoftext)\|>/gi,
    /###\s*(?:System|Instruction|Override|Prompt)\s*:/gi,
    /your\s+(?:new\s+)?(?:system\s+)?prompt\s+is/gi,
    /pretend\s+(?:you\s+are|to\s+be)\s+(?:a|an)\s+(?:different|unrestricted|unfiltered|evil)/gi,
  ];

  let cleaned = prompt;
  let wasModified = false;

  for (const pattern of INJECTION_PATTERNS) {
    const next = cleaned.replace(pattern, "[removed]");
    if (next !== cleaned) {
      wasModified = true;
      cleaned = next;
    }
  }

  return { cleaned, wasModified };
}

const SECRET_PATTERNS: Array<{ re: RegExp; category: string; redact: string }> = [
  { re: /sk-[A-Za-z0-9_-]{20,}/g, category: "OpenAI API key", redact: "[REDACTED:openai-key]" },
  {
    re: /sk_live_[A-Za-z0-9]{24,}/g,
    category: "Stripe live secret key",
    redact: "[REDACTED:stripe-secret]",
  },
  {
    re: /pk_live_[A-Za-z0-9]{24,}/g,
    category: "Stripe live publishable key",
    redact: "[REDACTED:stripe-pk]",
  },
  {
    re: /rk_live_[A-Za-z0-9]{24,}/g,
    category: "Stripe live restricted key",
    redact: "[REDACTED:stripe-rk]",
  },
  { re: /AKIA[0-9A-Z]{16}/g, category: "AWS access key", redact: "[REDACTED:aws-key]" },
  {
    re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    category: "JWT token",
    redact: "[REDACTED:jwt]",
  },
];

/**
 * Scan generated file content for hardcoded secret patterns before persistence.
 * Redacts any matches with a placeholder and returns the sanitised file set
 * plus a list of findings (file + category) for the task report.
 * Never throws — fully best-effort.
 */
export function scanForSecrets(files: BuilderFile[]): {
  files: BuilderFile[];
  findings: Array<{ file: string; category: string }>;
} {
  const findings: Array<{ file: string; category: string }> = [];

  const scannedFiles = files.map((f) => {
    let content = f.content;
    const fileCategories = new Set<string>();

    for (const { re, category, redact } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(content)) {
        re.lastIndex = 0;
        content = content.replace(new RegExp(re.source, re.flags), redact);
        fileCategories.add(category);
      }
    }

    for (const cat of fileCategories) {
      findings.push({ file: f.path, category: cat });
    }

    return fileCategories.size > 0 ? { ...f, content } : f;
  });

  return { files: scannedFiles, findings };
}

/**
 * Cross-file consistency checker — runs after files are received from the model.
 * - CSS: extracts custom class names defined in CSS files, then checks HTML files
 *   for references to those custom classes that do not appear in any CSS file.
 * - JS: when multiple standalone JS files exist, checks for function calls in
 *   HTML event attributes (onclick=, onsubmit=, etc.) that are not declared in any JS file.
 *
 * Only checks for definite mismatches to minimise false positives from Tailwind CDN classes.
 * Returns a list of warning strings to append to the task report.
 * Never throws — fully best-effort.
 */
export function validateCrossFileConsistency(files: BuilderFile[]): string[] {
  const warnings: string[] = [];
  try {
    const cssFiles = files.filter((f) => f.mimeType === "text/css" || f.path.endsWith(".css"));
    const htmlFiles = files.filter(
      (f) => f.mimeType === "text/html" || f.path.endsWith(".html") || f.path.endsWith(".htm"),
    );
    const jsFiles = files.filter(
      (f) =>
        (f.mimeType === "application/javascript" ||
          f.mimeType === "text/javascript" ||
          f.path.endsWith(".js")) &&
        !f.path.endsWith(".min.js"),
    );

    // CSS class consistency: only meaningful when custom CSS files exist
    if (cssFiles.length > 0 && htmlFiles.length > 0) {
      const definedClasses = new Set<string>();
      for (const f of cssFiles) {
        for (const m of f.content.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)\s*[{,:[]/g)) {
          definedClasses.add(m[1]!);
        }
      }

      if (definedClasses.size > 0) {
        // Tailwind CDN utility prefix heuristic — skip classes that look like Tailwind utilities
        const TAILWIND_PREFIXES =
          /^(?:flex|grid|block|inline|hidden|relative|absolute|fixed|static|sticky|overflow|z-|p-|m-|w-|h-|text-|bg-|border|rounded|shadow|font-|items-|justify-|gap-|space-|cursor-|select-|opacity-|transition|duration-|ease-|hover:|focus:|active:|group|sr-only|container|max-w|min-w|min-h|max-h|col-|row-|aspect-|place-|self-|grow|shrink|basis-|order-|decoration-|tracking-|leading-|line-|align-|whitespace-|break-|truncate|visible|invisible|isolate|float-|clear-|object-|ring-|divide-|outline-|scale-|rotate-|translate-|skew-|origin-|animate-)/;

        for (const htmlFile of htmlFiles) {
          for (const attrMatch of htmlFile.content.matchAll(/class="([^"]+)"/g)) {
            const classes = attrMatch[1]!.split(/\s+/).filter((c) => c.length > 0);
            for (const cls of classes) {
              if (cls.includes(":")) continue;
              if (TAILWIND_PREFIXES.test(cls)) continue;
              if (cls.length <= 3) continue;
              if (!definedClasses.has(cls)) {
                warnings.push(
                  `Consistency: HTML class "${cls}" in ${htmlFile.path} not defined in any CSS file — may be missing or misspelled`,
                );
              }
            }
          }
        }
      }
    }

    // JS function consistency: check HTML event attributes against JS declarations
    if (jsFiles.length > 0 && htmlFiles.length > 0) {
      const declaredFunctions = new Set<string>();
      for (const f of jsFiles) {
        for (const m of f.content.matchAll(
          /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\())/g,
        )) {
          const name = m[1] ?? m[2];
          if (name) declaredFunctions.add(name);
        }
      }

      if (declaredFunctions.size > 0) {
        const EVENT_ATTR_RE = /on\w+="([^"]+)"/g;
        const CALL_RE = /(\w+)\s*\(/g;
        const BUILTINS = new Set([
          "if",
          "for",
          "while",
          "function",
          "return",
          "alert",
          "confirm",
          "console",
          "document",
          "window",
          "Object",
          "Array",
          "JSON",
          "Math",
          "parseInt",
          "parseFloat",
          "Boolean",
          "String",
          "Number",
        ]);

        for (const htmlFile of htmlFiles) {
          for (const evtMatch of htmlFile.content.matchAll(EVENT_ATTR_RE)) {
            const handler = evtMatch[1]!;
            for (const callMatch of handler.matchAll(CALL_RE)) {
              const name = callMatch[1]!;
              if (name.length < 3) continue;
              if (BUILTINS.has(name)) continue;
              if (!declaredFunctions.has(name)) {
                warnings.push(
                  `Consistency: JS function "${name}" called in ${htmlFile.path} event handler but not declared in any JS file`,
                );
              }
            }
          }
        }
      }
    }
  } catch {
    // best-effort — never let this crash a build
  }
  return warnings;
}

/**
 * Non-blocking post-build code-smell scanner.
 * Returns a list of smell descriptions to append to the task report.
 * Never throws — fully best-effort.
 */
export function scanCodeSmells(files: BuilderFile[]): string[] {
  const smells: string[] = [];
  try {
    for (const f of files) {
      const isHtml =
        f.mimeType === "text/html" || f.path.endsWith(".html") || f.path.endsWith(".htm");
      const isJs =
        f.mimeType === "application/javascript" ||
        f.mimeType === "text/javascript" ||
        f.path.endsWith(".js") ||
        f.path.endsWith(".mjs");

      if (isHtml || isJs) {
        const c = f.content;

        // Check for excessive setTimeout chains (>2 occurrences suggests chained timeouts)
        const setTimeoutCount = (c.match(/setTimeout\s*\(/g) ?? []).length;
        if (setTimeoutCount > 2) {
          smells.push(
            `${f.path}: ${setTimeoutCount} setTimeout calls detected — consider requestAnimationFrame or event-driven patterns for animation/polling`,
          );
        }

        if (isHtml) {
          // Heuristic DOM nesting depth check
          let maxDepth = 0;
          let depth = 0;
          const VOID_TAGS =
            /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
          for (const match of c.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g)) {
            const tag = match[1] ?? "";
            const full = match[0]!;
            if (full.startsWith("</")) {
              depth = Math.max(0, depth - 1);
            } else if (!VOID_TAGS.test(tag) && !full.endsWith("/>")) {
              depth++;
              if (depth > maxDepth) maxDepth = depth;
            }
          }
          if (maxDepth > 8) {
            smells.push(
              `${f.path}: DOM nesting depth of ${maxDepth} detected — consider flattening the structure for readability and performance`,
            );
          }

          // Event listeners on document without apparent cleanup
          if (
            c.includes("document.addEventListener") &&
            !c.includes("document.removeEventListener")
          ) {
            smells.push(
              `${f.path}: document.addEventListener used without a matching removeEventListener — may cause memory leaks in long-lived apps`,
            );
          }
        }
      }
    }
  } catch {
    // best-effort — never let a smell scanner crash the build
  }
  return smells;
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
      } catch {
        logger.warn({ attempt, raw: raw.slice(0, 300), label }, "JSON parse failed, will retry");
        lastError = new Error(`AI returned malformed JSON on attempt ${attempt + 1}. Retrying…`);
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
      lastError = apiErr instanceof Error ? apiErr : new Error(String(apiErr));
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
 * Uses targeted correction instructions based on the error type to reduce
 * the chance of the correction pass introducing unrelated regressions.
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
    const correctionType = classifyCriticalErrors(criticalErrors);
    const correctionInstruction = getCorrectionInstruction(correctionType, criticalErrors);
    const correctionMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      ...messages,
      { role: "assistant", content: JSON.stringify(parsed) },
      {
        role: "user",
        content: correctionInstruction,
      },
    ];
    const corrected = await callWithRetry(correctionMessages, modelFor(mode), 32000, label);
    const rawFiles = Array.isArray(corrected.files) ? corrected.files : [];
    const correctedSubset: BuilderFile[] = rawFiles
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

    if (correctedSubset.length === 0) return null;

    // Merge corrected files into the full current set — never drop uncorrected files
    const mergedMap = new Map(currentFiles.map((f) => [f.path, f]));
    for (const cf of correctedSubset) {
      mergedMap.set(cf.path, cf);
    }
    const mergedFiles = [...mergedMap.values()];

    // Hard invariant for builds: merged set must still contain index.html
    if (requireIndexHtml && !mergedFiles.some((f) => f.path === "index.html")) {
      logger.warn(
        { label },
        "Correction pass did not preserve index.html — falling back to original",
      );
      return null;
    }

    // Re-validate the full merged set — only accept if critical errors are cleared
    const revalidation = await validateFiles(mergedFiles);
    if (revalidation.passed) {
      logger.info({ label }, "Correction pass succeeded — merged output passed re-validation");
      return mergedFiles;
    }

    logger.warn(
      { label, stillFailing: revalidation.criticalErrors },
      "Correction pass output still has critical errors — falling back to original",
    );
    return null;
  } catch (err) {
    logger.warn({ err, label }, "Correction pass threw — falling back to original");
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API Mock Auto-Generation
// Scans generated files for fetch/axios calls, creates _mocks/ JSON stubs,
// and injects a lightweight service-worker interceptor into index.html.
// ─────────────────────────────────────────────────────────────────────────────

/** Extract URL paths from fetch()/axios calls in file content */
function extractApiUrlPaths(content: string): string[] {
  const patterns = [
    // fetch('...') / fetch("...")
    /fetch\(\s*['"`]([^'"`\s]{2,}?)['"`]/g,
    // axios.get/post/put/delete/patch('...')
    /axios\s*\.\s*(?:get|post|put|delete|patch|request)\s*\(\s*['"`]([^'"`\s]{2,}?)['"`]/g,
    // fetch(`${base}/path`) / template literals with fixed suffix
    /fetch\(\s*`[^`]*?([/][a-z][a-zA-Z0-9/_-]{2,})`\s*\)/g,
  ];

  const paths: string[] = [];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      // Skip absolute URLs, data URIs, and very short strings
      if (/^https?:\/\//i.test(raw) || raw.startsWith("data:") || raw.length < 2) continue;
      // Only relative paths (starting with / or a meaningful segment)
      const path = raw.startsWith("/") ? raw : `/${raw}`;
      paths.push(path);
    }
  }
  return [...new Set(paths)];
}

/** Generate representative sample JSON for a given API path */
function generateMockData(apiPath: string): unknown {
  const seg = apiPath.toLowerCase();
  if (seg.includes("user") || seg.includes("profile") || seg.includes("me")) {
    return { id: 1, name: "Jane Doe", email: "jane@example.com", avatar: null, role: "user" };
  }
  if (seg.includes("product") || seg.includes("item") || seg.includes("catalog")) {
    return [
      { id: 1, name: "Product Alpha", price: 29.99, stock: 42, category: "general" },
      { id: 2, name: "Product Beta", price: 49.99, stock: 15, category: "general" },
      { id: 3, name: "Product Gamma", price: 9.99, stock: 100, category: "general" },
    ];
  }
  if (seg.includes("post") || seg.includes("article") || seg.includes("blog")) {
    return [
      {
        id: 1,
        title: "First Post",
        body: "Sample content here.",
        author: "Jane Doe",
        date: "2025-01-01",
      },
      {
        id: 2,
        title: "Second Post",
        body: "More sample content.",
        author: "John Smith",
        date: "2025-01-15",
      },
    ];
  }
  if (seg.includes("comment")) {
    return [
      { id: 1, text: "Great post!", author: "User A", date: "2025-01-02" },
      { id: 2, text: "Very helpful.", author: "User B", date: "2025-01-03" },
    ];
  }
  if (seg.includes("order") || seg.includes("purchase") || seg.includes("cart")) {
    return [
      { id: "ORD-001", status: "delivered", total: 79.98, items: 2, date: "2025-01-10" },
      { id: "ORD-002", status: "pending", total: 49.99, items: 1, date: "2025-01-20" },
    ];
  }
  if (
    seg.includes("stat") ||
    seg.includes("metric") ||
    seg.includes("analytic") ||
    seg.includes("dashboard")
  ) {
    return { total: 1234, active: 567, revenue: 45678.9, growth: 12.3 };
  }
  if (seg.includes("notification") || seg.includes("alert")) {
    return [
      { id: 1, message: "Your report is ready.", read: false, type: "info" },
      { id: 2, message: "Payment received.", read: true, type: "success" },
    ];
  }
  if (seg.includes("search") || seg.includes("query")) {
    return { results: [], total: 0, query: "", page: 1, perPage: 20 };
  }
  if (seg.includes("auth") || seg.includes("login") || seg.includes("token")) {
    return { token: "mock-jwt-token", expiresIn: 3600, user: { id: 1, name: "Jane Doe" } };
  }
  // Generic list or single object
  const isPlural = !seg.endsWith("s") === false || seg.includes("/list") || seg.endsWith("/");
  if (isPlural) {
    return [{ id: 1, name: "Sample Item", status: "active", createdAt: "2025-01-01T00:00:00Z" }];
  }
  return { id: 1, status: "ok", data: null, message: "Mock response" };
}

/** Convert an API path to a safe filename under _mocks/ */
function pathToMockFilename(apiPath: string): string {
  // e.g. /api/users/profile → _mocks/api/users/profile.json
  const clean = apiPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/[?#].*$/, "");
  return `_mocks/${clean || "data"}.json`;
}

/** Service worker that intercepts fetch calls and returns _mocks/ data */
const MOCK_SW_CONTENT = `// MustaFlow Preview Mock Service Worker
// Only active when window.__MUSTAFLOW_MOCK__ === true (preview iframe only)
const MOCK_BASE = '/_mocks';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const path = url.pathname;

  // Only intercept API paths (not static assets)
  if (!path.match(/\\.(html|css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/)) {
    event.respondWith(
      caches.match(event.request).then(async () => {
        try {
          const mockPath = MOCK_BASE + path.replace(/\\/+$/, '') + '.json';
          const mockRes = await fetch(mockPath);
          if (mockRes.ok) {
            const data = await mockRes.json();
            return new Response(JSON.stringify(data), {
              status: 200,
              headers: { 'Content-Type': 'application/json', 'X-Mock': '1' },
            });
          }
        } catch {}
        return fetch(event.request);
      })
    );
  }
});
`;

/** Service worker registration snippet to inject before </body> */
const SW_REGISTRATION_SNIPPET = `
<!-- MustaFlow Preview Mocks -->
<script>
if (window.__MUSTAFLOW_MOCK__ && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/_mocks/sw.js', { scope: '/' })
    .catch(function(e) { console.warn('[mock-sw] registration failed', e); });
}
</script>`;

/**
 * Scan generated files for fetch/axios API calls, generate _mocks/ JSON stubs,
 * inject the mock service-worker registration snippet into index.html, and
 * add the sw.js file.  Returns the augmented file list.
 */
export function injectApiMocks(files: BuilderFile[]): BuilderFile[] {
  // Collect all API paths referenced in JS/HTML files
  const allPaths: string[] = [];
  for (const f of files) {
    const isCode =
      f.path.endsWith(".js") ||
      f.path.endsWith(".ts") ||
      f.path.endsWith(".html") ||
      f.path.endsWith(".htm") ||
      f.mimeType === "text/javascript" ||
      f.mimeType === "application/javascript" ||
      f.mimeType === "text/html";
    if (isCode) {
      allPaths.push(...extractApiUrlPaths(f.content));
    }
  }

  const uniquePaths = [...new Set(allPaths)];
  if (uniquePaths.length === 0) {
    return files; // No API calls found, nothing to inject
  }

  // Build the set of existing mock file paths (don't overwrite hand-crafted ones)
  const existingPaths = new Set(files.map((f) => f.path));

  const mockFiles: BuilderFile[] = [];

  // Generate stub JSON for each unique API path
  for (const apiPath of uniquePaths) {
    const filename = pathToMockFilename(apiPath);
    if (!existingPaths.has(filename)) {
      const mockData = generateMockData(apiPath);
      mockFiles.push({
        path: filename,
        content: JSON.stringify(mockData, null, 2),
        mimeType: "application/json",
      });
    }
  }

  // Add the mock service worker
  if (!existingPaths.has("_mocks/sw.js")) {
    mockFiles.push({
      path: "_mocks/sw.js",
      content: MOCK_SW_CONTENT,
      mimeType: "application/javascript",
    });
  }

  // Inject SW registration snippet into index.html
  const result = files.map((f) => {
    if (f.path === "index.html" && !f.content.includes("__MUSTAFLOW_MOCK__")) {
      const patched = f.content.replace(/<\/body>/i, `${SW_REGISTRATION_SNIPPET}\n</body>`);
      return { ...f, content: patched };
    }
    return f;
  });

  return [...result, ...mockFiles];
}

const CDN_HOSTS_FOR_UPGRADE = [
  "unpkg.com",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "cdn.tailwindcss.com",
  "cdn.skypack.dev",
  "code.jquery.com",
  "stackpath.bootstrapcdn.com",
  "maxcdn.bootstrapcdn.com",
];

/**
 * Scan generated HTML files for vulnerable CDN URLs and rewrite them to safe versions.
 * Returns the updated file list and a human-readable list of upgrade messages for the task report.
 * Never throws — best-effort; any error leaves the original files untouched.
 */
export function applyCdnAutoUpgrades(files: BuilderFile[]): {
  files: BuilderFile[];
  upgrades: CdnUpgrade[];
} {
  const allUpgrades: CdnUpgrade[] = [];

  const updatedFiles = files.map((f) => {
    const isHtml = f.mimeType === "text/html" || f.path.endsWith(".html");
    if (!isHtml) return f;

    try {
      const isCdn = (s: string) => CDN_HOSTS_FOR_UPGRADE.some((h) => s.includes(h));

      // Extract all src/href attribute values that point to a known CDN host
      const extractAttr = (html: string, attr: string): string[] => {
        const re = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "gi");
        const results: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
          if (m[1] !== undefined) results.push(m[1]);
        }
        return results;
      };

      const cdnUrls = [
        ...extractAttr(f.content, "src"),
        ...extractAttr(f.content, "href"),
      ].filter(isCdn);

      if (cdnUrls.length === 0) return f;

      const findings = scanCdnUrls(cdnUrls);
      if (findings.length === 0) return f;

      let content = f.content;
      const fileUpgrades: CdnUpgrade[] = [];

      for (const finding of findings) {
        const upgrade = autoUpgradeCdnUrl(finding.url, finding);
        if (!upgrade) continue;
        // Only replace exact URL occurrences to avoid accidental substring matches
        if (content.includes(finding.url)) {
          content = content.split(finding.url).join(upgrade.upgradedUrl);
          fileUpgrades.push(upgrade);
        }
      }

      if (fileUpgrades.length === 0) return f;

      logger.info(
        { file: f.path, count: fileUpgrades.length },
        "Auto-upgraded vulnerable CDN URLs",
      );
      allUpgrades.push(...fileUpgrades);
      return { ...f, content };
    } catch (err) {
      logger.warn({ err, file: f.path }, "CDN auto-upgrade failed for file — skipping");
      return f;
    }
  });

  return { files: updatedFiles, upgrades: allUpgrades };
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
  const {
    projectName,
    projectKind,
    userPrompt,
    agentMode,
    conversationHistory,
    knowledgeContext,
    integrationContext,
    onEvent,
  } = args;

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

  // Power/Pro: append mandatory self-review clause
  if (agentMode === "power" || agentMode === "pro") {
    messages.push({ role: "system", content: SELF_REVIEW_CLAUSE });
  }

  // Pro: run a lightweight planning micro-call first to constrain the file structure
  if (agentMode === "pro") {
    await onEvent?.("planning", "Planning file structure (Pro mode)…");
    const outline = await runProPlanMicroCall(projectName, userPrompt);
    if (outline) {
      messages.push({ role: "system", content: outline });
    }
  }

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

  // Post-processing: inject required meta tags into every HTML file as a safety net
  files = files.map((f) => injectRequiredMetaTags(f, projectName));

  // Self-validation pass
  await onEvent?.("validating_output", "Validating generated files…");
  const validation = await validateFiles(files);
  let correctionFailed = false;
  let postCorrectionWarnings: string[] = [];

  if (!validation.passed) {
    logger.warn(
      { criticalErrors: validation.criticalErrors },
      "Build validation found critical errors — running correction pass",
    );
    await onEvent?.(
      "validating_output",
      `Validation found ${validation.criticalErrors.length} issue(s) — running correction…`,
    );

    const corrected = await runCorrectionPass(
      messages,
      parsed,
      validation.criticalErrors,
      files,
      agentMode,
      "build-correction",
      true,
    );
    if (corrected !== null) {
      files = corrected;
      // Re-inject meta tags into corrected files too
      files = files.map((f) => injectRequiredMetaTags(f, projectName));
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

  // Inject API mocks for any fetch/axios calls found in generated files
  files = injectApiMocks(files);

  // Auto-upgrade any vulnerable CDN URLs to safe versions
  const { files: upgradedFiles, upgrades: cdnUpgradesRaw } = applyCdnAutoUpgrades(files);
  files = upgradedFiles;
  const cdnUpgrades = cdnUpgradesRaw.map(
    (u) => `Auto-upgraded ${u.packageName} CDN from v${u.fromVersion} to v${u.toVersion}`,
  );
  const securityNotices = scanFilesForCdnIssues(files);

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
    ...(cdnUpgrades.length > 0 ? { cdnUpgrades } : {}),
    ...(securityNotices.length > 0 ? { securityNotices } : {}),
  };

  const correctionPasses = !validation.passed ? 1 : 0;
  const errorCategory = !validation.passed
    ? classifyCriticalErrors(validation.criticalErrors)
    : null;

  return {
    blueprint,
    files,
    report,
    assistantSummary: summary,
    correctionPasses,
    correctionFailed,
    primaryErrorCategory: errorCategory,
  };
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
  unchangedFilesHint?: string[];
  onEvent?: (type: string, message: string) => Promise<void>;
}): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedFiles: string[];
  report: TaskReport;
  assistantSummary: string;
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
}> {
  const {
    projectName,
    projectKind,
    userPrompt,
    agentMode,
    existingFiles,
    conversationHistory,
    knowledgeContext,
    integrationContext,
    unchangedFilesHint,
    onEvent,
  } = args;

  const fileManifest = makeCompactManifest(existingFiles, userPrompt, unchangedFilesHint);

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

  // Power/Pro: append mandatory self-review clause
  if (agentMode === "power" || agentMode === "pro") {
    messages.push({ role: "system", content: SELF_REVIEW_CLAUSE });
  }

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
    const { patched: patchedContents, failed: failedPaths } = applyPatches(
      existingFiles,
      rawPatches,
    );

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
        patchWarnings.push(
          `Patch could not be applied to ${failedPath} — the file was not changed. Try rephrasing the request.`,
        );
        logger.warn(
          { failedPath },
          "Patch failed and no full replacement available — file unchanged",
        );
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

  const correctionFailed = false;
  let correctionWasAttempted = false;
  let refineErrorCategory: string | null = null;
  let validationWarnings: string[] = [];

  if (filesToValidate.length > 0) {
    await onEvent?.("validating_output", "Validating changed files…");
    const validation = await validateFiles(filesToValidate);

    if (!validation.passed) {
      correctionWasAttempted = true;
      refineErrorCategory = classifyCriticalErrors(validation.criticalErrors);
      logger.warn(
        { criticalErrors: validation.criticalErrors },
        "Refine validation found critical errors — running correction pass",
      );
      await onEvent?.(
        "validating_output",
        `Validation found ${validation.criticalErrors.length} issue(s) — running correction…`,
      );

      // Pass changedFiles as currentFiles — runCorrectionPass merges the corrected subset in
      const corrected = await runCorrectionPass(
        messages,
        parsed,
        validation.criticalErrors,
        changedFiles,
        agentMode,
        "refine-correction",
        false,
      );
      if (corrected !== null) {
        // corrected is already the fully merged set — replace changedFiles in-place
        changedFiles.splice(0, changedFiles.length, ...corrected);
        // Correction succeeded — only surface non-critical warnings
        validationWarnings = validation.warnings;
      } else {
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

  // Post-processing: inject required meta tags into any changed HTML files
  for (let i = 0; i < changedFiles.length; i++) {
    changedFiles[i] = injectRequiredMetaTags(changedFiles[i]!, projectName);
  }

  const removedPaths = Array.isArray(parsed.filesRemoved)
    ? parsed.filesRemoved.filter((p): p is string => typeof p === "string").map(normalizePath)
    : [];

  const unchangedFiles = Array.isArray(parsed.unchangedFiles)
    ? parsed.unchangedFiles.filter((p): p is string => typeof p === "string")
    : [];

  const summary =
    typeof parsed.summary === "string" ? parsed.summary : `Updated ${changedFiles.length} file(s).`;

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

  // Inject API mocks for any new fetch/axios calls in changed files
  const mockAugmented = injectApiMocks(changedFiles);
  // Only keep mock files that are net-new (not in existingFiles) to avoid bloating refine diffs
  const existingPathsSet = new Set(existingFiles.map((f) => f.path));
  const mockOnlyFiles = mockAugmented.filter(
    (f) => f.path.startsWith("_mocks/") && !existingPathsSet.has(f.path),
  );
  // Also keep the patched index.html if SW snippet was added
  const patchedIndexHtml = mockAugmented.find((f) => f.path === "index.html");
  const changedIndex = changedFiles.find((f) => f.path === "index.html");
  if (patchedIndexHtml && changedIndex && patchedIndexHtml.content !== changedIndex.content) {
    changedIndex.content = patchedIndexHtml.content;
  }
  const finalChangedFiles =
    mockOnlyFiles.length > 0 ? [...changedFiles, ...mockOnlyFiles] : changedFiles;

  // Auto-upgrade any vulnerable CDN URLs in changed files to safe versions
  const { files: cdnUpgradedFiles, upgrades: cdnUpgradesRaw } =
    applyCdnAutoUpgrades(finalChangedFiles);
  const refineCdnUpgrades = cdnUpgradesRaw.map(
    (u) => `Auto-upgraded ${u.packageName} CDN from v${u.fromVersion} to v${u.toVersion}`,
  );

  const existingPaths = new Set(existingFiles.map((f) => f.path));
  const filesCreated = cdnUpgradedFiles
    .filter((f) => !existingPaths.has(f.path))
    .map((f) => f.path);
  const filesChanged = cdnUpgradedFiles
    .filter((f) => existingPaths.has(f.path))
    .map((f) => f.path);

  // Scan the full merged project state (existing + changed, minus removed) for CDN issues
  const removedSet = new Set(removedPaths);
  const changedPathSet = new Set(finalChangedFiles.map((f) => f.path));
  const mergedFiles = [
    ...existingFiles.filter((f) => !removedSet.has(f.path) && !changedPathSet.has(f.path)),
    ...finalChangedFiles,
  ];
  const securityNotices = scanFilesForCdnIssues(mergedFiles);

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: null,
    filesCreated,
    filesChanged,
    filesRemoved: removedPaths,
    previewUpdated: cdnUpgradedFiles.length > 0 || removedPaths.length > 0,
    warnings,
    integrationsNeeded,
    nextRecommendation,
    ...(refineCdnUpgrades.length > 0 ? { cdnUpgrades: refineCdnUpgrades } : {}),
    ...(securityNotices.length > 0 ? { securityNotices } : {}),
  };

  return {
    changedFiles: cdnUpgradedFiles,
    removedPaths,
    unchangedFiles,
    report,
    assistantSummary: summary,
    correctionPasses: correctionWasAttempted ? 1 : 0,
    correctionFailed,
    primaryErrorCategory: refineErrorCategory,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile Module Registry
// Each module defines the keywords that trigger it, the secrets it needs,
// the npm packages it introduces, and a system prompt chunk that teaches the
// AI exactly how to wire it correctly.
// ─────────────────────────────────────────────────────────────────────────────

export type MobileModule = {
  id: string;
  name: string;
  description: string;
  requiredSecrets: string[];
  intentKeywords: string[];
  packageDependencies: string[];
  systemPromptChunk: string;
};

export const MOBILE_MODULES: MobileModule[] = [
  {
    id: "auth",
    name: "Authentication (Clerk)",
    description: "User sign-in, sign-up, and session management via Clerk Expo SDK.",
    requiredSecrets: ["CLERK_PUBLISHABLE_KEY"],
    intentKeywords: [
      "login",
      "sign in",
      "sign up",
      "signup",
      "auth",
      "authentication",
      "user account",
      "password",
      "register",
      "logout",
      "session",
    ],
    packageDependencies: ["@clerk/clerk-expo", "expo-secure-store"],
    systemPromptChunk: `AUTHENTICATION MODULE (Clerk):
- Install: @clerk/clerk-expo, expo-secure-store
- In app/_layout.tsx: wrap everything in <ClerkProvider publishableKey={process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
  - tokenCache uses expo-secure-store: const tokenCache = { async getToken(k){return SecureStore.getItemAsync(k)}, async saveToken(k,v){return SecureStore.setItemAsync(k,v)} }
- Sign-in screen: import { useSignIn } from "@clerk/clerk-expo"; use signIn.create({ identifier, password }) inside try/catch
- Sign-up screen: import { useSignUp } from "@clerk/clerk-expo"; use signUp.create({ emailAddress, password }) then signUp.prepareEmailAddressVerification
- Auth guard: import { useAuth } from "@clerk/clerk-expo"; const { isSignedIn } = useAuth(); redirect to /sign-in if not signed in
- User profile: import { useUser } from "@clerk/clerk-expo"; const { user } = useUser();
- Sign out: import { useClerk } from "@clerk/clerk-expo"; const { signOut } = useClerk();
- NEVER hardcode the publishable key — always use process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY
- Add EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY to app.json extra.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`,
  },
  {
    id: "payments",
    name: "In-App Purchases (RevenueCat)",
    description: "Subscription paywalls, purchase flows, and entitlement checks via RevenueCat.",
    requiredSecrets: ["REVENUECAT_API_KEY"],
    intentKeywords: [
      "subscription",
      "payment",
      "purchase",
      "paywall",
      "premium",
      "pro plan",
      "billing",
      "buy",
      "revenuecat",
      "in-app purchase",
      "monetize",
      "pricing",
    ],
    packageDependencies: ["@revenuecat/purchases-react-native"],
    systemPromptChunk: `PAYMENTS MODULE (RevenueCat):
- Install: @revenuecat/purchases-react-native
- Initialize in app/_layout.tsx useEffect: Purchases.configure({ apiKey: process.env.EXPO_PUBLIC_REVENUECAT_API_KEY ?? "" })
- Paywall screen pattern:
  const [offerings, setOfferings] = useState<PurchasesOfferings | null>(null);
  useEffect(() => { void Purchases.getOfferings().then(setOfferings); }, []);
  const handlePurchase = async (pkg: PurchasesPackage) => {
    try { await Purchases.purchasePackage(pkg); } catch (e) { if (!e.userCancelled) throw e; }
  };
- Entitlement check: const { customerInfo } = await Purchases.getCustomerInfo();
  const hasPro = customerInfo.entitlements.active["pro"] !== undefined;
- Restore purchases button: await Purchases.restorePurchases()
- Import types: import Purchases, { type PurchasesOfferings, type PurchasesPackage } from "@revenuecat/purchases-react-native"
- NEVER hardcode the API key — use process.env.EXPO_PUBLIC_REVENUECAT_API_KEY`,
  },
  {
    id: "push",
    name: "Push Notifications (Expo Notifications)",
    description: "FCM and APNS push notifications with Expo Notifications SDK.",
    requiredSecrets: [],
    intentKeywords: [
      "push notification",
      "notification",
      "alert",
      "notify",
      "fcm",
      "apns",
      "push",
      "remind",
      "badge",
    ],
    packageDependencies: ["expo-notifications", "expo-device"],
    systemPromptChunk: `PUSH NOTIFICATIONS MODULE (Expo Notifications):
- Install: expo-notifications, expo-device
- In app.json add: { "expo": { "plugins": ["expo-notifications"], "notification": { "icon": "./assets/notification-icon.png", "color": "#ffffff" } } }
- Registration flow in a hook (hooks/usePushNotifications.ts):
  import * as Notifications from "expo-notifications";
  import * as Device from "expo-device";
  Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }) });
  async function registerForPushNotificationsAsync() {
    if (!Device.isDevice) return null;
    const { status: existing } = await Notifications.getPermissionsAsync();
    const finalStatus = existing !== "granted" ? (await Notifications.requestPermissionsAsync()).status : existing;
    if (finalStatus !== "granted") return null;
    return (await Notifications.getExpoPushTokenAsync()).data;
  }
- Listen for notifications: Notifications.addNotificationReceivedListener and Notifications.addNotificationResponseReceivedListener
- Local notification (for testing): await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null })
- Store the Expo push token server-side to send server-driven push via Expo Push API`,
  },
  {
    id: "realtime-db",
    name: "Real-time Database (Supabase)",
    description: "Typed queries, real-time subscriptions, and Row Level Security via Supabase.",
    requiredSecrets: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
    intentKeywords: [
      "real-time",
      "realtime",
      "database",
      "supabase",
      "live data",
      "feed",
      "subscribe",
      "sync",
      "backend",
      "postgres",
      "data",
    ],
    packageDependencies: [
      "@supabase/supabase-js",
      "@react-native-async-storage/async-storage",
      "react-native-url-polyfill",
    ],
    systemPromptChunk: `REAL-TIME DATABASE MODULE (Supabase):
- Install: @supabase/supabase-js, @react-native-async-storage/async-storage, react-native-url-polyfill
- Create lib/supabase.ts:
  import "react-native-url-polyfill/auto";
  import AsyncStorage from "@react-native-async-storage/async-storage";
  import { createClient } from "@supabase/supabase-js";
  export const supabase = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL ?? "",
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "",
    { auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false } }
  );
- Query pattern: const { data, error } = await supabase.from("table").select("*").order("created_at", { ascending: false });
- Real-time subscription:
  const channel = supabase.channel("table-changes").on("postgres_changes", { event: "*", schema: "public", table: "tableName" }, (payload) => {
    // handle payload.new, payload.old
  }).subscribe();
  return () => { void supabase.removeChannel(channel); };
- Row Level Security note: /*
  RLS is enabled on all tables. Users can only access their own rows.
  Example policy: CREATE POLICY "Users can read own rows" ON table FOR SELECT USING (auth.uid() = user_id);
  Run these in the Supabase SQL editor before using the client.
*/
- NEVER hardcode credentials — use process.env.EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY`,
  },
  {
    id: "analytics",
    name: "Analytics (Amplitude)",
    description: "Event tracking wired to key user actions via Amplitude React Native SDK.",
    requiredSecrets: ["AMPLITUDE_API_KEY"],
    intentKeywords: [
      "analytics",
      "tracking",
      "events",
      "amplitude",
      "posthog",
      "mixpanel",
      "user behavior",
      "conversion",
      "funnel",
      "metrics",
      "track",
    ],
    packageDependencies: ["@amplitude/analytics-react-native", "expo-application"],
    systemPromptChunk: `ANALYTICS MODULE (Amplitude):
- Install: @amplitude/analytics-react-native, expo-application
- Initialize in app/_layout.tsx:
  import { init, track, setUserId } from "@amplitude/analytics-react-native";
  useEffect(() => { void init(process.env.EXPO_PUBLIC_AMPLITUDE_API_KEY ?? "", undefined, { trackingOptions: { ipAddress: false } }); }, []);
- Track key events at every meaningful user action:
  track("screen_view", { screen: "Home" });
  track("button_tapped", { button: "subscribe" });
  track("purchase_completed", { plan: "pro", price: 9.99 });
  track("error_occurred", { error: errorMessage, screen: currentScreen });
- Set user identity after login: setUserId(user.id);
- Unset on logout: setUserId(undefined);
- NEVER hardcode the API key — use process.env.EXPO_PUBLIC_AMPLITUDE_API_KEY`,
  },
  {
    id: "deep-links",
    name: "Deep Links & Universal Links (Expo Linking)",
    description: "Share links, invites, and referral flows using Expo Linking and app schemes.",
    requiredSecrets: [],
    intentKeywords: [
      "deep link",
      "universal link",
      "share link",
      "invite",
      "referral",
      "share",
      "open url",
      "linking",
      "dynamic link",
      "branch",
    ],
    packageDependencies: ["expo-linking"],
    systemPromptChunk: `DEEP LINKS MODULE (Expo Linking):
- Install: expo-linking (included with Expo SDK)
- In app.json, set the URL scheme: { "expo": { "scheme": "myapp", "ios": { "associatedDomains": ["applinks:yourdomain.com"] }, "android": { "intentFilters": [{ "action": "VIEW", "data": [{ "scheme": "myapp" }], "category": ["BROWSABLE", "DEFAULT"] }] } } }
- Create a URL: const url = Linking.createURL("/invite", { queryParams: { ref: userId } });
- Handle incoming links in app/_layout.tsx:
  const url = Linking.useURL();
  useEffect(() => {
    if (!url) return;
    const { path, queryParams } = Linking.parse(url);
    if (path === "invite" && queryParams?.ref) { /* handle referral */ }
  }, [url]);
- Share a deep link: import { Share } from "react-native"; await Share.share({ message: \`Join me on MyApp: \${url}\` });
- Test on device: open myapp:// in the phone's browser`,
  },
  {
    id: "offline",
    name: "Offline Support (AsyncStorage + Expo SQLite)",
    description: "AsyncStorage caching and SQLite for offline-first data persistence.",
    requiredSecrets: [],
    intentKeywords: [
      "offline",
      "cache",
      "works offline",
      "local storage",
      "sqlite",
      "no internet",
      "persist",
      "sync",
      "local first",
      "asyncstorage",
    ],
    packageDependencies: ["@react-native-async-storage/async-storage", "expo-sqlite"],
    systemPromptChunk: `OFFLINE SUPPORT MODULE (AsyncStorage + Expo SQLite):
- Install: @react-native-async-storage/async-storage, expo-sqlite
- Simple key-value cache with AsyncStorage:
  import AsyncStorage from "@react-native-async-storage/async-storage";
  async function cacheData(key: string, data: unknown) { await AsyncStorage.setItem(key, JSON.stringify(data)); }
  async function getCached<T>(key: string): Promise<T | null> {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }
- SQLite for structured offline data:
  import * as SQLite from "expo-sqlite";
  const db = SQLite.openDatabaseSync("app.db");
  db.execSync("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, title TEXT, synced INTEGER DEFAULT 0)");
  function insertItem(title: string) { db.runSync("INSERT INTO items (title) VALUES (?)", [title]); }
  function getAllItems() { return db.getAllSync<{ id: number; title: string; synced: number }>("SELECT * FROM items"); }
- Sync strategy: when connectivity is restored, send all rows WHERE synced=0 to the server, then mark synced=1
- Network detection: import NetInfo from "@react-native-community/netinfo"; const state = await NetInfo.fetch(); if (state.isConnected) { /* sync */ }`,
  },
  {
    id: "camera-media",
    name: "Camera & Media (Expo Camera + ImagePicker)",
    description: "Camera capture, photo/video picking, and media upload flows.",
    requiredSecrets: [],
    intentKeywords: [
      "camera",
      "photo",
      "image",
      "video",
      "media",
      "gallery",
      "picture",
      "upload photo",
      "take photo",
      "scan",
      "qr",
      "barcode",
      "capture",
    ],
    packageDependencies: ["expo-camera", "expo-image-picker", "expo-media-library"],
    systemPromptChunk: `CAMERA & MEDIA MODULE (Expo Camera + ImagePicker):
- Install: expo-camera, expo-image-picker, expo-media-library
- In app.json plugins: ["expo-camera", "expo-image-picker", "expo-media-library"]
- Camera component pattern:
  import { CameraView, useCameraPermissions } from "expo-camera";
  const [permission, requestPermission] = useCameraPermissions();
  if (!permission?.granted) return <Button title="Grant Camera" onPress={requestPermission} />;
  <CameraView style={{ flex: 1 }} facing="back" ref={cameraRef}>
    <Button title="Take Photo" onPress={async () => { const photo = await cameraRef.current?.takePictureAsync(); }} />
  </CameraView>
- Image picker (gallery):
  import * as ImagePicker from "expo-image-picker";
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, quality: 0.8 });
  if (!result.canceled) { const uri = result.assets[0]?.uri; /* upload or display */ }
- Upload to server: const formData = new FormData(); formData.append("file", { uri, name: "photo.jpg", type: "image/jpeg" } as unknown as Blob);
  await fetch("/api/upload", { method: "POST", body: formData });
- Save to gallery: import * as MediaLibrary from "expo-media-library"; await MediaLibrary.saveToLibraryAsync(uri);`,
  },
];

/**
 * Detect which mobile modules are needed for a given user prompt.
 * Uses a lightweight AI call (gpt-5-mini) to classify intent.
 * Returns the list of module IDs detected. Best-effort — falls back to
 * keyword matching if the AI call fails.
 */
const REMOVAL_KEYWORDS = [
  "remove",
  "disable",
  "uninstall",
  "strip",
  "delete",
  "turn off",
  "get rid of",
  "take out",
  "drop",
  "clean up",
  "no longer need",
];

function isRemovalIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return REMOVAL_KEYWORDS.some((kw) => lower.includes(kw));
}

export async function detectMobileModules(
  userPrompt: string,
  existingModuleIds: string[] = [],
): Promise<{ toAdd: string[]; toRemove: string[] }> {
  const promptLower = userPrompt.toLowerCase();
  const isRemoving = isRemovalIntent(promptLower);

  // Fast keyword pass — collect candidates
  const keywordMatches = MOBILE_MODULES.filter((m) =>
    m.intentKeywords.some((kw) => promptLower.includes(kw)),
  ).map((m) => m.id);

  // If removal intent: matched modules are being removed, not added
  if (isRemoving && keywordMatches.length > 0) {
    return {
      toAdd: existingModuleIds.filter((id) => !keywordMatches.includes(id)),
      toRemove: keywordMatches,
    };
  }

  // If we already matched via keywords or the prompt is short, skip the AI call
  if (keywordMatches.length > 0 || userPrompt.length < 30) {
    return {
      toAdd: [...new Set([...keywordMatches, ...existingModuleIds])],
      toRemove: [],
    };
  }

  try {
    const moduleList = MOBILE_MODULES.map((m) => `${m.id}: ${m.name} — ${m.description}`).join(
      "\n",
    );
    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 200,
      messages: [
        {
          role: "system",
          content: `You are a mobile app module detector. Given a user request, identify which modules to add or remove. Return ONLY a JSON object: {"add": ["module-id", ...], "remove": ["module-id", ...]}. Return empty arrays if none apply.\n\nAvailable modules:\n${moduleList}`,
        },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    });
    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { add?: string[]; remove?: string[] };
    const validId = (id: string) => MOBILE_MODULES.some((m) => m.id === id);
    const aiAdd = Array.isArray(parsed.add) ? parsed.add.filter(validId) : [];
    const aiRemove = Array.isArray(parsed.remove) ? parsed.remove.filter(validId) : [];
    return {
      toAdd: [
        ...new Set([
          ...keywordMatches,
          ...aiAdd,
          ...existingModuleIds.filter((id) => !aiRemove.includes(id)),
        ]),
      ],
      toRemove: [...new Set(aiRemove)],
    };
  } catch (err) {
    logger.warn({ err }, "Module detection AI call failed — using keyword matches only");
    return {
      toAdd: [...new Set([...keywordMatches, ...existingModuleIds])],
      toRemove: [],
    };
  }
}

const AUTH_EXPO_AUTH_SESSION_CHUNK = `AUTHENTICATION MODULE (Expo Auth Session — no Clerk key configured):
- Install: expo-auth-session, expo-crypto, expo-web-browser
- Use Expo Auth Session for OAuth (Google, GitHub, etc.) or a custom JWT backend
- Initialization in app/_layout.tsx:
  import * as WebBrowser from "expo-web-browser";
  WebBrowser.maybeCompleteAuthSession();
- Google OAuth example (hooks/useGoogleAuth.ts):
  import * as Google from "expo-auth-session/providers/google";
  const [request, response, promptAsync] = Google.useAuthRequest({ clientId: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? "" });
  useEffect(() => {
    if (response?.type === "success") {
      const { authentication } = response;
      // Store token: authentication?.accessToken
    }
  }, [response]);
  const signIn = () => { void promptAsync(); };
- Session context (contexts/AuthContext.tsx): store token in expo-secure-store, expose useAuth() hook
- Protected route: check token in app/_layout.tsx; redirect to /sign-in if missing
- Sign out: clear SecureStore token + reset navigation to /sign-in
- If CLERK_PUBLISHABLE_KEY is added later, migrate to @clerk/clerk-expo without UI changes
- NEVER hardcode credentials — use process.env.EXPO_PUBLIC_* env vars`;

/**
 * Build the combined system prompt chunk for the detected modules.
 * Includes "wire these" for modules to add, and "remove these" for modules to remove.
 * Auth module branches to Clerk or Expo Auth Session based on configured secrets.
 */
function buildModulePromptChunks(
  detected: { toAdd: string[]; toRemove: string[] },
  configuredSecretNames?: string[],
): string {
  const parts: string[] = [];

  if (detected.toAdd.length > 0) {
    const hasClerkKey = configuredSecretNames?.includes("CLERK_PUBLISHABLE_KEY") ?? false;
    const chunks = MOBILE_MODULES.filter((m) => detected.toAdd.includes(m.id)).map((m) => {
      if (m.id === "auth") {
        return hasClerkKey ? m.systemPromptChunk : AUTH_EXPO_AUTH_SESSION_CHUNK;
      }
      return m.systemPromptChunk;
    });
    if (chunks.length > 0) {
      parts.push(
        `ACTIVE POWER MODULES — wire these into the generated app:\n\n${chunks.join("\n\n")}`,
      );
    }
  }

  if (detected.toRemove.length > 0) {
    const removeNames = detected.toRemove
      .map((id) => MOBILE_MODULES.find((m) => m.id === id)?.name ?? id)
      .join(", ");
    parts.push(
      `MODULES TO REMOVE — the user explicitly asked to remove these integrations:\n` +
        `${removeNames}\n` +
        `Delete all related code, imports, providers, and dependencies for these modules. ` +
        `Do NOT re-add or mention them.`,
    );
  }

  return parts.length > 0 ? `\n${parts.join("\n\n")}` : "";
}

/**
 * Validate that all packages imported by TypeScript/TSX files appear in package.json.
 * Auto-corrects missing packages for known module dependencies.
 * Returns the corrected package.json content (or unchanged if nothing was missing).
 */
function autoCorrectPackageJson(files: BuilderFile[], detectedModuleIds: string[]): BuilderFile[] {
  const pkgFile = files.find((f) => f.path === "package.json");
  if (!pkgFile) return files;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgFile.content) as Record<string, unknown>;
  } catch {
    return files;
  }

  const deps: Record<string, string> = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  };

  // Collect all packages that active modules require
  const requiredPackages: Record<string, string> = {};
  for (const modId of detectedModuleIds) {
    const mod = MOBILE_MODULES.find((m) => m.id === modId);
    if (!mod) continue;
    for (const pkg of mod.packageDependencies) {
      if (!deps[pkg]) {
        requiredPackages[pkg] = "*";
      }
    }
  }

  const KNOWN_VERSIONS: Record<string, string> = {
    "@clerk/clerk-expo": "^2.0.0",
    "expo-secure-store": "~13.0.0",
    "@revenuecat/purchases-react-native": "^8.0.0",
    "expo-notifications": "~0.28.0",
    "expo-device": "~6.0.0",
    "@supabase/supabase-js": "^2.0.0",
    "@react-native-async-storage/async-storage": "^1.23.0",
    "react-native-url-polyfill": "^2.0.0",
    "@amplitude/analytics-react-native": "^1.0.0",
    "expo-application": "~5.9.0",
    "expo-linking": "~6.3.0",
    "expo-sqlite": "~14.0.0",
    "expo-camera": "~15.0.0",
    "expo-image-picker": "~15.0.0",
    "expo-media-library": "~16.0.0",
    "expo-av": "~14.0.0",
    "expo-file-system": "~17.0.0",
    "react-native-reanimated": "~3.10.0",
    "react-native-gesture-handler": "~2.16.0",
    "expo-haptics": "~13.0.0",
    "expo-clipboard": "~6.0.0",
  };

  // Resolve versions for module-required packages
  for (const [pkgName] of Object.entries(requiredPackages)) {
    requiredPackages[pkgName] = KNOWN_VERSIONS[pkgName] ?? "*";
  }

  // Scan TypeScript/TSX source files for bare package imports not yet in package.json
  const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
  const importRe = /from ['"]([^'"./][^'"]*)['"]/g;
  for (const f of files) {
    const ext = f.path.slice(f.path.lastIndexOf("."));
    if (!SOURCE_EXTS.has(ext)) continue;
    let match: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((match = importRe.exec(f.content)) !== null) {
      const specifier = match[1];
      // Normalise scoped (@scope/pkg) and plain (pkg) bare specifiers to their package name
      const pkgName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (!pkgName || pkgName in deps || pkgName in requiredPackages) continue;
      if (pkgName in KNOWN_VERSIONS) {
        requiredPackages[pkgName] = KNOWN_VERSIONS[pkgName];
      }
    }
  }

  if (Object.keys(requiredPackages).length === 0) return files;

  const updatedDeps = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...requiredPackages,
  };

  const updatedPkg = { ...pkg, dependencies: updatedDeps };
  const updatedContent = JSON.stringify(updatedPkg, null, 2);

  logger.info(
    { added: Object.keys(requiredPackages) },
    "Auto-corrected package.json: added module dependencies",
  );

  return files.map((f) => (f.path === "package.json" ? { ...f, content: updatedContent } : f));
}

const MOBILE_PREVIEW_NOTE = `MOBILE WEB PREVIEW (index.html) — REQUIRED:
You MUST include an index.html file that is a beautiful, realistic web preview of the mobile app.
- Render inside a mobile phone frame: max-w-[390px] mx-auto, dark phone shell around the content
- Show the app's main screen with realistic mock data
- Use Tailwind CDN: <script src="https://cdn.tailwindcss.com"></script>
- Use lucide icons: <script src="https://unpkg.com/lucide@latest"></script>
- If the app has tabs, render a bottom tab bar with tab icons and labels
- Use safe area insets: top bar + bottom bar like a real phone
- Dark or light theme based on app design
- No emojis — use lucide icons only
- Mobile touch targets: min 44px height for interactive elements
- Include a "Scan with Expo Go" badge or note in the preview header
- Keep under 20,000 chars for the preview HTML`;

const MOBILE_BUILD_SYSTEM_PROMPT = `You are the MustaFlow AI Mobile Builder. You generate complete, production-ready Expo/React Native projects from a single user request. You output ONLY valid JSON — no prose, no markdown fences.

EXPO PROJECT REQUIREMENTS:
- Expo SDK 52, Expo Router v3, TypeScript, NativeWind v4
- File structure:
  - app.json: Expo configuration (name, slug, version, scheme, ios.bundleIdentifier, android.package)
  - package.json: All dependencies listed (expo ~52.0.0, react-native, expo-router ~3.5.0, nativewind ~4.0.0, tailwindcss, react, react-dom, @expo/metro-runtime, react-native-safe-area-context, react-native-screens, @react-navigation/native)
  - tailwind.config.js: NativeWind config with content paths
  - babel.config.js: Expo preset with NativeWind plugin
  - app/_layout.tsx: Root Expo Router layout (Stack or Tabs) with SafeAreaProvider
  - app/index.tsx: Home/main screen
  - app/(tabs)/_layout.tsx: Tab layout if tabs navigation is used
  - Screen files in app/* using Expo Router file-based routing
  - Shared components in components/*
  - constants/Colors.ts: Theme color constants
- TypeScript throughout: type all props, navigation params, and component interfaces
- NativeWind className props for all styling (Tailwind utility classes on React Native components)
- Expo Router file-based routing — all screens are files in the app/ directory
- SafeAreaView from react-native-safe-area-context in layouts
- Platform.OS checks where appropriate for platform-specific behavior
- FlatList for scrollable lists of data
- Stack navigation header customization via <Stack.Screen options={{}} />
- Expo SDK modules for native features (expo-camera, expo-location, expo-notifications stubs)
- NEVER use hardcoded API keys — use environment variable comments
- Mobile-first UX: large touch targets (min 44px), thumb-reachable navigation, clear visual hierarchy

${MOBILE_PREVIEW_NOTE}

OUTPUT STRICT JSON matching this exact shape:
{
  "blueprint": {
    "projectName": string,
    "projectType": string,
    "targetPlatforms": string[],
    "screens": [{ "name": string, "route": string, "purpose": string }],
    "components": string[],
    "navigation": "stack" | "tabs" | "drawer" | "mixed",
    "nativeFeatures": string[],
    "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }]
  },
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "summary": string,
  "warnings": string[],
  "nextRecommendation": string
}

MIME types: TypeScript/TSX files → "application/typescript", JSON → "application/json", JS → "application/javascript", HTML → "text/html"
Always include index.html (web preview) and all required Expo files.`;

const MOBILE_REFINE_SYSTEM_PROMPT = `You are the MustaFlow AI Mobile Builder in CHANGE MODE. You receive the current Expo/React Native project files and a change request. You modify the affected files and return the FULL updated file contents.

${MOBILE_PREVIEW_NOTE}

OUTPUT STRICT JSON matching this exact shape:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "filesRemoved": string[],
  "summary": string,
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nativeFeatures": string[],
  "nextRecommendation": string
}

"nativeFeatures" lists ALL native Expo SDK features used across the entire project after this change (e.g. "Camera", "Location", "Push Notifications", "Biometrics"). Include any that were already present plus any newly added. Empty array if none.
Return ONLY files that were created or changed (full new content). Do NOT echo unchanged files.
Always update index.html to reflect any UI changes made in the React Native screens.`;

const MOBILE_PLAN_SYSTEM_PROMPT = `You are the MustaFlow AI Mobile Planner. You plan Expo/React Native mobile app projects. Output ONLY strict JSON — no prose, no markdown:
{
  "summary": string,
  "goal": string,
  "approach": string,
  "pages": string[],
  "navigation": string[],
  "nativeFeatures": string[],
  "backend": string[],
  "database": string[],
  "integrations": string[],
  "keysNeeded": string[],
  "filesAffected": string[],
  "risks": string[],
  "testPlan": string[]
}
"pages" lists screens (e.g. "Home — feed of latest posts", "Profile — user settings and avatar"). Be specific. Empty arrays for sections that don't apply.`;

export type MobileBlueprint = {
  projectName: string;
  projectType: string;
  targetPlatforms: string[];
  screens: Array<{ name: string; route: string; purpose: string }>;
  components: string[];
  navigation: "stack" | "tabs" | "drawer" | "mixed";
  nativeFeatures: string[];
  integrationsNeeded: Array<{
    name: string;
    why: string;
    keysNeeded: string[];
    environment: "test" | "production";
  }>;
};

export type MobileBuilderResult = {
  blueprint: MobileBlueprint;
  files: BuilderFile[];
  report: TaskReport;
  assistantSummary: string;
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
};

export async function runMobileBuildPipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  activeModuleIds?: string[];
  configuredSecretNames?: string[];
  onEvent?: (type: string, message: string) => Promise<void>;
}): Promise<MobileBuilderResult> {
  const {
    projectName,
    projectKind,
    userPrompt,
    agentMode,
    conversationHistory,
    knowledgeContext,
    activeModuleIds,
    configuredSecretNames,
    onEvent,
  } = args;

  // Intent detection — classify which power modules are needed
  await onEvent?.("planning", "Detecting required power modules…");
  const detectedModules = await detectMobileModules(userPrompt, activeModuleIds ?? []);
  if (detectedModules.toAdd.length > 0) {
    const moduleNames = detectedModules.toAdd
      .map((id) => MOBILE_MODULES.find((m) => m.id === id)?.name ?? id)
      .join(", ");
    await onEvent?.("planning", `Power modules detected: ${moduleNames}`);
  }

  const modulePromptChunks = buildModulePromptChunks(detectedModules, configuredSecretNames);
  const detectedModuleIds = detectedModules.toAdd;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: MOBILE_BUILD_SYSTEM_PROMPT },
    { role: "system", content: `Project: "${projectName}" (kind: ${projectKind}).` },
  ];

  if (knowledgeContext) {
    messages.push({
      role: "system",
      content: `LEARNED LESSONS — apply these:\n${knowledgeContext}`,
    });
  }

  if (modulePromptChunks) {
    messages.push({ role: "system", content: modulePromptChunks });
  }

  messages.push({ role: "system", content: MODE_QUALITY_STANDARDS[agentMode] });

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  messages.push({ role: "user", content: userPrompt });

  await onEvent?.("generating_code", "Generating Expo/React Native app blueprint…");
  const parsed = await callWithRetry(messages, modelFor(agentMode), 32000, "mobile-build");

  const blueprint = (parsed.blueprint ?? {
    projectName,
    projectType: projectKind,
    targetPlatforms: ["ios", "android"],
    screens: [],
    components: [],
    navigation: "stack",
    nativeFeatures: [],
    integrationsNeeded: [],
  }) as MobileBlueprint;

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

  // Mobile validation: check for required Expo structure
  await onEvent?.("validating_output", "Validating Expo project structure…");
  const mobileValidation = validateMobileFiles(files);

  if (!mobileValidation.passed) {
    logger.warn(
      { criticalErrors: mobileValidation.criticalErrors },
      "Mobile build validation found critical errors — running correction pass",
    );
    await onEvent?.(
      "validating_output",
      `Mobile structure validation: ${mobileValidation.criticalErrors.length} issue(s) — running correction…`,
    );

    const correctionMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      ...messages,
      { role: "assistant", content: JSON.stringify(parsed) },
      {
        role: "user",
        content: `The generated Expo project is missing required files. Please fix:\n${mobileValidation.criticalErrors.join("\n")}\n\nReturn ONLY the corrected/missing files with full content.`,
      },
    ];

    try {
      const corrected = await callWithRetry(
        correctionMessages,
        modelFor(agentMode),
        32000,
        "mobile-build-correction",
      );
      const correctedRaw = Array.isArray(corrected.files) ? corrected.files : [];
      const correctedFiles: BuilderFile[] = correctedRaw
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
      const mergedMap = new Map(files.map((f) => [f.path, f]));
      for (const cf of correctedFiles) mergedMap.set(cf.path, cf);
      files = [...mergedMap.values()];
    } catch (err) {
      logger.warn({ err }, "Mobile correction pass failed — using original output");
    }
  }

  // Ensure there's always an index.html for the preview route
  if (!files.some((f) => f.path === "index.html")) {
    files.push({
      path: "index.html",
      content: generateMobileFallbackPreview(projectName, blueprint.screens ?? []),
      mimeType: "text/html",
    });
  }

  // Auto-correct package.json to include module dependencies
  if (detectedModuleIds.length > 0) {
    await onEvent?.("validating_output", "Verifying module packages in package.json…");
    files = autoCorrectPackageJson(files, detectedModuleIds);
  }

  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const warnings = [...aiWarnings, ...mobileValidation.warnings];

  const summary =
    typeof parsed.summary === "string"
      ? parsed.summary
      : `Generated Expo/React Native app with ${files.length} files for ${projectName}.`;

  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : "Open the Preview tab to see the web preview, then scan the QR code with Expo Go on your device.";

  const modulesWired = detectedModuleIds.map((id) => {
    const mod = MOBILE_MODULES.find((m) => m.id === id);
    return { id, name: mod?.name ?? id, secretsConsumed: mod?.requiredSecrets ?? [] };
  });

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
    nativeFeatures: blueprint.nativeFeatures?.length ? blueprint.nativeFeatures : undefined,
    modulesWired: modulesWired.length > 0 ? modulesWired : undefined,
  };

  return {
    blueprint,
    files,
    report,
    assistantSummary: summary,
    correctionPasses: 0,
    correctionFailed: false,
    primaryErrorCategory: null,
  };
}

export async function runMobileRefinePipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  existingFiles: BuilderFile[];
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  activeModuleIds?: string[];
  configuredSecretNames?: string[];
  onEvent?: (type: string, message: string) => Promise<void>;
}): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedFiles: string[];
  report: TaskReport;
  assistantSummary: string;
  detectedModuleIds: string[];
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
}> {
  const {
    projectName,
    projectKind,
    userPrompt,
    agentMode,
    existingFiles,
    conversationHistory,
    knowledgeContext,
    activeModuleIds,
    configuredSecretNames,
    onEvent,
  } = args;

  // Intent detection — detect modules to add or remove for this refine request
  const detectedModules = await detectMobileModules(userPrompt, activeModuleIds ?? []);
  const modulePromptChunks = buildModulePromptChunks(detectedModules, configuredSecretNames);
  const detectedModuleIds = detectedModules.toAdd;

  const fileManifest = makeCompactManifest(existingFiles, userPrompt);

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: MOBILE_REFINE_SYSTEM_PROMPT },
    {
      role: "system",
      content: `Project: "${projectName}" (kind: ${projectKind}).\n\nCURRENT PROJECT FILES:\n${fileManifest}`,
    },
  ];

  if (knowledgeContext) {
    messages.push({
      role: "system",
      content: `LEARNED LESSONS — apply these:\n${knowledgeContext}`,
    });
  }

  if (modulePromptChunks) {
    messages.push({ role: "system", content: modulePromptChunks });
  }

  messages.push({ role: "system", content: MODE_QUALITY_STANDARDS[agentMode] });

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  messages.push({ role: "user", content: userPrompt });

  await onEvent?.("generating_code", "Applying change request to Expo project…");
  const parsed = await callWithRetry(messages, modelFor(agentMode), 32000, "mobile-refine");

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

  const removedPaths = Array.isArray(parsed.filesRemoved)
    ? parsed.filesRemoved.filter((p): p is string => typeof p === "string").map(normalizePath)
    : [];

  const summary =
    typeof parsed.summary === "string"
      ? parsed.summary
      : `Updated ${changedFiles.length} file(s) in the Expo project.`;

  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];

  const integrationsNeeded = Array.isArray(parsed.integrationsNeeded)
    ? (parsed.integrationsNeeded as TaskReport["integrationsNeeded"])
    : [];

  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : "Refresh the Preview tab to see changes, or open the Files tab to inspect the code.";

  const existingPaths = new Set(existingFiles.map((f) => f.path));
  const filesCreated = changedFiles.filter((f) => !existingPaths.has(f.path)).map((f) => f.path);
  const filesChanged = changedFiles.filter((f) => existingPaths.has(f.path)).map((f) => f.path);

  const nativeFeatures = Array.isArray(parsed.nativeFeatures)
    ? parsed.nativeFeatures.filter((f): f is string => typeof f === "string")
    : undefined;

  // Auto-correct package.json for any newly detected modules
  if (detectedModuleIds.length > 0) {
    const allFiles = [...existingFiles];
    for (const cf of changedFiles) {
      const idx = allFiles.findIndex((f) => f.path === cf.path);
      if (idx >= 0) allFiles[idx] = cf;
      else allFiles.push(cf);
    }
    const corrected = autoCorrectPackageJson(allFiles, detectedModuleIds);
    const correctedPkg = corrected.find((f) => f.path === "package.json");
    const existingPkg = changedFiles.find((f) => f.path === "package.json");
    if (correctedPkg && !existingPkg) changedFiles.push(correctedPkg);
    else if (correctedPkg && existingPkg) existingPkg.content = correctedPkg.content;
  }

  const modulesWired = detectedModuleIds.map((id) => {
    const mod = MOBILE_MODULES.find((m) => m.id === id);
    return { id, name: mod?.name ?? id, secretsConsumed: mod?.requiredSecrets ?? [] };
  });

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: null,
    filesCreated,
    filesChanged,
    filesRemoved: removedPaths,
    previewUpdated: changedFiles.length > 0 || removedPaths.length > 0,
    warnings: aiWarnings,
    integrationsNeeded,
    nextRecommendation,
    nativeFeatures: nativeFeatures?.length ? nativeFeatures : undefined,
    modulesWired: modulesWired.length > 0 ? modulesWired : undefined,
  };

  return {
    changedFiles,
    removedPaths,
    unchangedFiles: [],
    report,
    assistantSummary: summary,
    detectedModuleIds,
    correctionPasses: 0,
    correctionFailed: false,
    primaryErrorCategory: null,
  };
}

/**
 * Generate a minimal fallback HTML preview for a mobile project
 * when the AI didn't produce an index.html.
 */
function generateMobileFallbackPreview(
  projectName: string,
  screens: Array<{ name?: string; route?: string; purpose?: string }>,
): string {
  const screenList = screens
    .slice(0, 6)
    .map(
      (s) =>
        `<li class="py-2 px-3 bg-gray-800 rounded-lg text-sm text-gray-200">${s.name ?? s.route ?? "Screen"}</li>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${projectName} — Mobile Preview</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-sm mx-auto">
    <div class="bg-gray-900 rounded-[40px] border-4 border-gray-700 shadow-2xl overflow-hidden" style="min-height:720px">
      <div class="bg-black h-10 flex items-center justify-center">
        <div class="w-24 h-6 bg-gray-900 rounded-full"></div>
      </div>
      <div class="p-6 space-y-4">
        <div class="text-center pt-4">
          <h1 class="text-xl font-bold text-white">${projectName}</h1>
          <p class="text-sm text-gray-400 mt-1">Expo/React Native App</p>
        </div>
        ${
          screens.length > 0
            ? `
        <div>
          <p class="text-xs text-gray-500 uppercase tracking-wider mb-2">Screens</p>
          <ul class="space-y-2">${screenList}</ul>
        </div>`
            : ""
        }
        <div class="bg-blue-900/30 border border-blue-700/40 rounded-xl p-4 text-center">
          <p class="text-sm text-blue-300 font-medium">Generating your app…</p>
          <p class="text-xs text-gray-500 mt-1">The AI is building your Expo project files. The preview will update after the first build.</p>
        </div>
      </div>
      <div class="absolute bottom-0 left-0 right-0 bg-black flex justify-center py-2">
        <div class="w-24 h-1 rounded-full bg-gray-700"></div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export async function runPlanPipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
}): Promise<{ summary: string; plan: Record<string, unknown> | null }> {
  const { projectName, projectKind, userPrompt, agentMode, conversationHistory } = args;

  const isMobile = ["mobile-ios", "mobile-android", "mobile-cross"].includes(projectKind);
  const planPrompt = isMobile ? MOBILE_PLAN_SYSTEM_PROMPT : PLAN_SYSTEM_PROMPT;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: planPrompt },
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

  // eslint-disable-next-line no-useless-assignment
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
        content:
          "Your plan is missing required fields. Please regenerate with ALL fields: complexityScore (integer 1-10), recommendedMode (lite/eco/power/pro), sitemap (array of objects with name/route/purpose), uxNotes (object keyed by page name), estimatedBuildSeconds (integer). Output ONLY valid JSON.",
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
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "application/typescript";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
  return "text/plain";
}
