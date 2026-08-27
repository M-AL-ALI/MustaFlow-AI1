import { openai } from "@workspace/integrations-openai-ai-server";
import { parse as acornParse } from "acorn";
import { checkSyntax } from "./checks/syntax-checker";
import { runTsCheck, formatTsErrors } from "./checks/ts-checker";
import { logger } from "./logger";
import { isValidTenantServicePort } from "./runtime-manifest";
import type { AgentMode } from "./ai";
import { creditCostFor, EmptyCompletionError, resolveStageProvider } from "./ai-providers";
import type { StreamCompletionSummary } from "./ai-providers";
import {
  completionSummaryFromResponse,
  ConverseCompletionInterruptedError,
  requireCleanConverseCompletion,
  type ConverseStopEvidence,
} from "./converse-completion";
import type { TaskReport } from "@workspace/db";
import { scanCdnUrls, autoUpgradeCdnUrl } from "./cdn-allowlist";
import type { CdnUpgrade } from "./cdn-allowlist";
import type { TestPlan } from "./checks/playwright-runner";
import { runPlanningBrain } from "./planning-brain";
import type {
  RuntimeManifestContract,
  ZeroGeneratedDependencyPlan,
  ZeroGenerationTarget,
} from "@workspace/tenant-runtime-contracts";
import { isZeroProjectChoiceCaptureOnlyMessage } from "@workspace/ora-contracts";
import {
  isZeroSealedGenerationTarget,
  prepareZeroSealedNodeSource,
  ZERO_SEALED_NODE_PROMPT_EXTENSION,
} from "./zero-sealed-generation";
import {
  assertZeroGeneratedEligibility,
  inferZeroDeclaredCapabilities,
  ZeroCapabilityGapError,
} from "./zero-capability-eligibility";

/**
 * Sanitises an AI-generated summary so the chat always shows human-readable
 * prose rather than raw code. If the returned string looks like source code,
 * the fallback message is used instead.
 */
function cleanSummary(raw: string | undefined | null, fallback: string): string {
  if (!raw || raw.trim().length < 5) return fallback;
  const codeSignals = [
    /\bfunction\s*\w*\s*\(/, // function declarations
    /\b(const|let|var)\s+\w+\s*=/, // variable declarations
    /document\.\w+\(/, // DOM calls
    /getElementById|querySelector/, // DOM selectors
    /addEventListener\s*\(/, // event listeners
    /;\s*\n/, // statement-ending semicolons
    /\}\s*\n\s*\{/, // back-to-back code blocks
    /import\s+[\w{].*from\s+['"]/, // ES import statements
    /^\s*(<!DOCTYPE|<html|<head|<body)/m, // raw HTML tags
    /\\n\s{2,}/, // literally-escaped newlines (AI double-escaped JSON)
  ];
  if (codeSignals.some((pattern) => pattern.test(raw))) return fallback;
  return raw.trim();
}

const MODEL_FOR_MODE: Record<AgentMode, string> = {
  lite: "gpt-5-nano",
  eco: "gpt-5-mini",
  power: "gpt-5.4",
  pro: "gpt-5.4",
};

const CONVERSE_MAX_COMPLETION_TOKENS = 4_096;

const MODE_QUALITY_STANDARDS: Record<AgentMode, string> = {
  lite: `QUALITY STANDARD — Lite (quick fix):
Produce the smallest correct change. Fix the specific issue described. Do not add unrequested features. Use correct types for any new variables. Avoid introducing new dependencies. Output must be immediately runnable.`,

  eco: `QUALITY STANDARD — Eco (everyday dev):
Write clean, readable, idiomatic code. Use TypeScript types for all new interfaces and function signatures. Handle the happy path and common error cases (null checks, empty arrays, failed fetches). Follow existing naming and file conventions in the project. No over-engineering.`,

  power: `QUALITY STANDARD — Power (production-grade):
Write production-ready code. Full TypeScript types — no \`any\`. Comprehensive error handling: network failures, validation errors, empty/null states, and edge cases all handled explicitly. Accessible UI: WCAG AA contrast, semantic HTML, aria-labels, keyboard navigation. Structured code: separation of concerns, no magic numbers, consistent patterns throughout. Loading and empty states for every async operation.`,

  pro: `QUALITY STANDARD — Pro (complex systems):
Security-first: sanitise all user inputs, follow OWASP patterns, never expose secrets, validate on both client and server, use parameterised queries. Full TypeScript strict mode: no implicit any, exhaustive union handling, typed errors. Architectural clarity: clear module boundaries, single-responsibility functions, documented public APIs (JSDoc). Performance-aware: lazy loading, memoize expensive computations, avoid N+1 query patterns. WCAG AA throughout. Long-term maintainability: named constants, no magic strings, composable abstractions.`,
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
  /** Present only for the deployment-locked Cloudflare staging generator path. */
  sealedGeneration?: {
    dependencyPlan: ZeroGeneratedDependencyPlan;
    manifest: RuntimeManifestContract;
  };
};

export interface BuilderModelAdapter {
  complete(input: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    label: string;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>>;
}

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

export type ValidationResult = {
  passed: boolean;
  criticalErrors: string[];
  warnings: string[];
};

const CODE_QUALITY_RULES = `CODE QUALITY RULES — apply to every new build. In CHANGE MODE, apply them to new or directly changed code; the minimum-diff discipline takes precedence over cleanup of unrelated existing code:

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

const REFINE_BIAS_TO_ACTION = `BIAS TO ACTION — this is a CHANGE request, not a discussion:
- The user expects file modifications. Default to making changes, not explaining why none are needed.
- When the user says "fix", "change", "add", "update", "make", or describes a problem with the app, you MUST return at least one modified file in the "files" array. Do NOT respond with an empty "files" array plus an apology.
- If a reported error is from external infrastructure (third-party API outage, browser warning unrelated to the codebase, native device behaviour that requires a real device, etc.), you may return zero file changes — but ONLY if you ALSO:
    1. Set "summary" to clearly state what you did NOT change and exactly why ("I did not modify any files because the error originated from the OpenAI API, not your code.").
    2. Provide a concrete next step the user can take in "nextRecommendation" (rephrase, share the failing input, configure a secret, etc.).
- If the user's intent is ambiguous, make your best interpretation and ship a change — do not refuse. The user can always rollback to the previous version.
- Never claim "your app is already up to date" unless you genuinely inspected every relevant file and confirmed no change is warranted.

MINIMUM-DIFF DISCIPLINE — the requested scope is a contract:
- Preserve all content, structure, styling, and behavior unrelated to the requested change.
- For a local correction, do not rewrite, restyle, reorganize, add meta tags or scripts, or otherwise "improve" unrelated existing code merely to satisfy general build-quality guidance.
- Apply quality and safety rules to the code you add or directly change. Expand the change only when that is required to keep the requested behavior working or safe, and explain that necessity in the summary.

PROACTIVE DIAGNOSIS — when the user reports a symptom without naming the cause:
- Phrases like "the app is not running", "it's broken", "something is wrong", "there's a bug", "it's not loading", "nothing happens", "the button doesn't work", "I see an error" are fix requests. Do NOT ask the user to describe the problem in more detail.
- Instead: READ every file in the provided file list, IDENTIFY the specific root cause (broken JS reference, missing handler, syntax error, wrong selector, broken CDN URL, logic error, etc.), and FIX it.
- State clearly in your "summary" what the specific problem was and what you changed to resolve it — e.g. "Found an unclosed function in script.js that caused the page to crash on load. Fixed the syntax error at line 47."
- If you inspect the files and genuinely find nothing wrong, set "files" to [] but explain in "summary" exactly what you checked and why it appears correct, then suggest what the user can try next.`;

const REFINE_SCOPE_CLOSER = `FINAL CHANGE-SCOPE OVERRIDE — follow this after every general quality or stack rule above:
- Make the smallest complete change that satisfies the user's request.
- Existing code outside that change is not a request for cleanup. Preserve it byte-for-byte whenever possible.
- For a local correction such as copy, a selector, a value, or one handler, do not add unrelated markup, metadata, styling, dependencies, scripts, validation, or features.
- An "always" or "required" build rule applies to newly created code, not unrelated legacy code in a refinement. Expand scope only when the requested change cannot work safely without it.
- Before responding, compare the proposed result with the supplied original and remove every difference that is not required by the request. Never describe unrelated cleanup in the summary.`;

const PREVIEW_NOTE = `IMPORTANT preview-runtime constraints:
- This is a static preview. Generate only safe, self-contained files: HTML, CSS, vanilla JS (or React via CDN inside <script type="text/babel">), images via public CDNs.
- ALWAYS produce an index.html. Multi-page apps use additional .html files with relative links (e.g. <a href="./about.html">).
- Use Tailwind via the CDN: <script src="https://cdn.tailwindcss.com"></script>. Do NOT reference node_modules, npm packages, or build tools.
- Use lucide icons via CDN if you need icons: <script src="https://unpkg.com/lucide@latest"></script>.
- All <img> src must be absolute https URLs (use https://images.unsplash.com/... or https://picsum.photos/...). Never reference local image files.
- Keep total output under 32,000 characters across all files combined. Pages should be polished and complete — use the full budget freely for rich, high-quality UIs.
- Forms should validate client-side and show a friendly success state — do NOT post to real servers.
- Do not use emojis in copy. Use lucide icons via class="lucide" or inline SVG instead.

INTERACTIVITY — every visible interactive element MUST respond to clicks (this is the #1 complaint):
- Every <button> MUST have an onclick handler. A button with no handler is a bug — never ship one.
- Toggles, accordions, modals, dropdowns, and tabs MUST work via inline JavaScript (vanilla classList.toggle / style.display — no framework needed).
- For actions that require a real backend (save, submit, fetch from API): show an immediate visual feedback state — a brief loading indicator, then a realistic success state with plausible mock data. Do NOT leave the button silent.
- Multi-page navigation: use relative <a href="./page.html"> links — they work in the static preview.
- Inline this helper at the end of <body> so you can wire any button with data-action="description":
  <script>
  document.addEventListener('click',function(e){
    var el=e.target.closest('[data-action]');
    if(!el)return;
    var msg=el.getAttribute('data-action');
    var toast=document.getElementById('_toast');
    if(!toast){toast=document.createElement('div');toast.id='_toast';toast.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#18181b;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:9999;pointer-events:none;transition:opacity .3s';document.body.appendChild(toast);}
    toast.textContent=msg;toast.style.opacity='1';
    clearTimeout(toast._t);toast._t=setTimeout(function(){toast.style.opacity='0';},2000);
  });
  </script>

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

DATE / TIME LIBRARIES:
- NEVER use Moment.js — it is End of Life and will not receive security fixes.
- For date formatting and manipulation, use native JavaScript (Intl.DateTimeFormat, Date methods) — no CDN needed.
- If a CDN date library is genuinely needed, use Luxon: <script src="https://cdn.jsdelivr.net/npm/luxon@3/build/global/luxon.min.js"></script>
- Alternatively, use date-fns via CDN: <script src="https://cdn.jsdelivr.net/npm/date-fns@3/cdn.min.js"></script>

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

export const BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder. You generate complete, beautiful, working web projects from a single user request. You speak no prose in this mode — your only output is valid JSON.

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
  "summary": "One or two plain-English sentences describing what was built — e.g. 'Built a recipe tracker with a home page, ingredient search, and a recipe detail view.' No code, no file names — write what the user will see when they open the preview.",
  "warnings": string[],
  "nextRecommendation": string
}

The "files" array must contain every file needed. Always include "index.html" as path. CSS/JS files are optional; inline is fine.`;

export const REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder, in CHANGE MODE. You receive the current project files and a change request. You modify the affected files and return the FULL updated file contents.

${REFINE_BIAS_TO_ACTION}

For a localised change in a file of ANY size, use a "patches" entry rather than rewriting the whole file whenever the existing text is unique. Each patch has: { "path": string, "find": string, "replace": string } where "find" is a unique excerpt from the file and "replace" is the new content that should replace it. For an exact copy, selector, or value correction, this surgical patch is REQUIRED: return the unchanged full file only through the patch result, and do not also include that path in "files".

EXACT-CORRECTION EXAMPLE — if the supplied file contains \`<h1>Wlcome</h1>\` and the user asks to fix that typo, the only acceptable content change is \`{"path":"index.html","find":"Wlcome","replace":"Welcome"}\` in "patches", with "files": []. Rewriting the document, adding head metadata, or changing any other byte is incorrect.

${PREVIEW_NOTE}

${CODE_QUALITY_RULES}

${REFINE_SCOPE_CLOSER}

OUTPUT STRICT JSON matching this exact shape:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "patches": [{ "path": string, "find": string, "replace": string }],
  "filesRemoved": string[],
  "unchangedFiles": string[],
  "summary": "One or two plain-English sentences describing what changed — e.g. 'Added a mobile-friendly hamburger menu and improved button contrast throughout the app.' No code, no file names.",
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nextRecommendation": string
}

The "files" array should contain ONLY the files that were created or changed (full new content). The "patches" array is optional — use it for large files where only a section changes. The "filesRemoved" array lists files to delete. The "unchangedFiles" array MUST list every filename you are deliberately not touching — this allows the system to skip regenerating those files. Do NOT echo files that are unchanged in the "files" array.`;

export const PLAN_SYSTEM_PROMPT = `You are the NabuFlow Planner. You do NOT generate code in this mode. You output a comprehensive, structured plan as STRICT JSON only.

OUTPUT STRICT JSON matching this exact shape:
{
  "summary": string,
  "goal": string,
  "approach": string,
  "sitemap": [{ "name": string, "route": string, "purpose": string }],
  "pages": string[],
  "fileTree": [{ "path": string, "description": string }],
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
- "fileTree" lists the actual files/components the build will produce (e.g. [{"path":"src/components/Header.tsx","description":"Site header with nav links"}]). Include at minimum the key React components, pages, and config files. Empty array for trivial single-page apps.
- "dataModel" only if the app stores data (even localStorage counts). Empty array otherwise.
- "apiEndpoints" only if the app calls external APIs or needs a backend. Empty array otherwise.
- "uxNotes" must have one entry per page in "sitemap" with 1-3 sentences of UX guidance.
- "accessibilityNotes" is a brief string summarising keyboard, contrast, and ARIA considerations.
- "complexityScore" must be an integer 1-10. Consider pages, data model, integrations, and interactivity.
- "recommendedMode" must be one of: lite (score 1-2), eco (score 3-4), power (score 5-7), pro (score 8-10).
- "estimatedBuildSeconds" is a realistic estimate: simple apps ~20s, medium ~40s, complex ~80s.
- Be concrete and specific. Empty arrays for sections that don't apply.`;

// ─────────────────────────────────────────────────────────────────────────────
// React + Vite builder prompts
// ─────────────────────────────────────────────────────────────────────────────

const REACT_VITE_BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder. You generate complete, production-ready React + Vite web applications. Your only output is valid JSON — no prose.

TECH STACK — use exactly:
- React 18 + TypeScript 5
- Vite 5 as the build tool
- Tailwind CSS v3 (via PostCSS — NOT a CDN)
- lucide-react for all icons (no emojis anywhere)
- react-router-dom v6 for multi-page routing

REQUIRED PROJECT STRUCTURE — always include ALL of these files:
- package.json (name, version, scripts: dev/build/preview, dependencies, devDependencies)
- vite.config.ts (with @vitejs/plugin-react)
- tailwind.config.js (content: ["./index.html","./src/**/*.{ts,tsx}"])
- postcss.config.js ({ plugins: { tailwindcss: {}, autoprefixer: {} } })
- index.html (Vite root HTML with <script type="module" src="/src/main.tsx"></script>)
- src/main.tsx (React entry: createRoot + StrictMode)
- src/App.tsx (root component with router if multi-page)
- src/index.css (Tailwind directives: @tailwind base; @tailwind components; @tailwind utilities;)

ADDITIONAL FILES (as needed):
- src/components/*.tsx — shared UI components (one per file, named export)
- src/pages/*.tsx — page-level components (one per file, default export)
- src/types/*.ts — shared TypeScript types
- src/lib/utils.ts — utility functions (include cn() helper using clsx + tailwind-merge)
- src/hooks/*.ts — custom React hooks

CODE RULES:
- TypeScript throughout — no .js files except config files that require it
- Use proper TypeScript types — never use "any" or "unknown" unless unavoidable
- All React components must be functional with typed props
- Named exports for components; default export for page components
- Use Tailwind utility classes exclusively — no inline styles, no custom CSS unless absolutely necessary
- Never hardcode secrets — use import.meta.env.VITE_* environment variables
- Responsive design using Tailwind breakpoints (mobile-first)
- Semantic HTML with proper accessibility (aria-label, role attributes, alt text)
- Error boundaries or loading states for async operations
- Dark-mode friendly color palette using Tailwind slate/zinc/gray

DEPENDENCIES to include in package.json:
{
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2",
    "lucide-react": "^0.447.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.3"
  },
  "devDependencies": {
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.2",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3",
    "vite": "^5.4.9"
  }
}
Add any extra domain-specific packages the app genuinely needs (e.g. recharts for charts, date-fns for dates, zod for validation).

OUTPUT STRICT JSON:
{
  "blueprint": {
    "projectName": string,
    "projectType": string,
    "targetPlatforms": ["web"],
    "pages": [{ "name": string, "route": string }],
    "components": string[],
    "data": string[],
    "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
    "theme": string
  },
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "summary": "One or two plain-English sentences describing what was built — e.g. 'Built a recipe tracker with a home page, ingredient search, and a detail view.' No code, no file paths — describe what the user will see.",
  "warnings": string[],
  "nextRecommendation": string
}

MIME types: .ts/.tsx → "application/typescript", .json → "application/json", .js → "application/javascript", .html → "text/html", .css → "text/css"
The "files" array MUST include every file in the project. package.json, vite.config.ts, index.html, src/main.tsx, src/App.tsx, and src/index.css are REQUIRED.`;

const REACT_VITE_REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder, in CHANGE MODE for a React + Vite project. You receive the current project files and a change request. Return ONLY files that changed (full new content for each changed file).

${REFINE_BIAS_TO_ACTION}

TECH STACK: React 18 + TypeScript + Vite 5 + Tailwind CSS v3 + lucide-react

RULES:
- TypeScript throughout (.ts / .tsx)
- Tailwind utility classes — no custom CSS unless absolutely required
- Maintain the established project structure (src/components/, src/pages/, src/lib/, etc.)
- Never hardcode secrets — use import.meta.env.VITE_* for env vars
- Do NOT remove or replace package.json, vite.config.ts, index.html, src/main.tsx, or src/index.css unless the user explicitly asked to change them
- If you add a new npm package, update package.json accordingly
- Use lucide-react for all icons — no emojis

${REFINE_SCOPE_CLOSER}

OUTPUT STRICT JSON:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "filesRemoved": string[],
  "unchangedFiles": string[],
  "summary": "One or two plain-English sentences describing what changed — e.g. 'Added a dark mode toggle and improved the navigation layout.' No code, no file paths.",
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nextRecommendation": string
}

"files" = ONLY files created or changed (full new content).
"unchangedFiles" = every path you deliberately did not touch (MUST list all untouched files — allows the system to skip regenerating them).
"filesRemoved" = paths to delete.`;

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
function scanFilesForCdnIssues(files: BuilderFile[]): NonNullable<TaskReport["securityNotices"]> {
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
async function runProPlanMicroCall(
  projectName: string,
  userPrompt: string,
  agentMode: AgentMode = "pro",
  deepReasoning = false,
): Promise<string> {
  try {
    const parsed = await runPlanningBrain<{
      files?: Array<{ path: string; responsibility: string }>;
    }>({
      entryPoint: "pro_micro",
      mode: agentMode,
      deepReasoning,
      systemPrompt:
        'You are a web app file planner. Output ONLY valid JSON with no prose: {"files": [{"path": string, "responsibility": string}]}. List every file the app needs with one sentence explaining its responsibility.',
      messages: [{ role: "user", content: `Project: "${projectName}". Request: ${userPrompt}` }],
      maxCompletionTokens: 600,
    });
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

  // Screen/route reference integrity — check that routes pushed in navigation code exist as files
  try {
    const appFiles = files.filter((f) => f.path.startsWith("app/") || f.path.startsWith("src/"));
    const allContent = appFiles.map((f) => f.content).join("\n");
    const filePaths = new Set(files.map((f) => f.path));

    // Extract route strings from Expo Router Link href, useRouter().push(), router.navigate() etc.
    const routePatterns = [
      /href=["']([a-z0-9/_-]+)["']/gi,
      /router\.(?:push|navigate|replace)\s*\(\s*["']([a-z0-9/_-]+)["']/gi,
      /useRouter\(\)\.(?:push|navigate)\s*\(\s*["']([a-z0-9/_-]+)["']/gi,
    ];
    const referencedRoutes = new Set<string>();
    for (const pattern of routePatterns) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(allContent)) !== null) {
        const route = (m[1] ?? "").replace(/^\//, "");
        if (route && !route.includes("http") && route.length > 0) {
          referencedRoutes.add(route);
        }
      }
    }

    // For each referenced route, check that a corresponding screen file exists
    for (const route of referencedRoutes) {
      const candidates = [
        `app/${route}.tsx`,
        `app/${route}.ts`,
        `app/${route}/index.tsx`,
        `app/${route}/index.ts`,
        `src/screens/${route}.tsx`,
      ];
      const exists = candidates.some((c) => filePaths.has(c));
      if (!exists) {
        warnings.push(
          `Mobile: route "/${route}" is referenced in navigation code but no matching screen file found (checked ${candidates[0]}, ${candidates[2]})`,
        );
      }
    }
  } catch {
    // best-effort — never block a build
  }

  return { passed: criticalErrors.length === 0, criticalErrors, warnings };
}

/**
 * Structural validator for web (static HTML/CSS/JS) projects.
 * Runs BEFORE file commit — complements the per-file validateFiles checks with
 * project-level checks: index.html existence, local file reference integrity,
 * Tailwind/Lucide CDN presence when used, and truncation heuristics.
 * Synchronous — no network I/O.
 */
export function validateWebStructure(files: BuilderFile[]): ValidationResult {
  const criticalErrors: string[] = [];
  const warnings: string[] = [];
  const filePaths = new Set(files.map((f) => f.path));

  // 1. index.html must exist
  if (!filePaths.has("index.html")) {
    criticalErrors.push(
      "Missing index.html — all web projects must have an index.html entry point",
    );
  }

  const htmlFiles = files.filter(
    (f) => f.mimeType === "text/html" || f.path.endsWith(".html") || f.path.endsWith(".htm"),
  );

  for (const f of htmlFiles) {
    const c = f.content;

    // 2. Truncation heuristic — no closing </body> or </html> near the end
    if (c.length > 300) {
      const tail = c.slice(-600);
      const hasClosingHtml = /<\/html\s*>/i.test(tail);
      const hasClosingBody = /<\/body\s*>/i.test(tail);
      if (!hasClosingHtml && !hasClosingBody) {
        criticalErrors.push(
          `${f.path}: Content appears truncated — missing closing </body> and </html> tags`,
        );
      }
    }

    // 3. Tailwind CDN — if Tailwind utility classes are used but no CDN script is present
    const hasTailwindClasses =
      /class="[^"]*(?:flex|grid|p-\d|m-\d|text-(?:sm|base|lg|xl|2xl|3xl)|bg-|border-|rounded|w-\d|h-\d|gap-\d)[^"]*"/i.test(
        c,
      );
    const hasTailwindCdn = /cdn\.tailwindcss\.com|tailwindcss@/i.test(c);
    if (hasTailwindClasses && !hasTailwindCdn) {
      criticalErrors.push(
        `${f.path}: Tailwind utility classes detected but no Tailwind CDN script found — add <script src="https://cdn.tailwindcss.com"></script> to <head>`,
      );
    }

    // 4. Lucide CDN — if lucide icons are used but no CDN script is present
    const hasLucideUsage = /data-lucide=|class="lucide|lucide\./i.test(c);
    const hasLucideCdn = /unpkg\.com\/lucide/i.test(c);
    if (hasLucideUsage && !hasLucideCdn) {
      warnings.push(
        `${f.path}: Lucide icons referenced but no Lucide CDN script found — add <script src="https://unpkg.com/lucide@latest"></script>`,
      );
    }

    // 5. Local file reference integrity — local src/href must point to files in the generated set
    const localSrcs = [...c.matchAll(/src="(?!https?:\/\/)(?!data:)(?!\/\/)([^"#?]+)"/gi)].map(
      (m) => m[1]!,
    );
    const localHrefs = [
      ...c.matchAll(
        /href="(?!https?:\/\/)(?!#)(?!mailto:)(?!tel:)(?!javascript:)([^"#?]+\.(?:html|css|js|svg|png|jpg|gif|ico|webp|woff|woff2|ttf|json))"/gi,
      ),
    ].map((m) => m[1]!);

    // HTML file's directory (empty string for root-level files)
    const htmlDir = f.path.includes("/") ? f.path.replace(/\/[^/]+$/, "") : "";

    for (const ref of [...localSrcs, ...localHrefs]) {
      if (ref.length === 0 || ref.includes("//")) continue;
      if (ref.startsWith("_mocks/")) continue;

      let resolvedPath: string;
      if (ref.startsWith("/")) {
        // Absolute-from-root reference — strip leading slash
        resolvedPath = ref.slice(1);
      } else {
        // Relative reference — resolve against the HTML file's directory
        const base = htmlDir ? htmlDir + "/" : "";
        const raw = ref.startsWith("./") ? ref.slice(2) : ref;
        const parts = (base + raw).split("/");
        const resolved: string[] = [];
        for (const p of parts) {
          if (p === "..") resolved.pop();
          else if (p !== "." && p !== "") resolved.push(p);
        }
        resolvedPath = resolved.join("/");
      }

      if (resolvedPath.length === 0) continue;
      if (!filePaths.has(resolvedPath)) {
        criticalErrors.push(
          `${f.path}: References local file "${ref}" which is not in the generated file set`,
        );
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
    const descTag = `<meta name="description" content="Built with NabuFlow — ${safeDesc}">`;
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
    re: /s[k]_live_[A-Za-z0-9]{24,}/g,
    category: "Stripe live secret key",
    redact: "[REDACTED:stripe-secret]",
  },
  {
    re: /s[k]_test_[A-Za-z0-9]{24,}/g,
    category: "Stripe test secret key",
    redact: "[REDACTED:stripe-secret]",
  },
  {
    re: /pk_live_[A-Za-z0-9]{24,}/g,
    category: "Stripe live publishable key",
    redact: "[REDACTED:stripe-pk]",
  },
  {
    re: /r[k]_live_[A-Za-z0-9]{24,}/g,
    category: "Stripe live restricted key",
    redact: "[REDACTED:stripe-rk]",
  },
  {
    re: /r[k]_test_[A-Za-z0-9]{24,}/g,
    category: "Stripe test restricted key",
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

export interface BuilderImageAttachment {
  dataUri: string;
  alt?: string;
}

/**
 * Run a structured layout analysis on user-attached images before the build
 * or refine pipeline starts. The result is a short, plain-text description
 * (overall layout, components, colours, text, suspected intent) that the
 * downstream pipeline injects into its prompt so even non-vision callers
 * (and the structured-JSON build prompt) can ground their output in what
 * the user actually dropped in.
 *
 * Best-effort: returns null on failure so the caller can fall back to the
 * existing multimodal image_url path without aborting the job.
 */
export async function analyzeImagesToLayout(
  imageAttachments: BuilderImageAttachment[],
  signal?: AbortSignal,
): Promise<string | null> {
  if (!imageAttachments || imageAttachments.length === 0) return null;
  try {
    const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
    // Route via the existing "plan" stage at agentMode=lite — cheap, vision-capable.
    const { provider, model } = resolveStageProvider("plan", "lite", "gpt-5-nano");

    const parts: Array<
      { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
    > = [
      {
        type: "text",
        text: `Analyse the attached screenshot(s) or mockup(s) as a layout brief for an app builder.
For each image, describe:
  • Overall layout structure (header / nav / hero / grid / sidebar / footer / modal etc.)
  • Visible UI components (buttons, forms, cards, tables, charts, lists, images)
  • Text content and headings (copy verbatim where short)
  • Colour palette (background, primary, accent, text — name approximate hex if obvious)
  • Typography feel (serif/sans, weight, size hierarchy)
  • Likely user intent (what kind of app/page this represents)

Return ONE plain-text brief (no markdown headings, no JSON). Be specific and short — aim for 120–250 words total across all images. Use a "Image N:" prefix when there are multiple.`,
      },
    ];
    for (const att of imageAttachments) {
      parts.push({ type: "image_url", image_url: { url: att.dataUri } });
    }

    const resp = await createChatCompletion({
      provider,
      model,
      zeroCall: { tier: "lite", stage: "plan" },
      max_completion_tokens: 800,
      messages: [
        {
          role: "system",
          content:
            "You are a UI analyst. You produce concise, factual layout briefs from screenshots so a downstream code generator can rebuild what the user is showing. Never invent details that aren't visible.",
        },
        // Cast at this single boundary — Chat Completions accepts content parts arrays.
        { role: "user", content: parts as unknown as string },
      ],
      signal,
    });
    const text = resp.choices[0]?.message?.content?.trim() ?? "";
    if (!text) return null;
    // Trim to a hard ceiling so we don't blow the downstream prompt budget.
    return text.length > 2400 ? text.slice(0, 2400) + "…" : text;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "analyzeImagesToLayout failed — falling back to multimodal-only path",
    );
    return null;
  }
}

/**
 * Append a user-role message to the messages array. If image attachments are
 * provided, sends the prompt + images as multimodal content parts so vision
 * models can actually read uploaded screenshots/mockups.
 */
function pushUserMessageWithImages(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  userPrompt: string,
  imageAttachments?: BuilderImageAttachment[],
): void {
  if (!imageAttachments || imageAttachments.length === 0) {
    messages.push({ role: "user", content: userPrompt });
    return;
  }
  const parts: Array<
    { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  > = [
    {
      type: "text",
      text:
        userPrompt +
        "\n\n[The user has attached " +
        imageAttachments.length +
        " image(s) above. Carefully look at each image, identify the visible UI elements, layout, colours, text, and any errors or issues shown, and use that to inform what you build or fix.]",
    },
  ];
  for (const att of imageAttachments) {
    parts.push({ type: "image_url", image_url: { url: att.dataUri } });
  }
  // OpenAI Chat Completions accepts arrays of content parts on user messages.
  // Our local message type is narrowed to `string`; cast at this single boundary.
  messages.push({
    role: "user",
    content: parts as unknown as string,
  });
}

async function callWithRetry(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  model: string,
  maxTokens: number,
  label: string,
  signal?: AbortSignal,
  // Stage drives per-stage provider routing (Task #533). Defaults to "build"
  // so legacy callers that don't know their stage keep working unchanged.
  stage: "build" | "refine" | "plan" = "build",
  agentMode: AgentMode = "power",
  taskId?: number,
  taskMode?: string,
): Promise<Record<string, unknown>> {
  let lastError: Error = new Error("Unknown error");

  const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
  // `model` is the legacy hardcoded OpenAI model for this pipeline — pass it
  // as the openaiOverride so an `AI_PROVIDER_*=openai:<model>` env wins, but
  // an unset env still uses the pipeline's historical OpenAI default.
  const { provider, model: effectiveModel } = resolveStageProvider(stage, agentMode, model);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new Error("Build cancelled");
    try {
      const response = await createChatCompletion({
        provider,
        model: effectiveModel,
        zeroCall: { tier: agentMode, stage },
        max_completion_tokens: maxTokens,
        messages,
        response_format: { type: "json_object" },
        signal,
        taskId,
        taskMode,
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
      if (apiErr instanceof Error && (apiErr.name === "AbortError" || signal?.aborted)) {
        throw new Error("Build cancelled", { cause: apiErr });
      }
      lastError = apiErr instanceof Error ? apiErr : new Error(String(apiErr));
      logger.error({ err: apiErr, attempt, label }, "OpenAI API call failed");
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }

  throw lastError;
}

/**
 * Stream a code-generation call token-by-token, accumulating the full text
 * for post-stream JSON parsing.  Calls `onToken` for every incoming delta so
 * the SSE channel can relay them to the frontend as a live typing effect.
 *
 * Strips markdown code fences from the accumulated text before parsing.
 * Falls back to the non-streaming `callWithRetry` (JSON-mode) if the stream
 * fails or the accumulated text is not valid JSON.
 */
async function streamAndAccumulate(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  model: string,
  maxTokens: number,
  label: string,
  signal: AbortSignal | undefined,
  stage: "build" | "refine" | "plan",
  agentMode: AgentMode,
  onToken?: (delta: string) => void,
  taskId?: number,
  taskMode?: string,
): Promise<Record<string, unknown>> {
  const { streamChatCompletion, resolveStageProvider } = await import("./ai-providers");
  const { provider, model: effectiveModel } = resolveStageProvider(stage, agentMode, model);

  let accumulated = "";
  try {
    for await (const delta of streamChatCompletion({
      provider,
      model: effectiveModel,
      zeroCall: { tier: agentMode, stage },
      max_completion_tokens: maxTokens,
      messages: messages as Parameters<typeof streamChatCompletion>[0]["messages"],
      signal,
      // NabuFlow R2 Phase D: pass task context so each streaming call
      // accumulates its token counts for the telemetry table.
      taskId,
      taskMode,
    })) {
      if (signal?.aborted) throw new Error("Build cancelled");
      accumulated += delta;
      onToken?.(delta);
    }
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || err.message === "Build cancelled" || signal?.aborted)
    ) {
      throw new Error("Build cancelled", { cause: err });
    }
    logger.warn({ err, label }, "Streaming failed — falling back to batch completion");
    return callWithRetry(
      messages,
      model,
      maxTokens,
      label,
      signal,
      stage,
      agentMode,
      taskId,
      taskMode,
    );
  }

  const stripped = accumulated
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    logger.warn(
      { label, preview: accumulated.slice(0, 200) },
      "Streamed JSON parse failed — falling back to batch completion",
    );
    return callWithRetry(
      messages,
      model,
      maxTokens,
      label,
      signal,
      stage,
      agentMode,
      taskId,
      taskMode,
    );
  }
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
  signal?: AbortSignal,
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
    const corrected = await callWithRetry(correctionMessages, modelFor(mode), 32000, label, signal);
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
// Critique Pass — Power/Pro only
// A second-opinion AI call that reviews the generated output holistically
// against the original request, even when structural validation passes.
// Returns the issues found and a patched file set (or null if no changes needed).
// ─────────────────────────────────────────────────────────────────────────────

const CRITIQUE_SYSTEM_PROMPT = `You are a senior QA engineer reviewing AI-generated web app files before they ship to users.
Your job is to identify REAL functional problems — not stylistic preferences.

Review the generated files against the original user request and any validator findings.
Focus on:
1. Features explicitly requested by the user that are missing or broken
2. Navigation links that go nowhere (href="#" with no handler, missing pages)
3. Forms with no submit logic or no user feedback on submit
4. Buttons or interactive elements with no event handler
5. JavaScript that calls functions or uses variables that are not defined
6. Pages that are completely empty or contain only placeholder content when real content was requested
7. Critical validator errors that were not resolved in the file set

OUTPUT STRICT JSON matching this exact shape:
{
  "verdict": "ok" | "issues_found",
  "issues": string[],
  "files": [{ "path": string, "content": string, "mimeType": string }]
}

Rules:
- "verdict" is "ok" if the app is functionally complete for the user's request; "issues_found" otherwise
- "issues" must be SPECIFIC: "Login button has no click handler" not "buttons need work" — empty array if verdict is "ok"
- "files" must contain ONLY the files that genuinely need changes (full corrected content) — empty array if verdict is "ok" or no changes are needed
- Do NOT return files you did not change — only return files with real fixes applied
- Do NOT flag style preferences, minor wording differences, or non-blocking cosmetic issues
- If the app works as the user requested, always return verdict: "ok" — do not manufacture issues`;

const MOBILE_CRITIQUE_SYSTEM_PROMPT = `You are a senior mobile QA engineer reviewing AI-generated Expo / React Native files before they ship to users.
Your job is to identify REAL functional problems — not stylistic preferences.

Review the generated files against the original user request and any validator findings.
Focus on:
1. Features explicitly requested by the user that are missing or broken
2. Expo Router file structure: every screen referenced in navigation must exist as a route file under app/ (e.g. app/index.tsx, app/(tabs)/_layout.tsx, app/profile.tsx). Tab/stack layouts (_layout.tsx) must wrap the right routes.
3. Screen navigation: router.push/router.replace/Link href targets must point at routes that actually exist in the file tree. Tab bar items must match real route files.
4. NativeWind / Tailwind class validity: className strings must use real Tailwind utility classes (no made-up tokens). Color tokens, spacing, and flex utilities must be valid. No HTML-only classes (like "block", "inline") that don't apply on React Native.
5. Buttons / Pressables / TouchableOpacity with no onPress handler when the screen clearly needs interaction
6. Forms with no submit logic or no user feedback on submit
7. JavaScript/TypeScript that references undefined functions, hooks, or imports — including missing imports from "expo-router", "react-native", or "nativewind"
8. Screens that are completely empty or contain only placeholder content when real content was requested
9. Critical validator errors that were not resolved in the file set
10. index.html web-preview interactivity: every visible <button> and role="button" element MUST either have a real JS onclick handler OR a data-mock="..." attribute. (Anchor tags with a non-empty href="..." count as a real handler via native navigation — do not flag those.) A button with neither is a bug — users see "the preview is broken". Verify the mockAction helper script + #mock-toast element are present in index.html.
11. User-request coverage: walk the original user request line by line. For each concrete feature the user named (e.g. "login screen", "camera scanner", "save to favorites", "checkout flow"), verify there is a corresponding screen file under app/ AND a matching visible affordance in index.html. Missing coverage IS an issue_found.

Do NOT flag:
- Web-only concerns (HTML semantics, CSS specificity, document.querySelector, etc.) — this is React Native
- Style preferences, minor wording differences, or non-blocking cosmetic issues
- Missing native module config that the build pipeline auto-wires (e.g. package.json deps for detected modules)

OUTPUT STRICT JSON matching this exact shape:
{
  "verdict": "ok" | "issues_found",
  "issues": string[],
  "files": [{ "path": string, "content": string, "mimeType": string }]
}

Rules:
- "verdict" is "ok" if the app is functionally complete for the user's request; "issues_found" otherwise
- "issues" must be SPECIFIC: "Tab bar links to /settings but app/settings.tsx is missing" not "navigation needs work" — empty array if verdict is "ok"
- "files" must contain ONLY the files that genuinely need changes (full corrected content) — empty array if verdict is "ok" or no changes are needed
- Do NOT return files you did not change — only return files with real fixes applied
- If the app works as the user requested, always return verdict: "ok" — do not manufacture issues`;

/**
 * Power/Pro critique pass — holistic AI review of generated output against the user request.
 * Called after structural validation (and any correction pass) for Power/Pro builds.
 * For Lite/Eco, skipped entirely to keep costs down.
 *
 * Returns:
 *   issues    — human-readable list of problems found (may be empty)
 *   fixedFiles — merged file set with critique patches applied, or null if no changes needed
 */
async function runCritiquePass(
  originalMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  files: BuilderFile[],
  userPrompt: string,
  validatorIssues: string[],
  mode: AgentMode,
  label: string,
  systemPrompt: string = CRITIQUE_SYSTEM_PROMPT,
): Promise<{
  issues: string[];
  fixedFiles: BuilderFile[] | null;
  critiqueFailed?: boolean;
  critiqueFailureReason?: string;
}> {
  try {
    // Build a compact manifest for the critique.
    // Hard cap at 10k chars — keeps total prompt under ~12k chars so Anthropic
    // streaming-accumulation path kicks in reliably and the response stays within
    // the 10k max_tokens output budget. (makeCompactManifest already smart-truncates
    // above 20k; this is a secondary safety cap on the final string.)
    const manifest = makeCompactManifest(files);
    const manifestTruncated =
      manifest.length > 10000
        ? manifest.slice(0, 10000) + "\n…(file manifest truncated for review)"
        : manifest;

    const issueBlock =
      validatorIssues.length > 0
        ? `\n\nStructural validator found these issues in the file set:\n${validatorIssues.map((e) => `- ${e}`).join("\n")}`
        : "";

    const critiqueMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `Original user request: "${userPrompt}"\n\nGenerated files to review:\n${manifestTruncated}${issueBlock}\n\nReview the generated files for functional problems. Return JSON as instructed.`,
      },
    ];

    // Explicit 90-second timeout per critique call.
    // This keeps us well under the stuck-run-scheduler's 5-minute kill and
    // ensures a clear AbortError rather than a silent 10-minute hang.
    const critiqueTimeoutSignal = AbortSignal.timeout(90_000);

    // Cap output tokens at 10k — critique JSON (issues list + patched files)
    // does not need the full 16k budget, and smaller budgets reduce latency.
    const corrected = await callWithRetry(
      critiqueMessages,
      modelFor(mode),
      10000,
      label,
      critiqueTimeoutSignal,
      "build",
      mode,
    );

    const verdict = typeof corrected.verdict === "string" ? corrected.verdict : "ok";
    const issues = Array.isArray(corrected.issues)
      ? corrected.issues.filter((i): i is string => typeof i === "string")
      : [];

    if (
      verdict !== "issues_found" ||
      !Array.isArray(corrected.files) ||
      (corrected.files as unknown[]).length === 0
    ) {
      if (issues.length > 0) {
        logger.info(
          { label, issueCount: issues.length },
          "Critique found issues but no file patches",
        );
      }
      return { issues, fixedFiles: null };
    }

    const rawFixed = corrected.files as Array<{
      path?: unknown;
      content?: unknown;
      mimeType?: unknown;
    }>;
    const fixedSubset = rawFixed
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

    if (fixedSubset.length === 0) {
      return { issues, fixedFiles: null };
    }

    // Merge corrected subset into the full file set — never drop uncorrected files
    const mergedMap = new Map(files.map((f) => [f.path, f]));
    for (const cf of fixedSubset) {
      mergedMap.set(cf.path, cf);
    }
    const mergedFiles = [...mergedMap.values()];

    logger.info(
      { label, issueCount: issues.length, fixedFileCount: fixedSubset.length },
      "Critique pass found and patched issues",
    );

    return { issues, fixedFiles: mergedFiles };
  } catch (err) {
    // Surface the failure instead of silently returning "no issues found".
    // This prevents critique failures from being indistinguishable from a clean
    // critique run, which would cause the task to incorrectly report success.
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        /timeout|timed out/i.test(err.message));
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, label, isTimeout },
      "Critique pass threw — surfacing as unavailable warning",
    );
    return { issues: [], fixedFiles: null, critiqueFailed: true, critiqueFailureReason: reason };
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

      const cdnUrls = [...extractAttr(f.content, "src"), ...extractAttr(f.content, "href")].filter(
        isCdn,
      );

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
  /** When set, the AI is instructed to generate real database-backed code using this provider. */
  databaseContext?: string;
  /** Structured plan from the Planning Agent — injected as a system message so the builder honours the plan exactly. */
  planContext?: Record<string, unknown> | null;
  /** Distilled summary of earlier conversation turns — gives the builder long-range context. */
  conversationSummary?: string;
  imageAttachments?: BuilderImageAttachment[];
  /** Task #743: skip service-worker / fetch mocks for agentic-mode projects (real containers handle backends). */
  builderMode?: string | null;
  onEvent?: (type: string, message: string) => Promise<void>;
  /** Called with each streamed token delta during the primary code-generation call. */
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
  /** NabuFlow R2 Phase D: task ID for per-build token telemetry accumulation. */
  taskId?: number;
  taskMode?: string;
}): Promise<BuilderResult> {
  const {
    projectName,
    projectKind,
    userPrompt,
    agentMode,
    conversationHistory,
    knowledgeContext,
    integrationContext,
    databaseContext,
    planContext,
    conversationSummary,
    imageAttachments,
    builderMode,
    onEvent,
    onToken,
    signal,
    taskId,
    taskMode,
  } = args;

  // ── Dev-only build stub ────────────────────────────────────────────────────
  // When DEV_SLOW_BUILD_DELAY_MS is set (and not in production) the pipeline
  // sleeps instead of calling the AI provider.  This lets e2e tests exercise
  // the full cancel flow — real DB rows, real SSE events — without burning
  // OpenAI credits.  The task is kept in "building" state for the duration so
  // the AbortController is registered before the test calls POST /cancel.
  if (process.env.NODE_ENV !== "production" && process.env.DEV_SLOW_BUILD_DELAY_MS) {
    const ms = Math.max(0, parseInt(process.env.DEV_SLOW_BUILD_DELAY_MS, 10) || 0);
    if (ms > 0) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Build cancelled"));
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Build cancelled"));
          },
          { once: true },
        );
      });
      return {
        blueprint: {
          projectName,
          projectType: "web",
          targetPlatforms: ["browser"],
          pages: [{ name: "Home", route: "/" }],
          components: [],
          integrationsNeeded: [],
        },
        files: [
          {
            path: "index.html",
            content: `<!DOCTYPE html><html><head><title>${projectName}</title></head><body><h1>${projectName}</h1></body></html>`,
            mimeType: "text/html",
          },
        ],
        report: {
          userRequest: userPrompt,
          filesCreated: ["index.html"],
          filesChanged: [],
          filesRemoved: [],
          previewUpdated: false,
          warnings: [],
          integrationsNeeded: [],
        },
        assistantSummary: "[dev-stub] Build completed (DEV_SLOW_BUILD_DELAY_MS was set).",
        correctionPasses: 0,
        correctionFailed: false,
        primaryErrorCategory: null,
      };
    }
  }

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
      content: knowledgeContext,
    });
  }

  if (conversationSummary) {
    messages.push({
      role: "system",
      content: `CONVERSATION CONTEXT — summary of earlier exchanges with the user:\n${conversationSummary}`,
    });
  }

  if (integrationContext) {
    messages.push({
      role: "system",
      content: integrationContext,
    });
  }

  if (databaseContext) {
    messages.push({ role: "system", content: databaseContext });
  }

  if (planContext) {
    const { sitemap, dataModel, integrations, goal, approach } = planContext as {
      sitemap?: Array<{ name: string; route: string; purpose: string }>;
      dataModel?: Array<{ table: string; fields: string[] }>;
      integrations?: string[];
      goal?: string;
      approach?: string;
    };
    const planLines: string[] = [
      "STRUCTURED PLAN from Planning Agent — follow this plan exactly when building:",
    ];
    if (goal) planLines.push(`Goal: ${goal}`);
    if (approach) planLines.push(`Approach: ${approach}`);
    if (sitemap && sitemap.length > 0) {
      planLines.push(
        `Pages/Routes:\n${sitemap.map((p) => `  • ${p.name} (${p.route}): ${p.purpose}`).join("\n")}`,
      );
    }
    if (dataModel && dataModel.length > 0) {
      planLines.push(
        `Data model:\n${dataModel.map((m) => `  • ${m.table}: ${m.fields.join(", ")}`).join("\n")}`,
      );
    }
    if (integrations && integrations.length > 0) {
      planLines.push(`Integrations: ${integrations.join(", ")}`);
    }
    messages.push({ role: "system", content: planLines.join("\n") });
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

  pushUserMessageWithImages(messages, userPrompt, imageAttachments);

  await onEvent?.("generating_code", "Generating app blueprint and code…");
  const parsed = await streamAndAccumulate(
    messages,
    modelFor(agentMode),
    32000,
    "build",
    signal,
    "build",
    agentMode,
    onToken,
    taskId,
    taskMode,
  );

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

  // Web structural validator — checks index.html, local refs, Tailwind/Lucide CDN, truncation
  const structuralValidation = validateWebStructure(files);
  if (!structuralValidation.passed) {
    logger.warn(
      { criticalErrors: structuralValidation.criticalErrors },
      "Web structural validator found critical errors",
    );
  }

  // Per-file self-validation pass (HTML parseability, JS syntax, CDN reachability, etc.)
  await onEvent?.("validating_output", "Validating generated files…");
  const perFileValidation = await validateFiles(files);

  // Merge structural + per-file validation results
  const allCriticalErrors = [
    ...structuralValidation.criticalErrors,
    ...perFileValidation.criticalErrors,
  ];
  const allValidationWarnings = [...structuralValidation.warnings, ...perFileValidation.warnings];
  const validationPassed = allCriticalErrors.length === 0;

  let correctionFailed = false;
  // eslint-disable-next-line no-useless-assignment
  let postCorrectionWarnings: string[] = [];

  if (!validationPassed) {
    logger.warn(
      { criticalErrors: allCriticalErrors },
      "Build validation found critical errors — running correction pass",
    );
    await onEvent?.(
      "validating_output",
      `Validation found ${allCriticalErrors.length} issue(s) — running correction…`,
    );

    const corrected = await runCorrectionPass(
      messages,
      parsed,
      allCriticalErrors,
      files,
      agentMode,
      "build-correction",
      true,
    );
    if (corrected !== null) {
      files = corrected;
      // Re-inject meta tags into corrected files
      files = files.map((f) => injectRequiredMetaTags(f, projectName));

      // Mandatory revalidation — verify the correction actually fixed the structural + per-file errors
      const revalidateStructural = validateWebStructure(files);
      const revalidatePerFile = await validateFiles(
        files.filter(
          (f) =>
            f.mimeType === "text/html" ||
            f.path.endsWith(".html") ||
            f.path.endsWith(".htm") ||
            f.mimeType === "application/javascript" ||
            f.mimeType === "text/javascript" ||
            f.path.endsWith(".js") ||
            f.path.endsWith(".mjs"),
        ),
      );
      const remainingCritical = [
        ...revalidateStructural.criticalErrors,
        ...revalidatePerFile.criticalErrors,
      ];
      if (remainingCritical.length > 0) {
        logger.warn(
          { remainingCritical },
          "Build revalidation after correction still has critical errors — marking failed",
        );
        correctionFailed = true;
        postCorrectionWarnings = remainingCritical.map((e) => `[validation_failed] ${e}`);
      } else {
        // Correction succeeded — surface only non-critical warnings
        postCorrectionWarnings = [...revalidateStructural.warnings, ...revalidatePerFile.warnings];
      }
    } else {
      correctionFailed = true;
      postCorrectionWarnings = allCriticalErrors.map((e) => `[validation_failed] ${e}`);
    }
  } else {
    // Validation passed — surface non-critical warnings
    postCorrectionWarnings = allValidationWarnings;
  }

  // Power/Pro critique pass — holistic review against the user's request
  // Lite/Eco: skip to keep costs down. Runs even when validation passed.
  let critiqueMeta: TaskReport["critiquePass"] = null;
  if ((agentMode === "power" || agentMode === "pro") && !correctionFailed) {
    await onEvent?.("validating_output", "Running quality critique (Power/Pro)…");
    const {
      issues: critiqueIssues,
      fixedFiles: critiqueFixed,
      critiqueFailed,
      critiqueFailureReason,
    } = await runCritiquePass(
      messages,
      files,
      userPrompt,
      postCorrectionWarnings,
      agentMode,
      "build-critique",
    );

    if (critiqueFailed) {
      const unavailableMsg = `[critique_unavailable] QA auto-fix could not complete — ${critiqueFailureReason ?? "model error"}.`;
      logger.warn({ label: "build-critique", reason: critiqueFailureReason }, unavailableMsg);
      postCorrectionWarnings = [...postCorrectionWarnings, unavailableMsg];
      critiqueMeta = {
        issuesFound: [],
        autoFixed: false,
        critiqueFailed: true,
        critiqueFailureReason,
      };
    } else if (critiqueFixed !== null) {
      // Revalidate critique output before accepting — never accept broken patches
      const critiqueValidateStructural = validateWebStructure(critiqueFixed);
      const critiqueValidatePerFile = await validateFiles(
        critiqueFixed.filter(
          (f) =>
            f.mimeType === "text/html" ||
            f.path.endsWith(".html") ||
            f.path.endsWith(".htm") ||
            f.mimeType === "application/javascript" ||
            f.mimeType === "text/javascript" ||
            f.path.endsWith(".js") ||
            f.path.endsWith(".mjs"),
        ),
      );
      const critiqueNewErrors = [
        ...critiqueValidateStructural.criticalErrors,
        ...critiqueValidatePerFile.criticalErrors,
      ];
      if (critiqueNewErrors.length > 0) {
        logger.warn(
          { critiqueNewErrors },
          "Critique patch output failed revalidation — discarding critique patches",
        );
        // Do not apply the broken critique patches; keep pre-critique files
        critiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
        postCorrectionWarnings = [
          ...postCorrectionWarnings,
          ...critiqueIssues.map((i) => `[critique] ${i}`),
        ];
      } else {
        files = critiqueFixed;
        files = files.map((f) => injectRequiredMetaTags(f, projectName));
        critiqueMeta = { issuesFound: critiqueIssues, autoFixed: true };
        logger.info(
          { issueCount: critiqueIssues.length },
          "Critique pass auto-fixed issues in build",
        );
        await onEvent?.(
          "validating_output",
          `Critique auto-fixed ${critiqueIssues.length} issue(s)`,
        );
      }
    } else if (critiqueIssues.length > 0) {
      // Critique found issues but couldn't patch — surface as warnings
      critiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
      postCorrectionWarnings = [
        ...postCorrectionWarnings,
        ...critiqueIssues.map((i) => `[critique] ${i}`),
      ];
    }
  }

  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const warnings = correctionFailed
    ? [...aiWarnings, ...allValidationWarnings, ...postCorrectionWarnings]
    : [...aiWarnings, ...postCorrectionWarnings];

  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : "Open the Preview tab to see your app, then tell me what to change.";

  const summary = cleanSummary(
    typeof parsed.summary === "string" ? parsed.summary : null,
    `Generated ${files.length} files for ${projectName}.`,
  );

  // Inject API mocks for any fetch/axios calls found in generated files.
  // Task #743: agentic-mode projects run real backends (Fly container + Neon),
  // so the service-worker mock layer would intercept real API calls. Skip it.
  if (builderMode !== "agentic") {
    files = injectApiMocks(files);
  }

  // Auto-upgrade any vulnerable CDN URLs to safe versions
  const { files: upgradedFiles, upgrades: cdnUpgradesRaw } = applyCdnAutoUpgrades(files);
  files = upgradedFiles;
  const cdnUpgrades = cdnUpgradesRaw.map(
    (u) => `Auto-upgraded ${u.packageName} CDN from v${u.fromVersion} to v${u.toVersion}`,
  );
  const securityNotices = scanFilesForCdnIssues(files);

  // Run syntax check on the final (post-correction/critique) files
  const finalSyntaxErrors = checkSyntax(files);
  if (finalSyntaxErrors.length > 0) {
    logger.warn(
      { errors: finalSyntaxErrors.map((e) => `${e.file}: ${e.message}`) },
      "Syntax errors remain in final build output after correction pass",
    );
  }

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: blueprint as unknown as Record<string, unknown>,
    filesCreated: files.map((f) => f.path),
    filesChanged: [],
    filesRemoved: [],
    previewUpdated: false,
    warnings,
    integrationsNeeded: blueprint.integrationsNeeded ?? [],
    nextRecommendation,
    syntaxValid: finalSyntaxErrors.length === 0,
    ...(cdnUpgrades.length > 0 ? { cdnUpgrades } : {}),
    ...(securityNotices.length > 0 ? { securityNotices } : {}),
    ...(critiqueMeta ? { critiquePass: critiqueMeta } : {}),
    ...(allCriticalErrors.length > 0
      ? {
          validationReport: {
            initialIssues: allCriticalErrors,
            fixupAttempted: !validationPassed,
            remainingIssues: correctionFailed
              ? postCorrectionWarnings.filter((w) => w.startsWith("[validation_failed]"))
              : [],
            passed: !correctionFailed,
          },
        }
      : {}),
  };

  const correctionPasses = !validationPassed ? 1 : 0;
  const errorCategory = !validationPassed ? classifyCriticalErrors(allCriticalErrors) : null;

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
  databaseContext?: string;
  unchangedFilesHint?: string[];
  /** Structured plan from the Planning Agent — injected as a system message so the builder honours the plan exactly. */
  planContext?: Record<string, unknown> | null;
  /** Distilled summary of earlier conversation turns — gives the builder long-range context. */
  conversationSummary?: string;
  imageAttachments?: BuilderImageAttachment[];
  /** Task #743: skip service-worker / fetch mocks for agentic-mode projects (real containers handle backends). */
  builderMode?: string | null;
  onEvent?: (type: string, message: string) => Promise<void>;
  /** Called with each streamed token delta during the primary code-generation call. */
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
  /** NabuFlow R2 Phase D: task ID for per-build token telemetry accumulation. */
  taskId?: number;
  taskMode?: string;
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
    databaseContext,
    unchangedFilesHint,
    planContext,
    conversationSummary,
    imageAttachments,
    builderMode,
    onEvent,
    onToken,
    signal,
    taskId,
    taskMode,
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
      content: knowledgeContext,
    });
  }

  if (conversationSummary) {
    messages.push({
      role: "system",
      content: `CONVERSATION CONTEXT — summary of earlier exchanges with the user:\n${conversationSummary}`,
    });
  }

  if (integrationContext) {
    messages.push({
      role: "system",
      content: integrationContext,
    });
  }

  if (databaseContext) {
    messages.push({ role: "system", content: databaseContext });
  }

  if (planContext) {
    const { sitemap, dataModel, integrations, goal, approach } = planContext as {
      sitemap?: Array<{ name: string; route: string; purpose: string }>;
      dataModel?: Array<{ table: string; fields: string[] }>;
      integrations?: string[];
      goal?: string;
      approach?: string;
    };
    const planLines: string[] = [
      "STRUCTURED PLAN from Planning Agent — follow this plan exactly when applying changes:",
    ];
    if (goal) planLines.push(`Goal: ${goal}`);
    if (approach) planLines.push(`Approach: ${approach}`);
    if (sitemap && sitemap.length > 0) {
      planLines.push(
        `Pages/Routes:\n${sitemap.map((p) => `  • ${p.name} (${p.route}): ${p.purpose}`).join("\n")}`,
      );
    }
    if (dataModel && dataModel.length > 0) {
      planLines.push(
        `Data model:\n${dataModel.map((m) => `  • ${m.table}: ${m.fields.join(", ")}`).join("\n")}`,
      );
    }
    if (integrations && integrations.length > 0) {
      planLines.push(`Integrations: ${integrations.join(", ")}`);
    }
    messages.push({ role: "system", content: planLines.join("\n") });
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

  pushUserMessageWithImages(messages, userPrompt, imageAttachments);

  await onEvent?.("generating_code", "Applying change request with AI…");
  const parsed = await streamAndAccumulate(
    messages,
    modelFor(agentMode),
    32000,
    "refine",
    signal,
    "refine",
    agentMode,
    onToken,
    taskId,
    taskMode,
  );

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

  // Build merged project state for structural + per-file validation
  // (structural validator needs the full file graph, not just the delta)
  const removedPathsForValidation = new Set(
    Array.isArray(parsed.filesRemoved)
      ? (parsed.filesRemoved as unknown[]).filter((p): p is string => typeof p === "string")
      : [],
  );
  const changedPathsForValidation = new Set(changedFiles.map((f) => f.path));
  const mergedForValidation = [
    ...existingFiles.filter(
      (f) => !removedPathsForValidation.has(f.path) && !changedPathsForValidation.has(f.path),
    ),
    ...changedFiles,
  ];

  // Web structural validator — runs on the full merged project (not just the delta)
  await onEvent?.("validating_output", "Validating changed files…");
  const structuralValidation = validateWebStructure(mergedForValidation);

  // Per-file validation — runs on the changed HTML/JS files only
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
  const perFileValidation =
    filesToValidate.length > 0
      ? await validateFiles(filesToValidate)
      : { passed: true, criticalErrors: [] as string[], warnings: [] as string[] };

  // Merge all critical errors for the correction gate
  const initialCriticalErrors = [
    ...structuralValidation.criticalErrors,
    ...perFileValidation.criticalErrors,
  ];
  const initialWarnings = [...structuralValidation.warnings, ...perFileValidation.warnings];
  const initialValidationPassed = initialCriticalErrors.length === 0;

  let correctionFailed = false;
  let correctionWasAttempted = false;
  let refineErrorCategory: string | null = null;
  // eslint-disable-next-line no-useless-assignment
  let validationWarnings: string[] = [];
  let remainingCriticalErrors: string[] = [];

  if (!initialValidationPassed) {
    correctionWasAttempted = true;
    refineErrorCategory = classifyCriticalErrors(initialCriticalErrors);
    logger.warn(
      { criticalErrors: initialCriticalErrors },
      "Refine validation found critical errors — running correction pass",
    );
    await onEvent?.(
      "validating_output",
      `Validation found ${initialCriticalErrors.length} issue(s) — running correction…`,
    );

    // Pass changedFiles as currentFiles — runCorrectionPass merges the corrected subset in
    const corrected = await runCorrectionPass(
      messages,
      parsed,
      initialCriticalErrors,
      changedFiles,
      agentMode,
      "refine-correction",
      false,
    );
    if (corrected !== null) {
      // corrected is already the fully merged set — replace changedFiles in-place
      changedFiles.splice(0, changedFiles.length, ...corrected);

      // Mandatory revalidation — both structural (on full merged state) and per-file
      const revalidateMerged = [
        ...existingFiles.filter(
          (f) =>
            !removedPathsForValidation.has(f.path) &&
            !new Set(corrected.map((c) => c.path)).has(f.path),
        ),
        ...corrected,
      ];
      const revalidateStructural = validateWebStructure(revalidateMerged);
      const revalidateFiltered = corrected.filter(
        (f) =>
          f.mimeType === "text/html" ||
          f.path.endsWith(".html") ||
          f.path.endsWith(".htm") ||
          f.mimeType === "application/javascript" ||
          f.mimeType === "text/javascript" ||
          f.path.endsWith(".js") ||
          f.path.endsWith(".mjs"),
      );
      const revalidatePerFile =
        revalidateFiltered.length > 0
          ? await validateFiles(revalidateFiltered)
          : { passed: true, criticalErrors: [] as string[], warnings: [] as string[] };
      remainingCriticalErrors = [
        ...revalidateStructural.criticalErrors,
        ...revalidatePerFile.criticalErrors,
      ];
      if (remainingCriticalErrors.length > 0) {
        logger.warn(
          { remainingCritical: remainingCriticalErrors },
          "Refine revalidation after correction still has critical errors — marking failed",
        );
        correctionFailed = true;
        validationWarnings = remainingCriticalErrors.map((e) => `[validation_failed] ${e}`);
      } else {
        // Correction succeeded — surface non-critical warnings
        validationWarnings = [...revalidateStructural.warnings, ...revalidatePerFile.warnings];
      }
    } else {
      correctionFailed = true;
      remainingCriticalErrors = initialCriticalErrors;
      validationWarnings = [
        ...initialWarnings,
        ...initialCriticalErrors.map((e) => `[validation_failed] ${e}`),
      ];
    }
  } else {
    // Passed — surface non-critical warnings (CDN reachability, tag balance, etc.)
    validationWarnings = initialWarnings;
  }

  // Post-processing: inject required meta tags into any changed HTML files
  for (let i = 0; i < changedFiles.length; i++) {
    changedFiles[i] = injectRequiredMetaTags(changedFiles[i]!, projectName);
  }

  // Power/Pro critique pass — holistic review against the user's request
  // Lite/Eco: skip to keep costs down.
  let refineCritiqueMeta: TaskReport["critiquePass"] = null;
  if ((agentMode === "power" || agentMode === "pro") && !correctionFailed) {
    await onEvent?.("validating_output", "Running quality critique (Power/Pro)…");
    // Build the full merged project state for critique context
    const removedSet = new Set(
      Array.isArray(parsed.filesRemoved)
        ? (parsed.filesRemoved as string[]).filter((p) => typeof p === "string")
        : [],
    );
    const changedPathSet = new Set(changedFiles.map((f) => f.path));
    const fullProjectForCritique = [
      ...existingFiles.filter((f) => !removedSet.has(f.path) && !changedPathSet.has(f.path)),
      ...changedFiles,
    ];

    const {
      issues: critiqueIssues,
      fixedFiles: critiqueFixed,
      critiqueFailed,
      critiqueFailureReason,
    } = await runCritiquePass(
      messages,
      fullProjectForCritique,
      userPrompt,
      validationWarnings,
      agentMode,
      "refine-critique",
    );

    if (critiqueFailed) {
      const unavailableMsg = `[critique_unavailable] QA auto-fix could not complete — ${critiqueFailureReason ?? "model error"}.`;
      logger.warn({ label: "refine-critique", reason: critiqueFailureReason }, unavailableMsg);
      validationWarnings = [...validationWarnings, unavailableMsg];
      refineCritiqueMeta = {
        issuesFound: [],
        autoFixed: false,
        critiqueFailed: true,
        critiqueFailureReason,
      };
    } else if (critiqueFixed !== null) {
      // Keep only the files that the critique actually changed (those in changedFiles or new)
      const originalPaths = new Set(existingFiles.map((f) => f.path));
      const critiqueChanges = critiqueFixed.filter((f) => {
        const isNew = !originalPaths.has(f.path);
        const isChanged = changedPathSet.has(f.path) || isNew;
        return isChanged;
      });
      if (critiqueChanges.length > 0) {
        // Revalidate critique patches before accepting them
        const critiqueValidateFiltered = critiqueChanges.filter(
          (f) =>
            f.mimeType === "text/html" ||
            f.path.endsWith(".html") ||
            f.path.endsWith(".htm") ||
            f.mimeType === "application/javascript" ||
            f.mimeType === "text/javascript" ||
            f.path.endsWith(".js") ||
            f.path.endsWith(".mjs"),
        );
        const critiqueRevalidation =
          critiqueValidateFiltered.length > 0
            ? await validateFiles(critiqueValidateFiltered)
            : { passed: true, criticalErrors: [] as string[], warnings: [] as string[] };

        if (!critiqueRevalidation.passed) {
          logger.warn(
            { errors: critiqueRevalidation.criticalErrors },
            "Refine critique patch failed revalidation — discarding critique patches",
          );
          refineCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
          validationWarnings = [
            ...validationWarnings,
            ...critiqueIssues.map((i) => `[critique] ${i}`),
          ];
        } else {
          // Per-file check passed — now revalidate the full merged project structure
          const tentativeChangedMap = new Map(changedFiles.map((f) => [f.path, f]));
          for (const cf of critiqueChanges) tentativeChangedMap.set(cf.path, cf);
          const tentativeChanged = [...tentativeChangedMap.values()];
          const tentativeRemovedSet = new Set(
            Array.isArray(parsed?.filesRemoved)
              ? (parsed.filesRemoved as string[]).filter((r): r is string => typeof r === "string")
              : [],
          );
          const tentativeChangedPaths = new Set(tentativeChanged.map((f) => f.path));
          const tentativeMerged = [
            ...existingFiles.filter(
              (f) => !tentativeRemovedSet.has(f.path) && !tentativeChangedPaths.has(f.path),
            ),
            ...tentativeChanged,
          ];
          const critiqueStructural = validateWebStructure(tentativeMerged);
          if (!critiqueStructural.passed) {
            logger.warn(
              { errors: critiqueStructural.criticalErrors },
              "Refine critique patch failed merged structural validation — discarding critique patches",
            );
            refineCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
            validationWarnings = [
              ...validationWarnings,
              ...critiqueIssues.map((i) => `[critique] ${i}`),
            ];
          } else {
            // Both per-file and merged structural checks passed — commit the critique changes
            changedFiles.splice(0, changedFiles.length, ...tentativeChanged);
            for (let i = 0; i < changedFiles.length; i++) {
              changedFiles[i] = injectRequiredMetaTags(changedFiles[i]!, projectName);
            }
            refineCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: true };
            logger.info(
              { issueCount: critiqueIssues.length },
              "Critique pass auto-fixed issues in refine",
            );
            await onEvent?.(
              "validating_output",
              `Critique auto-fixed ${critiqueIssues.length} issue(s)`,
            );
          }
        }
      } else {
        // Critique returned no actionable file changes — treat as issues-only
        refineCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
      }
    } else if (critiqueIssues.length > 0) {
      refineCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
      validationWarnings = [...validationWarnings, ...critiqueIssues.map((i) => `[critique] ${i}`)];
    }
  }

  const removedPaths = Array.isArray(parsed.filesRemoved)
    ? parsed.filesRemoved.filter((p): p is string => typeof p === "string").map(normalizePath)
    : [];

  const unchangedFiles = Array.isArray(parsed.unchangedFiles)
    ? parsed.unchangedFiles.filter((p): p is string => typeof p === "string")
    : [];

  const summary = cleanSummary(
    typeof parsed.summary === "string" ? parsed.summary : null,
    `Updated ${changedFiles.length} file(s).`,
  );

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

  // Inject API mocks for any new fetch/axios calls in changed files.
  // Task #743: agentic-mode projects run real backends, so skip the mock service worker.
  const mockAugmented = builderMode === "agentic" ? changedFiles : injectApiMocks(changedFiles);
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
  const filesChanged = cdnUpgradedFiles.filter((f) => existingPaths.has(f.path)).map((f) => f.path);

  // Scan the full merged project state (existing + changed, minus removed) for CDN issues
  const removedSet = new Set(removedPaths);
  const changedPathSet = new Set(finalChangedFiles.map((f) => f.path));
  const mergedFiles = [
    ...existingFiles.filter((f) => !removedSet.has(f.path) && !changedPathSet.has(f.path)),
    ...finalChangedFiles,
  ];
  const securityNotices = scanFilesForCdnIssues(mergedFiles);

  // Run syntax check on the final changed files to record pass/fail in the report
  const refineSyntaxErrors = checkSyntax(cdnUpgradedFiles);
  if (refineSyntaxErrors.length > 0) {
    logger.warn(
      { errors: refineSyntaxErrors.map((e) => `${e.file}: ${e.message}`) },
      "Syntax errors remain in final refine output after correction pass",
    );
  }

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: null,
    filesCreated,
    filesChanged,
    filesRemoved: removedPaths,
    previewUpdated: false,
    warnings,
    integrationsNeeded,
    nextRecommendation,
    syntaxValid: refineSyntaxErrors.length === 0,
    ...(refineCdnUpgrades.length > 0 ? { cdnUpgrades: refineCdnUpgrades } : {}),
    ...(securityNotices.length > 0 ? { securityNotices } : {}),
    ...(refineCritiqueMeta ? { critiquePass: refineCritiqueMeta } : {}),
    ...(initialCriticalErrors.length > 0
      ? {
          validationReport: {
            initialIssues: initialCriticalErrors,
            fixupAttempted: correctionWasAttempted,
            remainingIssues: remainingCriticalErrors,
            passed: !correctionFailed,
          },
        }
      : {}),
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
// React + Vite pipeline
// ─────────────────────────────────────────────────────────────────────────────

const REACT_VITE_REQUIRED_FILES = [
  "package.json",
  "index.html",
  "src/main.tsx",
  "src/App.tsx",
  "src/index.css",
  "vite.config.ts",
];

/**
 * Validate that a React + Vite build produced all required files.
 * Returns a ValidationResult compatible with the existing pipeline infrastructure.
 */
function validateReactViteFiles(files: BuilderFile[]): ValidationResult {
  const paths = new Set(files.map((f) => f.path));
  const criticalErrors: string[] = [];
  const warnings: string[] = [];

  for (const required of REACT_VITE_REQUIRED_FILES) {
    if (!paths.has(required)) {
      criticalErrors.push(`Missing required file: ${required}`);
    }
  }

  // package.json must have a scripts.dev entry
  const pkgFile = files.find((f) => f.path === "package.json");
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content) as Record<string, unknown>;
      const scripts = pkg.scripts as Record<string, unknown> | undefined;
      if (!scripts?.["dev"] && !scripts?.["start"]) {
        warnings.push('package.json is missing a "dev" or "start" script.');
      }
      const deps = (pkg.dependencies ?? {}) as Record<string, unknown>;
      if (!deps["react"]) {
        criticalErrors.push('package.json is missing the "react" dependency.');
      }
    } catch {
      criticalErrors.push("package.json is not valid JSON.");
    }
  }

  // src/main.tsx must reference createRoot or render
  const mainFile = files.find((f) => f.path === "src/main.tsx" || f.path === "src/main.ts");
  if (
    mainFile &&
    !mainFile.content.includes("createRoot") &&
    !mainFile.content.includes("render")
  ) {
    warnings.push(
      "src/main.tsx does not appear to call createRoot — verify the React entry point.",
    );
  }

  // index.html must reference src/main.tsx
  const htmlFile = files.find((f) => f.path === "index.html");
  if (htmlFile && !htmlFile.content.includes("src/main")) {
    warnings.push("index.html does not reference /src/main.tsx — the Vite entry may be broken.");
  }

  return { passed: criticalErrors.length === 0, criticalErrors, warnings };
}

export async function runReactViteBuildPipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  integrationContext?: string;
  databaseContext?: string;
  planContext?: Record<string, unknown> | null;
  /** Distilled summary of earlier conversation turns — gives the builder long-range context. */
  conversationSummary?: string;
  imageAttachments?: BuilderImageAttachment[];
  onEvent?: (type: string, message: string) => Promise<void>;
  signal?: AbortSignal;
  /** NabuFlow R2 Phase D: task ID for per-build token telemetry accumulation. */
  taskId?: number;
  taskMode?: string;
}): Promise<BuilderResult> {
  const {
    projectName,
    projectKind,
    userPrompt,
    agentMode,
    conversationHistory,
    knowledgeContext,
    integrationContext,
    databaseContext,
    planContext,
    conversationSummary,
    imageAttachments,
    onEvent,
    signal,
    taskId,
    taskMode,
  } = args;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: REACT_VITE_BUILD_SYSTEM_PROMPT },
    {
      role: "system",
      content: `Project: "${projectName}" (kind: ${projectKind}).`,
    },
  ];

  if (knowledgeContext) {
    messages.push({
      role: "system",
      content: knowledgeContext,
    });
  }

  if (conversationSummary) {
    messages.push({
      role: "system",
      content: `CONVERSATION CONTEXT — summary of earlier exchanges with the user:\n${conversationSummary}`,
    });
  }

  if (integrationContext) {
    messages.push({ role: "system", content: integrationContext });
  }

  if (databaseContext) {
    messages.push({ role: "system", content: databaseContext });
  }

  if (planContext) {
    const { sitemap, dataModel, integrations, goal, approach, fileTree } = planContext as {
      sitemap?: Array<{ name: string; route: string; purpose: string }>;
      dataModel?: Array<{ table: string; fields: string[] }>;
      integrations?: string[];
      goal?: string;
      approach?: string;
      fileTree?: Array<{ path: string; description: string }>;
    };
    const planLines: string[] = [
      "STRUCTURED PLAN from Planning Agent — follow this plan exactly when building:",
    ];
    if (goal) planLines.push(`Goal: ${goal}`);
    if (approach) planLines.push(`Approach: ${approach}`);
    if (sitemap && sitemap.length > 0) {
      planLines.push(
        `Pages/Routes:\n${sitemap.map((p) => `  • ${p.name} (${p.route}): ${p.purpose}`).join("\n")}`,
      );
    }
    if (fileTree && fileTree.length > 0) {
      planLines.push(
        `Planned file tree:\n${fileTree.map((f) => `  • ${f.path}: ${f.description}`).join("\n")}`,
      );
    }
    if (dataModel && dataModel.length > 0) {
      planLines.push(
        `Data model:\n${dataModel.map((m) => `  • ${m.table}: ${m.fields.join(", ")}`).join("\n")}`,
      );
    }
    if (integrations && integrations.length > 0) {
      planLines.push(`Integrations: ${integrations.join(", ")}`);
    }
    messages.push({ role: "system", content: planLines.join("\n") });
  }

  messages.push({ role: "system", content: MODE_QUALITY_STANDARDS[agentMode] });

  if (agentMode === "power" || agentMode === "pro") {
    messages.push({ role: "system", content: SELF_REVIEW_CLAUSE });
  }

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  pushUserMessageWithImages(messages, userPrompt, imageAttachments);

  await onEvent?.("generating_code", "Generating React + Vite project with AI…");
  const parsed = await callWithRetry(
    messages,
    modelFor(agentMode),
    32000,
    "react-vite-build",
    signal,
    "build",
    agentMode,
    taskId,
    taskMode,
  );

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

  // Validate React+Vite structure
  await onEvent?.("validating_output", "Validating React + Vite project structure…");
  const validation = validateReactViteFiles(files);
  let correctionFailed = false;
  let postCorrectionWarnings: string[] = [];

  if (!validation.passed) {
    logger.warn(
      { criticalErrors: validation.criticalErrors },
      "React+Vite build validation found critical errors — running correction pass",
    );
    await onEvent?.(
      "validating_output",
      `Validation found ${validation.criticalErrors.length} issue(s) — running correction…`,
    );

    const correctionMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      ...messages,
      { role: "assistant", content: JSON.stringify(parsed) },
      {
        role: "user",
        content: `The generated React+Vite project is missing required files. Please fix these issues:\n${validation.criticalErrors.join("\n")}\n\nReturn the full corrected JSON output including ALL required files.`,
      },
    ];

    try {
      const corrected = await callWithRetry(
        correctionMessages,
        modelFor(agentMode),
        32000,
        "react-vite-build-correction",
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
      logger.warn({ err }, "React+Vite correction pass failed — using original output");
      correctionFailed = true;
      postCorrectionWarnings = validation.criticalErrors.map((e) => `[validation_failed] ${e}`);
    }
  } else {
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
      : "Run `npm install && npm run dev` locally to preview your app, then tell me what to change.";

  const summary = cleanSummary(
    typeof parsed.summary === "string" ? parsed.summary : null,
    `Generated ${files.length} files for ${projectName}.`,
  );

  const { files: sanitisedFiles } = scanForSecrets(files);
  files = sanitisedFiles;

  // Inject the SPA fallback marker so the snapshot-serving layer knows this
  // project uses client-side routing and should fall back to index.html for
  // extensionless paths that are not found in the snapshot (e.g. deep links
  // refreshed in the browser). This explicit signal replaces any heuristic
  // detection (e.g. presence of src/main.tsx) and must be preserved through
  // all future refine passes — the AI will never emit or remove this file.
  if (!files.some((f) => f.path === "_spa")) {
    files.push({ path: "_spa", content: "", mimeType: "text/plain" });
  }

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: blueprint as unknown as Record<string, unknown>,
    filesCreated: files.map((f) => f.path),
    filesChanged: [],
    filesRemoved: [],
    previewUpdated: false,
    warnings,
    integrationsNeeded: blueprint.integrationsNeeded ?? [],
    nextRecommendation,
  };

  return {
    blueprint,
    files,
    report,
    assistantSummary: summary,
    correctionPasses: !validation.passed ? 1 : 0,
    correctionFailed,
    primaryErrorCategory: !validation.passed ? "structure" : null,
  };
}

export async function runReactViteRefinePipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  existingFiles: BuilderFile[];
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  integrationContext?: string;
  databaseContext?: string;
  unchangedFilesHint?: string[];
  planContext?: Record<string, unknown> | null;
  /** Distilled summary of earlier conversation turns — gives the builder long-range context. */
  conversationSummary?: string;
  imageAttachments?: BuilderImageAttachment[];
  onEvent?: (type: string, message: string) => Promise<void>;
  signal?: AbortSignal;
  /** NabuFlow R2 Phase D: task ID for per-build token telemetry accumulation. */
  taskId?: number;
  taskMode?: string;
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
    databaseContext,
    unchangedFilesHint,
    planContext,
    conversationSummary,
    imageAttachments,
    onEvent,
    signal,
    taskId,
    taskMode,
  } = args;

  const fileManifest = makeCompactManifest(existingFiles, userPrompt, unchangedFilesHint);

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: REACT_VITE_REFINE_SYSTEM_PROMPT },
    {
      role: "system",
      content: `Project: "${projectName}" (kind: ${projectKind}).\n\nCURRENT PROJECT FILES:\n${fileManifest}`,
    },
  ];

  if (knowledgeContext) {
    messages.push({
      role: "system",
      content: knowledgeContext,
    });
  }

  if (conversationSummary) {
    messages.push({
      role: "system",
      content: `CONVERSATION CONTEXT — summary of earlier exchanges with the user:\n${conversationSummary}`,
    });
  }

  if (integrationContext) {
    messages.push({ role: "system", content: integrationContext });
  }

  if (databaseContext) {
    messages.push({ role: "system", content: databaseContext });
  }

  if (planContext) {
    const { sitemap, dataModel, integrations, goal, approach, fileTree } = planContext as {
      sitemap?: Array<{ name: string; route: string; purpose: string }>;
      dataModel?: Array<{ table: string; fields: string[] }>;
      integrations?: string[];
      goal?: string;
      approach?: string;
      fileTree?: Array<{ path: string; description: string }>;
    };
    const planLines: string[] = [
      "STRUCTURED PLAN from Planning Agent — follow this plan exactly when applying changes:",
    ];
    if (goal) planLines.push(`Goal: ${goal}`);
    if (approach) planLines.push(`Approach: ${approach}`);
    if (sitemap && sitemap.length > 0) {
      planLines.push(
        `Pages/Routes:\n${sitemap.map((p) => `  • ${p.name} (${p.route}): ${p.purpose}`).join("\n")}`,
      );
    }
    if (fileTree && fileTree.length > 0) {
      planLines.push(
        `Planned file tree:\n${fileTree.map((f) => `  • ${f.path}: ${f.description}`).join("\n")}`,
      );
    }
    if (dataModel && dataModel.length > 0) {
      planLines.push(
        `Data model:\n${dataModel.map((m) => `  • ${m.table}: ${m.fields.join(", ")}`).join("\n")}`,
      );
    }
    if (integrations && integrations.length > 0) {
      planLines.push(`Integrations: ${integrations.join(", ")}`);
    }
    messages.push({ role: "system", content: planLines.join("\n") });
  }

  messages.push({ role: "system", content: MODE_QUALITY_STANDARDS[agentMode] });

  if (agentMode === "power" || agentMode === "pro") {
    messages.push({ role: "system", content: SELF_REVIEW_CLAUSE });
  }

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  pushUserMessageWithImages(messages, userPrompt, imageAttachments);

  await onEvent?.("generating_code", "Applying change request to React + Vite project…");
  const parsed = await callWithRetry(
    messages,
    modelFor(agentMode),
    32000,
    "react-vite-refine",
    signal,
    "refine",
    agentMode,
    taskId,
    taskMode,
  );

  const rawFiles = Array.isArray(parsed.files) ? parsed.files : [];
  let changedFiles: BuilderFile[] = rawFiles
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

  const unchangedFiles = Array.isArray(parsed.unchangedFiles)
    ? parsed.unchangedFiles.filter((p): p is string => typeof p === "string")
    : [];

  // Secrets scan
  const { files: sanitisedChangedFiles } = scanForSecrets(changedFiles);
  changedFiles = sanitisedChangedFiles;

  const summary = cleanSummary(
    typeof parsed.summary === "string" ? parsed.summary : null,
    `Updated ${changedFiles.length} file(s).`,
  );

  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];

  const integrationsNeeded = Array.isArray(parsed.integrationsNeeded)
    ? (parsed.integrationsNeeded as TaskReport["integrationsNeeded"])
    : [];

  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : "Run `npm install && npm run dev` to preview the updated app.";

  const existingPaths = new Set(existingFiles.map((f) => f.path));
  const filesCreated = changedFiles.filter((f) => !existingPaths.has(f.path)).map((f) => f.path);
  const filesChanged = changedFiles.filter((f) => existingPaths.has(f.path)).map((f) => f.path);

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: null,
    filesCreated,
    filesChanged,
    filesRemoved: removedPaths,
    previewUpdated: false,
    warnings: aiWarnings,
    integrationsNeeded,
    nextRecommendation,
  };

  return {
    changedFiles,
    removedPaths,
    unchangedFiles,
    report,
    assistantSummary: summary,
    correctionPasses: 0,
    correctionFailed: false,
    primaryErrorCategory: null,
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
    const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
    const { provider: mProv, model: mModel } = resolveStageProvider("build", "eco", "gpt-5-mini");
    const response = await createChatCompletion({
      provider: mProv,
      model: mModel,
      zeroCall: { tier: "eco", stage: "build" },
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
You MUST include an index.html file that is a beautiful, realistic, AND INTERACTIVE web preview of the mobile app.

CRITICAL — DO NOT draw a phone shell or device frame inside index.html. The preview pane already wraps the iframe in a CSS phone frame. Adding your own phone shell creates a phone-within-a-phone that looks broken. Instead:
- Use <body class="m-0 p-0 overflow-hidden bg-background w-screen h-screen flex flex-col">
- Root div: class="flex flex-col flex-1 min-h-0 overflow-hidden" — fills the phone frame naturally
- Simulate a status bar at the very top: a slim 28px bar (bg-black or themed) showing time + icons — this is the fake safe-area top inset
- App content below the status bar, scrollable if needed
- If the app has a bottom nav/tab bar, pin it at the bottom with a slim 24px safe-area pad below it

- Show the app's main screen with realistic mock data
- Use Tailwind CDN: <script src="https://cdn.tailwindcss.com"></script>
- Use lucide icons: <script src="https://unpkg.com/lucide@latest"></script>
- If the app has tabs, render a bottom tab bar with tab icons and labels
- Dark or light theme based on app design
- No emojis — use lucide icons only
- Mobile touch targets: min 44px height for interactive elements
- Keep under 20,000 chars for the preview HTML

INTERACTIVITY — MANDATORY (this is the #1 reason users say "the preview is broken"):
Every visible button, tab, link, form input, switch, fab, list item, and clickable card in the preview MUST be wired with an inline JavaScript handler that gives immediate visual feedback when clicked. Static-only mockups are NOT acceptable.

You MUST inline this exact helper near the top of <body> (or at the end of body before lucide.createIcons()):

<div id="mock-toast" class="hidden fixed bottom-20 left-1/2 -translate-x-1/2 z-50 max-w-[90%] px-3 py-2 rounded-lg bg-zinc-800 text-white text-xs shadow-lg border border-zinc-700"></div>
<script>
  (function(){
    var t = document.getElementById('mock-toast');
    var timer = null;
    window.mockAction = function(msg){
      if(!t) return;
      t.textContent = msg;
      t.classList.remove('hidden');
      if(timer) clearTimeout(timer);
      timer = setTimeout(function(){ t.classList.add('hidden'); }, 1800);
    };
    // Auto-wire any element with data-mock that the author forgot to wire explicitly
    document.addEventListener('click', function(e){
      var el = e.target.closest('[data-mock]');
      if(el){ e.preventDefault(); window.mockAction(el.getAttribute('data-mock') || 'Action'); }
    });
    // Tab switching for elements that share data-mock-tab="<id>"
    document.addEventListener('click', function(e){
      var el = e.target.closest('[data-tab-target]');
      if(!el) return;
      var target = el.getAttribute('data-tab-target');
      document.querySelectorAll('[data-tab-panel]').forEach(function(p){
        p.classList.toggle('hidden', p.getAttribute('data-tab-panel') !== target);
      });
      document.querySelectorAll('[data-tab-target]').forEach(function(t){
        t.classList.toggle('text-primary', t.getAttribute('data-tab-target') === target);
      });
    });
  })();
</script>

WIRING RULES for index.html:
1. Every <button>, <a>, role="button" element, and clickable card MUST either:
   (a) have a real working JS handler (form validation, tab switching, modal open/close, list filter, theme toggle, etc.) — preferred for things that can actually work in a browser, OR
   (b) carry a data-mock="<short description>" attribute describing what it would do on the real device (e.g. data-mock="Open camera" or data-mock="Upload photo"). The inline helper above will auto-show the toast.
2. Tab bars: use data-tab-target on tab buttons and data-tab-panel on the panels — the helper will show/hide.
3. Form inputs MUST be focusable and accept typing; submit buttons MUST either validate inline OR carry data-mock.
4. NEVER leave a visible button without either a handler or a data-mock attribute. A non-responsive button in the preview is a bug.`;

const MOBILE_BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow mobile builder. You generate complete, production-ready Expo/React Native projects from a single user request. You output ONLY valid JSON — no prose, no markdown fences.

EXPO PROJECT REQUIREMENTS:
- Expo SDK 52, Expo Router v3, TypeScript, NativeWind v4

MANDATORY FILES — every build MUST include all of these (missing any will cause validation failure):
  1. app.json          — Expo config: { "expo": { "name": "<project>", "slug": "<slug>", "version": "1.0.0", "scheme": "<slug>", "platforms": ["ios","android","web"], "ios": { "bundleIdentifier": "com.mustaflow.<slug>" }, "android": { "package": "com.mustaflow.<slug>" } } }
  2. package.json      — All deps: expo ~52.0.0, react-native, expo-router ~3.5.0, nativewind ~4.0.0, tailwindcss, react, react-dom, @expo/metro-runtime, react-native-safe-area-context, react-native-screens, @react-navigation/native
  3. babel.config.js   — Expo preset with NativeWind babel plugin
  4. tailwind.config.js — NativeWind config with content paths covering app/**/*.{js,jsx,ts,tsx}
  5. app/_layout.tsx   — Root Expo Router layout with SafeAreaProvider wrapping a <Stack> or <Tabs>
  6. app/index.tsx     — Home/main screen (entry point for Expo Router)
  7. index.html        — Web preview stub (see MOBILE WEB PREVIEW section below)

ADDITIONAL FILES (include as needed for the requested app):
  - app/(tabs)/_layout.tsx — Tab layout if tab navigation is used
  - Additional screen files in app/* using Expo Router file-based routing
  - Shared components in components/*
  - constants/Colors.ts — Theme color constants

CODING RULES:
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
  "summary": "One or two plain-English sentences describing what was built — e.g. 'Built a social feed app with a home screen, post creation flow, and user profile view.' No code, no file paths — describe what the user will see.",
  "warnings": string[],
  "nextRecommendation": string
}

MIME types: TypeScript/TSX files → "application/typescript", JSON → "application/json", JS → "application/javascript", HTML → "text/html"
The files array MUST contain app.json, package.json, babel.config.js, tailwind.config.js, app/_layout.tsx, app/index.tsx, and index.html as a minimum. Omitting any of these will fail validation.`;

const MOBILE_REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow mobile builder, in CHANGE MODE. You receive the current Expo/React Native project files and a change request. You modify the affected files and return the FULL updated file contents.

${REFINE_BIAS_TO_ACTION}

${MOBILE_PREVIEW_NOTE}

${REFINE_SCOPE_CLOSER}

OUTPUT STRICT JSON matching this exact shape:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "filesRemoved": string[],
  "summary": "One or two plain-English sentences describing what changed — e.g. 'Added a dark mode toggle and improved navigation transitions between screens.' No code, no file paths.",
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nativeFeatures": string[],
  "nextRecommendation": string
}

"nativeFeatures" lists ALL native Expo SDK features used across the entire project after this change (e.g. "Camera", "Location", "Push Notifications", "Biometrics"). Include any that were already present plus any newly added. Empty array if none.
Return ONLY files that were created or changed (full new content). Do NOT echo unchanged files.
Always update index.html to reflect any UI changes made in the React Native screens.`;

const MOBILE_PLAN_SYSTEM_PROMPT = `You are the NabuFlow Mobile Planner. You plan Expo/React Native mobile app projects. Output ONLY strict JSON — no prose, no markdown:
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

// ─────────────────────────────────────────────────────────────────────────────
// Next.js 14 App Router builder prompts
// ─────────────────────────────────────────────────────────────────────────────

const NEXTJS_BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder. You generate complete, production-ready Next.js 14 App Router applications. Your only output is valid JSON — no prose.

TECH STACK — use exactly:
- Next.js 14 with App Router (src/app/ directory convention)
- TypeScript 5
- Tailwind CSS v3 (via PostCSS — NOT a CDN)
- lucide-react for all icons (no emojis anywhere)

REQUIRED PROJECT STRUCTURE — always include ALL of these files:
- package.json (name, version, scripts: dev/build/start, dependencies, devDependencies)
- next.config.js (minimal — { reactStrictMode: true })
- tailwind.config.js (content: ["./src/**/*.{ts,tsx}"])
- postcss.config.js
- tsconfig.json (target ES2017, moduleResolution bundler, jsx preserve, paths @/*)
- src/app/layout.tsx (RootLayout with <html> and <body> — import globals.css here)
- src/app/page.tsx (Home page — default export)
- src/app/globals.css (Tailwind directives: @tailwind base/components/utilities)

ADDITIONAL FILES (as needed):
- src/app/<route>/page.tsx — additional routes (App Router convention)
- src/app/api/<route>/route.ts — API routes (GET/POST/etc handlers)
- src/components/*.tsx — shared UI components
- src/lib/utils.ts — utility functions

CODE RULES:
- TypeScript throughout — no .js files except config files
- Use "use client" directive only for components that need browser APIs or hooks
- Server Components by default (no "use client" unless necessary)
- Tailwind utility classes only — no inline styles
- Never hardcode secrets — use process.env.VARIABLE_NAME (server-side only)
- Environment variables exposed to client must be prefixed NEXT_PUBLIC_
- Responsive design using Tailwind breakpoints (mobile-first)
- Semantic HTML with proper accessibility
- Use next/link for internal navigation, next/image for optimised images

DEPENDENCIES to include in package.json:
{
  "dependencies": {
    "next": "14.2.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "lucide-react": "^0.447.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.3"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.1",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3"
  }
}

scripts: { "dev": "next dev -p 3000", "build": "next build", "start": "next start -p 3000" }

OUTPUT STRICT JSON:
{
  "blueprint": {
    "projectName": string,
    "projectType": string,
    "targetPlatforms": ["web"],
    "pages": [{ "name": string, "route": string }],
    "components": string[],
    "data": string[],
    "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
    "theme": string
  },
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "summary": "One or two plain-English sentences describing what was built. No code, no file paths.",
  "warnings": string[],
  "nextRecommendation": string
}

MIME types: .ts/.tsx → "application/typescript", .json → "application/json", .js → "application/javascript", .css → "text/css"
The "files" array MUST include every file. package.json, next.config.js, src/app/layout.tsx, src/app/page.tsx, and src/app/globals.css are REQUIRED.`;

const NEXTJS_REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder, in CHANGE MODE for a Next.js 14 App Router project. You receive current project files and a change request. Return ONLY files that changed (full new content for each changed file).

${REFINE_BIAS_TO_ACTION}

TECH STACK: Next.js 14 App Router + TypeScript + Tailwind CSS v3 + lucide-react

RULES:
- TypeScript throughout (.ts / .tsx)
- Tailwind utility classes only
- Maintain App Router conventions (src/app/ directory, layout.tsx, page.tsx)
- "use client" only when truly needed (browser APIs, useState, useEffect, event handlers)
- Do NOT remove or replace package.json, next.config.js, tsconfig.json, or src/app/globals.css unless explicitly asked
- Use lucide-react for icons — no emojis

${REFINE_SCOPE_CLOSER}

OUTPUT STRICT JSON:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "filesRemoved": string[],
  "unchangedFiles": string[],
  "summary": "One or two plain-English sentences describing what changed. No code, no file paths.",
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nextRecommendation": string
}

"files" = ONLY files created or changed (full new content).
"unchangedFiles" = every path you deliberately did not touch.
"filesRemoved" = paths to delete.`;

// ─────────────────────────────────────────────────────────────────────────────
// Node.js API (Express) builder prompts
// ─────────────────────────────────────────────────────────────────────────────

const NODE_API_BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder. You generate complete, production-ready Node.js + Express REST API projects. Your only output is valid JSON — no prose.

TECH STACK — use exactly:
- Node.js 22 + TypeScript 5
- Express 4 (web framework)
- Zod (request validation)
- ts-node-dev or tsx for dev server hot-reload

REQUIRED PROJECT STRUCTURE — always include ALL of these files:
- package.json (name, version, scripts: dev/build/start, dependencies, devDependencies)
- tsconfig.json (target ES2022, module commonjs, outDir dist, strict true)
- src/index.ts (Express app entry point — creates app, registers routers, listens on PORT env var or 3000)
- src/routes/index.ts (main router that mounts all sub-routers)

ADDITIONAL FILES (as needed):
- src/routes/<resource>.ts — resource-specific routers (e.g. users.ts, products.ts)
- src/middleware/*.ts — auth, error handling, validation middleware
- src/lib/db.ts — database helpers (use in-memory store if no DB is configured)
- src/types/*.ts — shared TypeScript types
- src/lib/validation.ts — Zod schemas for request bodies

CODE RULES:
- TypeScript throughout
- RESTful conventions: GET/POST/PUT/PATCH/DELETE with proper status codes
- JSON responses with consistent shape: { data: ... } for success, { error: string, details?: ... } for errors
- Input validation with Zod on all POST/PUT/PATCH endpoints
- Async/await throughout — no callbacks
- Global error handler middleware as last Express middleware
- Never hardcode secrets — use process.env.VARIABLE_NAME
- CORS enabled via cors package when building a public API

DEPENDENCIES to include in package.json:
{
  "dependencies": {
    "express": "^4.21.0",
    "cors": "^2.8.5",
    "zod": "^3.23.8",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/cors": "^2.8.17",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.1",
    "typescript": "^5.6.3"
  }
}

scripts: { "dev": "tsx watch src/index.ts", "build": "tsc", "start": "node dist/index.js" }

OUTPUT STRICT JSON:
{
  "blueprint": {
    "projectName": string,
    "projectType": string,
    "targetPlatforms": ["api"],
    "pages": [{ "name": string, "route": string }],
    "components": string[],
    "data": string[],
    "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
    "theme": "none"
  },
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "summary": "One or two plain-English sentences describing the API built. No code, no file paths.",
  "warnings": string[],
  "nextRecommendation": string
}

MIME types: .ts → "application/typescript", .json → "application/json", .js → "application/javascript"
The "files" array MUST include every file. package.json, tsconfig.json, src/index.ts, and src/routes/index.ts are REQUIRED.`;

const NODE_API_REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder, in CHANGE MODE for a Node.js + Express API project. You receive current project files and a change request. Return ONLY files that changed.

${REFINE_BIAS_TO_ACTION}

TECH STACK: Node.js 22 + TypeScript + Express 4 + Zod

RULES:
- TypeScript throughout (.ts)
- RESTful conventions with proper status codes and JSON responses
- Maintain project structure (src/routes/, src/middleware/, src/lib/)
- Input validation with Zod for all mutating endpoints
- Do NOT remove package.json, tsconfig.json, or src/index.ts unless explicitly asked
- Async/await throughout — no callbacks

${REFINE_SCOPE_CLOSER}

OUTPUT STRICT JSON:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "filesRemoved": string[],
  "unchangedFiles": string[],
  "summary": "One or two plain-English sentences describing what changed. No code, no file paths.",
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nextRecommendation": string
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Python Flask builder prompts
// ─────────────────────────────────────────────────────────────────────────────

const FLASK_BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder. You generate complete, production-ready Python Flask projects. Your only output is valid JSON — no prose.

TECH STACK — use exactly:
- Python 3.12 + Flask 3.x
- flask-cors for CORS support
- python-dotenv for environment variables

REQUIRED PROJECT STRUCTURE — always include ALL of these files:
- requirements.txt (all Python dependencies, pinned to minor versions)
- app.py (Flask app factory and entry point — use create_app() pattern; run on 0.0.0.0:5000)
- .env.example (example env vars — no real values)

ADDITIONAL FILES (as needed):
- routes/<module>.py — Blueprint modules (e.g. users.py, auth.py)
- models.py — data models (use in-memory dict or SQLite via sqlite3 module if persistence needed)
- middleware.py — custom middleware and decorators
- templates/*.html — Jinja2 templates (if building a web app rather than pure API)
- static/style.css — custom CSS (if using templates)

CODE RULES:
- Python 3.12 type hints throughout (use from __future__ import annotations)
- Blueprints for organising routes (register them in create_app)
- JSON responses: jsonify({ "data": ... }) for success, jsonify({ "error": str }) for errors
- Request validation using request.get_json() + manual validation or marshmallow
- Never hardcode secrets — use os.environ.get("VARIABLE_NAME") or python-dotenv
- Flask-CORS enabled for all origins in development (configure restrict in production)
- run with: flask run --host=0.0.0.0 --port=5000 or python app.py

requirements.txt must include:
Flask==3.0.3
flask-cors==4.0.1
python-dotenv==1.0.1

OUTPUT STRICT JSON:
{
  "blueprint": {
    "projectName": string,
    "projectType": string,
    "targetPlatforms": ["web"],
    "pages": [{ "name": string, "route": string }],
    "components": string[],
    "data": string[],
    "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
    "theme": string
  },
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "summary": "One or two plain-English sentences describing what was built. No code, no file paths.",
  "warnings": string[],
  "nextRecommendation": string
}

MIME types: .py → "text/x-python", .txt → "text/plain", .html → "text/html", .css → "text/css", .json → "application/json"
The "files" array MUST include every file. requirements.txt and app.py are REQUIRED.`;

const FLASK_REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder, in CHANGE MODE for a Python Flask project. You receive current project files and a change request. Return ONLY files that changed.

${REFINE_BIAS_TO_ACTION}

TECH STACK: Python 3.12 + Flask 3.x + flask-cors + python-dotenv

RULES:
- Python 3.12 type hints throughout
- Flask Blueprints for route organisation
- JSON responses: jsonify({...}) for all API responses
- Never hardcode secrets — use os.environ.get(...)
- Do NOT remove requirements.txt or app.py unless explicitly asked
- If you add a new Python package, update requirements.txt

${REFINE_SCOPE_CLOSER}

OUTPUT STRICT JSON:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "filesRemoved": string[],
  "unchangedFiles": string[],
  "summary": "One or two plain-English sentences describing what changed. No code, no file paths.",
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nextRecommendation": string
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Python FastAPI builder prompts
// ─────────────────────────────────────────────────────────────────────────────

const FASTAPI_BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder. You generate complete, production-ready Python FastAPI projects. Your only output is valid JSON — no prose.

TECH STACK — use exactly:
- Python 3.12 + FastAPI 0.115+
- Uvicorn (ASGI server)
- Pydantic v2 (built into FastAPI) for request/response validation
- python-dotenv for environment variables

REQUIRED PROJECT STRUCTURE — always include ALL of these files:
- requirements.txt (all Python dependencies, pinned to minor versions)
- main.py (FastAPI app entry — create app instance, include routers, run with uvicorn on 0.0.0.0:8000)
- .env.example (example env vars — no real values)

ADDITIONAL FILES (as needed):
- routers/<module>.py — APIRouter modules (e.g. users.py, items.py)
- models.py — Pydantic models for request/response schemas
- database.py — database helpers (use in-memory dict or SQLite if persistence needed)
- dependencies.py — FastAPI dependency injection helpers

CODE RULES:
- Python 3.12 type hints throughout
- Pydantic BaseModel for all request bodies and response models
- async def for all route handlers
- Proper HTTP status codes using fastapi.status constants
- Never hardcode secrets — use os.environ.get("VARIABLE_NAME") or python-dotenv
- Automatic OpenAPI docs available at /docs (FastAPI default)
- CORSMiddleware configured for all origins in development
- Entry point: uvicorn main:app --reload --host 0.0.0.0 --port 8000

requirements.txt must include:
fastapi==0.115.0
uvicorn[standard]==0.30.6
pydantic==2.8.2
python-dotenv==1.0.1

OUTPUT STRICT JSON:
{
  "blueprint": {
    "projectName": string,
    "projectType": string,
    "targetPlatforms": ["api"],
    "pages": [{ "name": string, "route": string }],
    "components": string[],
    "data": string[],
    "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
    "theme": "none"
  },
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "summary": "One or two plain-English sentences describing the API built. No code, no file paths.",
  "warnings": string[],
  "nextRecommendation": string
}

MIME types: .py → "text/x-python", .txt → "text/plain", .json → "application/json"
The "files" array MUST include every file. requirements.txt and main.py are REQUIRED.`;

const FASTAPI_REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder, in CHANGE MODE for a Python FastAPI project. You receive current project files and a change request. Return ONLY files that changed.

${REFINE_BIAS_TO_ACTION}

TECH STACK: Python 3.12 + FastAPI 0.115 + Uvicorn + Pydantic v2 + python-dotenv

RULES:
- Python 3.12 type hints throughout
- Pydantic BaseModel for all request/response schemas
- async def for all route handlers with proper HTTP status codes
- Never hardcode secrets — use os.environ.get(...)
- Do NOT remove requirements.txt or main.py unless explicitly asked
- If you add a new Python package, update requirements.txt

${REFINE_SCOPE_CLOSER}

OUTPUT STRICT JSON:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "filesRemoved": string[],
  "unchangedFiles": string[],
  "summary": "One or two plain-English sentences describing what changed. No code, no file paths.",
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nextRecommendation": string
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Go + Gin builder prompts
// ─────────────────────────────────────────────────────────────────────────────

const GO_GIN_BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder. You generate complete, production-ready Go + Gin web API projects. Your only output is valid JSON — no prose.

TECH STACK — use exactly:
- Go 1.22
- github.com/gin-gonic/gin v1.10 for HTTP routing
- github.com/joho/godotenv v1.5 for environment variables
- Use standard library net/http, encoding/json, log/slog, os, fmt, errors

REQUIRED PROJECT STRUCTURE — always include ALL of these files:
- go.mod (module path: "app", go 1.22)
- go.sum (leave empty string — the container will run "go mod tidy")
- main.go (entry point: set up Gin router, register routes, call router.Run on port from ENV or 8080)
- .env.example (example env vars — no real values)
- Dockerfile (golang:1.22-alpine build stage → distroless/static final stage)

ADDITIONAL FILES (as needed):
- handlers/<resource>.go — route handler functions (one file per logical resource)
- middleware/<name>.go — Gin middleware (e.g. auth, logging, CORS)
- models/<resource>.go — struct definitions for request/response bodies
- store/<resource>.go — in-memory or SQLite data store (use database/sql + mattn/go-sqlite3 if persistence needed)

CODE RULES:
- Idiomatic Go: named return errors, no panic in handlers, return early on error
- All handler functions must return errors via c.JSON with a proper HTTP status — never call panic()
- Use gin.Context for all handler args; parse JSON bodies with c.ShouldBindJSON(&body)
- Typed structs for all request/response shapes — no map[string]interface{} in handler signatures
- Error responses: c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
- Never hardcode secrets — use os.Getenv("VARIABLE_NAME")
- CORS: use github.com/gin-contrib/cors middleware or manual header middleware
- Entry point: router.Run(":" + port) where port = os.Getenv("PORT") or "8080"

go.mod must declare:
module app

go 1.22

require (
\tgithub.com/gin-gonic/gin v1.10.0
\tgithub.com/joho/godotenv v1.5.1
)

OUTPUT STRICT JSON:
{
  "blueprint": {
    "projectName": string,
    "projectType": string,
    "targetPlatforms": ["api"],
    "pages": [{ "name": string, "route": string }],
    "components": string[],
    "data": string[],
    "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
    "theme": "none"
  },
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "summary": "One or two plain-English sentences describing the API built. No code, no file paths.",
  "warnings": string[],
  "nextRecommendation": string
}

MIME types: .go → "text/x-go", .mod → "text/plain", .sum → "text/plain", .md → "text/plain", .json → "application/json"
The "files" array MUST include every file. go.mod, go.sum, and main.go are REQUIRED.`;

const GO_GIN_REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder, in CHANGE MODE for a Go + Gin project. You receive current project files and a change request. Return ONLY files that changed.

${REFINE_BIAS_TO_ACTION}

TECH STACK: Go 1.22 + github.com/gin-gonic/gin v1.10

RULES:
- Idiomatic Go: named errors, no panic in handlers, typed structs for all request/response shapes
- Never hardcode secrets — use os.Getenv(...)
- Do NOT remove go.mod, go.sum, or main.go unless explicitly asked
- If you add a new Go module dependency, update go.mod require block (go.sum will be regenerated by go mod tidy)
- All handlers must return errors via c.JSON with a proper HTTP status

${REFINE_SCOPE_CLOSER}

OUTPUT STRICT JSON:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "filesRemoved": string[],
  "unchangedFiles": string[],
  "summary": "One or two plain-English sentences describing what changed. No code, no file paths.",
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nextRecommendation": string
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Generic server-stack pipeline factory
// Shared by Next.js, Node API, Flask, FastAPI, and Go/Gin — avoids massive duplication.
// ─────────────────────────────────────────────────────────────────────────────

type StackBuildArgs = {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  integrationContext?: string;
  planContext?: Record<string, unknown> | null;
  /** Distilled summary of earlier conversation turns — gives the builder long-range context. */
  conversationSummary?: string;
  imageAttachments?: BuilderImageAttachment[];
  onEvent?: (type: string, message: string) => Promise<void>;
  signal?: AbortSignal;
  /** NabuFlow R2 Phase D: task ID for per-build token telemetry accumulation. */
  taskId?: number;
  taskMode?: string;
  /** Explicit project runtime service port; omitted preserves legacy prompt defaults. */
  runtimePort?: number | null;
  /** Deployment-owned generation target. Omitted is exactly the legacy path. */
  zeroGenerationTarget?: ZeroGenerationTarget;
  /** Deterministic acceptance adapter; production jobs never supply one. */
  modelAdapter?: BuilderModelAdapter;
  sealedManifestRevision?: string;
};

type StackRefineArgs = {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  existingFiles: BuilderFile[];
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  integrationContext?: string;
  unchangedFilesHint?: string[];
  planContext?: Record<string, unknown> | null;
  /** Distilled summary of earlier conversation turns — gives the builder long-range context. */
  conversationSummary?: string;
  imageAttachments?: BuilderImageAttachment[];
  onEvent?: (type: string, message: string) => Promise<void>;
  signal?: AbortSignal;
  /** NabuFlow R2 Phase D: task ID for per-build token telemetry accumulation. */
  taskId?: number;
  taskMode?: string;
  /** Explicit project runtime service port; omitted preserves legacy prompt defaults. */
  runtimePort?: number | null;
};

function stackPromptForRuntimePort(systemPrompt: string, runtimePort?: number | null): string {
  if (!isValidTenantServicePort(runtimePort)) return systemPrompt;
  return systemPrompt.replace(/\b(?:3000|5000|8000|8080)\b/g, String(runtimePort));
}

async function runStackBuildPipeline(
  args: StackBuildArgs,
  systemPrompt: string,
  stackLabel: string,
  capabilityCorrectionAttempt = 0,
): Promise<BuilderResult> {
  const {
    projectName,
    projectKind,
    userPrompt,
    agentMode,
    conversationHistory,
    knowledgeContext,
    integrationContext,
    planContext,
    conversationSummary,
    imageAttachments,
    onEvent,
    signal,
    taskId,
    taskMode,
  } = args;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: stackPromptForRuntimePort(systemPrompt, args.runtimePort) },
    { role: "system", content: `Project: "${projectName}" (kind: ${projectKind}).` },
  ];

  if (isZeroSealedGenerationTarget(args.zeroGenerationTarget)) {
    messages.push({ role: "system", content: ZERO_SEALED_NODE_PROMPT_EXTENSION });
  }

  if (knowledgeContext) {
    messages.push({
      role: "system",
      content: knowledgeContext,
    });
  }
  if (conversationSummary) {
    messages.push({
      role: "system",
      content: `CONVERSATION CONTEXT — summary of earlier exchanges with the user:\n${conversationSummary}`,
    });
  }
  if (integrationContext) {
    messages.push({ role: "system", content: integrationContext });
  }

  if (planContext) {
    const { sitemap, dataModel, integrations, goal, approach, fileTree } = planContext as {
      sitemap?: Array<{ name: string; route: string; purpose: string }>;
      dataModel?: Array<{ table: string; fields: string[] }>;
      integrations?: string[];
      goal?: string;
      approach?: string;
      fileTree?: Array<{ path: string; description: string }>;
    };
    const planLines = ["STRUCTURED PLAN from Planning Agent — follow this plan exactly:"];
    if (goal) planLines.push(`Goal: ${goal}`);
    if (approach) planLines.push(`Approach: ${approach}`);
    if (sitemap?.length)
      planLines.push(
        `Routes:\n${sitemap.map((p) => `  • ${p.name} (${p.route}): ${p.purpose}`).join("\n")}`,
      );
    if (fileTree?.length)
      planLines.push(
        `Planned files:\n${fileTree.map((f) => `  • ${f.path}: ${f.description}`).join("\n")}`,
      );
    if (dataModel?.length)
      planLines.push(
        `Data model:\n${dataModel.map((m) => `  • ${m.table}: ${m.fields.join(", ")}`).join("\n")}`,
      );
    if (integrations?.length) planLines.push(`Integrations: ${integrations.join(", ")}`);
    messages.push({ role: "system", content: planLines.join("\n") });
  }

  messages.push({ role: "system", content: MODE_QUALITY_STANDARDS[agentMode] });
  if (agentMode === "power" || agentMode === "pro") {
    messages.push({ role: "system", content: SELF_REVIEW_CLAUSE });
  }

  if (conversationHistory?.length) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  pushUserMessageWithImages(messages, userPrompt, imageAttachments);

  await onEvent?.("generating_code", `Generating ${stackLabel} project with AI…`);
  const parsed = args.modelAdapter
    ? await args.modelAdapter.complete({ messages, label: `${stackLabel}-build`, signal })
    : await callWithRetry(
        messages,
        modelFor(agentMode),
        32000,
        `${stackLabel}-build`,
        signal,
        "build",
        agentMode,
        taskId,
        taskMode,
      );

  const blueprint = (parsed.blueprint ?? {
    projectName,
    projectType: projectKind,
    targetPlatforms: ["web"],
    pages: [],
    components: [],
    integrationsNeeded: [],
  }) as Blueprint;

  const rawFiles = Array.isArray(parsed.files) ? parsed.files : [];
  const files: BuilderFile[] = rawFiles
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

  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];

  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : `Run the dev server locally to preview your ${stackLabel} app.`;

  const summary = cleanSummary(
    typeof parsed.summary === "string" ? parsed.summary : null,
    `Generated ${files.length} files for ${projectName}.`,
  );

  const { files: sanitisedFiles } = scanForSecrets(files);
  let sealed: ReturnType<typeof prepareZeroSealedNodeSource> | null;
  try {
    sealed = isZeroSealedGenerationTarget(args.zeroGenerationTarget)
      ? prepareZeroSealedNodeSource({
          files: sanitisedFiles,
          target: args.zeroGenerationTarget,
          skipEligibilityPrecheck: true,
          ...(args.sealedManifestRevision === undefined
            ? {}
            : { manifestRevision: args.sealedManifestRevision }),
        })
      : null;
    if (sealed !== null) {
      await assertZeroGeneratedEligibility({
        files: sealed.files,
        dependencyPlan: sealed.dependencyPlan,
        runtimeManifest: sealed.manifest,
        declaredCapabilities: inferZeroDeclaredCapabilities(sealed.files),
        pantryClosureVerified: false,
        dependencyOutputAttested: false,
        stage: "source",
      });
    }
  } catch (error) {
    if (
      error instanceof ZeroCapabilityGapError &&
      isZeroSealedGenerationTarget(args.zeroGenerationTarget) &&
      capabilityCorrectionAttempt === 0
    ) {
      const reasonCodes = [...new Set(error.result.reasons.map((reason) => reason.code))].sort();
      return runStackBuildPipeline(
        {
          ...args,
          integrationContext: [
            args.integrationContext,
            `SEALED CAPABILITY CORRECTION (automatic): the prior candidate was rejected with zero_capability_gap (${reasonCodes.join(", ")}). Regenerate using only the vendored database/payments capabilities or a local-compute implementation. Do not request credentials, egress, package stocking, or Pantry/doorman configuration from the user.`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        systemPrompt,
        stackLabel,
        1,
      );
    }
    throw error;
  }
  const outputFiles = sealed?.files ?? sanitisedFiles;

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: blueprint as unknown as Record<string, unknown>,
    filesCreated: outputFiles.map((f) => f.path),
    filesChanged: [],
    filesRemoved: [],
    previewUpdated: false,
    warnings: aiWarnings,
    integrationsNeeded: blueprint.integrationsNeeded ?? [],
    nextRecommendation,
  };

  return {
    blueprint,
    files: outputFiles,
    report,
    assistantSummary: summary,
    correctionPasses: 0,
    correctionFailed: false,
    primaryErrorCategory: null,
    ...(sealed
      ? {
          sealedGeneration: {
            dependencyPlan: sealed.dependencyPlan,
            manifest: sealed.manifest,
          },
        }
      : {}),
  };
}

async function runStackRefinePipeline(
  args: StackRefineArgs,
  systemPrompt: string,
  stackLabel: string,
): Promise<{
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
    planContext,
    conversationSummary,
    imageAttachments,
    onEvent,
    signal,
    taskId,
    taskMode,
  } = args;

  const fileManifest = makeCompactManifest(existingFiles, userPrompt, unchangedFilesHint);

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: stackPromptForRuntimePort(systemPrompt, args.runtimePort) },
    {
      role: "system",
      content: `Project: "${projectName}" (kind: ${projectKind}).\n\nCURRENT PROJECT FILES:\n${fileManifest}`,
    },
  ];

  if (knowledgeContext) {
    messages.push({
      role: "system",
      content: knowledgeContext,
    });
  }
  if (conversationSummary) {
    messages.push({
      role: "system",
      content: `CONVERSATION CONTEXT — summary of earlier exchanges with the user:\n${conversationSummary}`,
    });
  }
  if (integrationContext) {
    messages.push({ role: "system", content: integrationContext });
  }

  if (planContext) {
    const { sitemap, dataModel, integrations, goal, approach } = planContext as {
      sitemap?: Array<{ name: string; route: string; purpose: string }>;
      dataModel?: Array<{ table: string; fields: string[] }>;
      integrations?: string[];
      goal?: string;
      approach?: string;
    };
    const planLines = ["STRUCTURED PLAN — follow this plan exactly when applying changes:"];
    if (goal) planLines.push(`Goal: ${goal}`);
    if (approach) planLines.push(`Approach: ${approach}`);
    if (sitemap?.length)
      planLines.push(
        `Routes:\n${sitemap.map((p) => `  • ${p.name} (${p.route}): ${p.purpose}`).join("\n")}`,
      );
    if (dataModel?.length)
      planLines.push(
        `Data model:\n${dataModel.map((m) => `  • ${m.table}: ${m.fields.join(", ")}`).join("\n")}`,
      );
    if (integrations?.length) planLines.push(`Integrations: ${integrations.join(", ")}`);
    messages.push({ role: "system", content: planLines.join("\n") });
  }

  messages.push({ role: "system", content: MODE_QUALITY_STANDARDS[agentMode] });
  if (agentMode === "power" || agentMode === "pro") {
    messages.push({ role: "system", content: SELF_REVIEW_CLAUSE });
  }

  if (conversationHistory?.length) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  pushUserMessageWithImages(messages, userPrompt, imageAttachments);

  await onEvent?.("generating_code", `Applying change request to ${stackLabel} project…`);
  const parsed = await callWithRetry(
    messages,
    modelFor(agentMode),
    32000,
    `${stackLabel}-refine`,
    signal,
    "refine",
    agentMode,
    taskId,
    taskMode,
  );

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

  const rawPatches = Array.isArray(parsed.patches) ? parsed.patches : [];
  const { patched, failed } = applyPatches(existingFiles, rawPatches);
  const patchedAsFiles: BuilderFile[] = [...patched.entries()].map(([path, content]) => {
    const orig = existingFiles.find((f) => f.path === path);
    return { path, content, mimeType: orig?.mimeType ?? guessMime(path) };
  });
  if (failed.length > 0) {
    logger.warn(
      { failed, stackLabel },
      "Some patches failed to apply — requiring full file resend",
    );
  }

  const removedPaths = Array.isArray(parsed.filesRemoved)
    ? parsed.filesRemoved.filter((p): p is string => typeof p === "string").map(normalizePath)
    : [];
  const unchangedFiles = Array.isArray(parsed.unchangedFiles)
    ? parsed.unchangedFiles.filter((p): p is string => typeof p === "string")
    : [];

  const mergedChangedMap = new Map<string, BuilderFile>();
  for (const f of patchedAsFiles) mergedChangedMap.set(f.path, f);
  for (const f of changedFiles) mergedChangedMap.set(f.path, f);
  const mergedChanged = [...mergedChangedMap.values()];

  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const integrationsNeeded = Array.isArray(parsed.integrationsNeeded)
    ? parsed.integrationsNeeded
    : [];

  const summary = cleanSummary(
    typeof parsed.summary === "string" ? parsed.summary : null,
    `Updated ${mergedChanged.length} file(s) in ${projectName}.`,
  );

  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : `Review the changes and restart the dev server.`;

  const { files: sanitisedChanged } = scanForSecrets(mergedChanged);

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: {
      projectName,
      projectType: projectKind,
      targetPlatforms: [],
      pages: [],
      components: [],
      integrationsNeeded: [],
    } as unknown as Record<string, unknown>,
    filesCreated: [],
    filesChanged: sanitisedChanged.map((f) => f.path),
    filesRemoved: removedPaths,
    previewUpdated: false,
    warnings: aiWarnings,
    integrationsNeeded,
    nextRecommendation,
  };

  return {
    changedFiles: sanitisedChanged,
    removedPaths,
    unchangedFiles,
    report,
    assistantSummary: summary,
    correctionPasses: 0,
    correctionFailed: false,
    primaryErrorCategory: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public pipeline exports — one build + one refine per stack
// ─────────────────────────────────────────────────────────────────────────────

export async function runNextjsBuildPipeline(args: StackBuildArgs): Promise<BuilderResult> {
  return runStackBuildPipeline(args, NEXTJS_BUILD_SYSTEM_PROMPT, "Next.js");
}

export async function runNextjsRefinePipeline(args: StackRefineArgs): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedFiles: string[];
  report: TaskReport;
  assistantSummary: string;
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
}> {
  return runStackRefinePipeline(args, NEXTJS_REFINE_SYSTEM_PROMPT, "Next.js");
}

export async function runNodeApiBuildPipeline(args: StackBuildArgs): Promise<BuilderResult> {
  return runStackBuildPipeline(args, NODE_API_BUILD_SYSTEM_PROMPT, "Node.js API");
}

export async function runNodeApiRefinePipeline(args: StackRefineArgs): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedFiles: string[];
  report: TaskReport;
  assistantSummary: string;
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
}> {
  return runStackRefinePipeline(args, NODE_API_REFINE_SYSTEM_PROMPT, "Node.js API");
}

export async function runFlaskBuildPipeline(args: StackBuildArgs): Promise<BuilderResult> {
  return runStackBuildPipeline(args, FLASK_BUILD_SYSTEM_PROMPT, "Flask");
}

export async function runFlaskRefinePipeline(args: StackRefineArgs): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedFiles: string[];
  report: TaskReport;
  assistantSummary: string;
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
}> {
  return runStackRefinePipeline(args, FLASK_REFINE_SYSTEM_PROMPT, "Flask");
}

export async function runFastapiBuildPipeline(args: StackBuildArgs): Promise<BuilderResult> {
  return runStackBuildPipeline(args, FASTAPI_BUILD_SYSTEM_PROMPT, "FastAPI");
}

export async function runFastapiRefinePipeline(args: StackRefineArgs): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedFiles: string[];
  report: TaskReport;
  assistantSummary: string;
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
}> {
  return runStackRefinePipeline(args, FASTAPI_REFINE_SYSTEM_PROMPT, "FastAPI");
}

export async function runGoGinBuildPipeline(args: StackBuildArgs): Promise<BuilderResult> {
  return runStackBuildPipeline(args, GO_GIN_BUILD_SYSTEM_PROMPT, "Go/Gin");
}

export async function runGoGinRefinePipeline(args: StackRefineArgs): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedFiles: string[];
  report: TaskReport;
  assistantSummary: string;
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
}> {
  return runStackRefinePipeline(args, GO_GIN_REFINE_SYSTEM_PROMPT, "Go/Gin");
}

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
  imageAttachments?: BuilderImageAttachment[];
  onEvent?: (type: string, message: string) => Promise<void>;
  signal?: AbortSignal;
  /** NabuFlow R2 Phase D: task ID for per-build token telemetry accumulation. */
  taskId?: number;
  taskMode?: string;
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
    imageAttachments,
    onEvent,
    signal,
    taskId,
    taskMode,
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
      content: knowledgeContext,
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

  pushUserMessageWithImages(messages, userPrompt, imageAttachments);

  await onEvent?.("generating_code", "Generating Expo/React Native app blueprint…");
  const parsed = await callWithRetry(
    messages,
    modelFor(agentMode),
    32000,
    "mobile-build",
    signal,
    "build",
    agentMode,
    taskId,
    taskMode,
  );

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
  let mobileStructureFailed = !mobileValidation.passed;
  let mobileValidationRemainingErrors: string[] = mobileValidation.criticalErrors;

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
      // Mandatory revalidation after mobile correction — check that critical errors are resolved
      const revalidated = validateMobileFiles(files);
      if (revalidated.criticalErrors.length > 0) {
        logger.warn(
          { remaining: revalidated.criticalErrors },
          "Mobile build: structural validation still failing after correction — marking failed",
        );
        // mobileCorrectionFailed is returned via correctionFailed below
        mobileStructureFailed = true;
        mobileValidationRemainingErrors = revalidated.criticalErrors;
      } else {
        mobileStructureFailed = false;
        mobileValidationRemainingErrors = [];
      }
    } catch (err) {
      logger.warn({ err }, "Mobile correction pass failed — using original output");
      mobileStructureFailed = true;
      mobileValidationRemainingErrors = mobileValidation.criticalErrors;
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

  // Auto-generate eas.json with preview + production profiles so the first EAS build works
  if (!files.some((f) => f.path === "eas.json")) {
    files.push({
      path: "eas.json",
      content: JSON.stringify(
        {
          cli: { version: ">= 16.0.0" },
          build: {
            preview: { distribution: "internal" },
            production: { autoIncrement: true },
          },
        },
        null,
        2,
      ),
      mimeType: "application/json",
    });
  }

  // Auto-correct package.json to include module dependencies
  if (detectedModuleIds.length > 0) {
    await onEvent?.("validating_output", "Verifying module packages in package.json…");
    files = autoCorrectPackageJson(files, detectedModuleIds);
  }

  // TypeScript check — blocking for mobile builds. Retry once with errors as context.
  await onEvent?.("validating_output", "Running TypeScript type-check…");
  const tsResult = await runTsCheck(files);
  let tsCheckFailed = false;
  let tsErrors = tsResult.errors;

  if (tsResult.errors.length > 0) {
    logger.warn(
      { errorCount: tsResult.errors.length },
      "Mobile build: TypeScript errors found — running TS correction pass",
    );
    await onEvent?.(
      "validating_output",
      `TypeScript: ${tsResult.errors.length} error(s) — running correction…`,
    );

    const tsErrorText = formatTsErrors(tsResult.errors);
    const tsCorrection: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      ...messages,
      { role: "assistant", content: JSON.stringify(parsed) },
      {
        role: "user",
        content: `The generated TypeScript files have type errors that would prevent the app from compiling. Fix all errors below and return ONLY the corrected files with full content:\n\n${tsErrorText}`,
      },
    ];

    try {
      const tsCorrected = await callWithRetry(
        tsCorrection,
        modelFor(agentMode),
        32000,
        "mobile-ts-correction",
      );
      const tsCorrectedRaw = Array.isArray(tsCorrected.files) ? tsCorrected.files : [];
      const tsCorrectedFiles: BuilderFile[] = tsCorrectedRaw
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
      for (const cf of tsCorrectedFiles) mergedMap.set(cf.path, cf);
      files = [...mergedMap.values()];

      // Re-check after correction — surface remaining errors without blocking further
      const tsRecheck = await runTsCheck(files);
      tsErrors = tsRecheck.errors;
      if (tsRecheck.errors.length > 0) {
        logger.warn(
          { remaining: tsRecheck.errors.length },
          "Mobile build: TypeScript errors remain after correction pass",
        );
        tsCheckFailed = true;
      }
    } catch (err) {
      logger.warn({ err }, "Mobile TS correction pass failed — using pre-correction output");
      tsCheckFailed = true;
    }
  }

  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const tsWarnings = tsCheckFailed
    ? [
        `TypeScript check: ${tsErrors.length} error(s) remain after correction. The app may not compile correctly.`,
      ]
    : [];
  let mobileBuildWarnings = [...aiWarnings, ...mobileValidation.warnings, ...tsWarnings];

  // Power/Pro critique pass — holistic mobile review against the user's request.
  // Lite/Eco: skip to keep costs down. Skip when prior validation failed.
  let mobileBuildCritiqueMeta: TaskReport["critiquePass"] = null;
  if ((agentMode === "power" || agentMode === "pro") && !mobileStructureFailed && !tsCheckFailed) {
    await onEvent?.("validating_output", "Running quality critique (Power/Pro)…");
    const {
      issues: critiqueIssues,
      fixedFiles: critiqueFixed,
      critiqueFailed,
      critiqueFailureReason,
    } = await runCritiquePass(
      messages,
      files,
      userPrompt,
      mobileBuildWarnings,
      agentMode,
      "mobile-build-critique",
      MOBILE_CRITIQUE_SYSTEM_PROMPT,
    );

    if (critiqueFailed) {
      const unavailableMsg = `[critique_unavailable] QA auto-fix could not complete — ${critiqueFailureReason ?? "model error"}.`;
      logger.warn(
        { label: "mobile-build-critique", reason: critiqueFailureReason },
        unavailableMsg,
      );
      mobileBuildWarnings = [...mobileBuildWarnings, unavailableMsg];
      mobileBuildCritiqueMeta = {
        issuesFound: [],
        autoFixed: false,
        critiqueFailed: true,
        critiqueFailureReason,
      };
    } else if (critiqueFixed !== null) {
      // Revalidate critique output against Expo structure before accepting
      const critiqueRevalidation = validateMobileFiles(critiqueFixed);
      if (!critiqueRevalidation.passed) {
        logger.warn(
          { critiqueErrors: critiqueRevalidation.criticalErrors },
          "Mobile build critique patch failed Expo structure revalidation — discarding critique patches",
        );
        mobileBuildCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
        mobileBuildWarnings = [
          ...mobileBuildWarnings,
          ...critiqueIssues.map((i) => `[critique] ${i}`),
        ];
      } else {
        // Re-run TS check on critique patches — never accept patches that
        // reintroduce TypeScript errors after the mobile TS gate already passed.
        const critiqueTsRecheck = await runTsCheck(critiqueFixed);
        if (critiqueTsRecheck.errors.length > 0) {
          logger.warn(
            { errorCount: critiqueTsRecheck.errors.length },
            "Mobile build critique patch reintroduced TypeScript errors — discarding critique patches",
          );
          mobileBuildCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
          mobileBuildWarnings = [
            ...mobileBuildWarnings,
            ...critiqueIssues.map((i) => `[critique] ${i}`),
          ];
        } else {
          files = critiqueFixed;
          mobileBuildCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: true };
          logger.info(
            { issueCount: critiqueIssues.length },
            "Mobile critique pass auto-fixed issues in build",
          );
          await onEvent?.(
            "validating_output",
            `Critique auto-fixed ${critiqueIssues.length} issue(s)`,
          );
        }
      }
    } else if (critiqueIssues.length > 0) {
      mobileBuildCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
      mobileBuildWarnings = [
        ...mobileBuildWarnings,
        ...critiqueIssues.map((i) => `[critique] ${i}`),
      ];
    }
  }

  const warnings = mobileBuildWarnings;

  const summary = cleanSummary(
    typeof parsed.summary === "string" ? parsed.summary : null,
    `Generated Expo/React Native app with ${files.length} files for ${projectName}.`,
  );

  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : "Open the Preview tab to see the web preview, then scan the QR code with Expo Go on your device.";

  const modulesWired = detectedModuleIds.map((id) => {
    const mod = MOBILE_MODULES.find((m) => m.id === id);
    return { id, name: mod?.name ?? id, secretsConsumed: mod?.requiredSecrets ?? [] };
  });

  const mobileFinalCorrectionFailed = mobileStructureFailed || tsCheckFailed;

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: blueprint as unknown as Record<string, unknown>,
    filesCreated: files.map((f) => f.path),
    filesChanged: [],
    filesRemoved: [],
    previewUpdated: false,
    warnings,
    integrationsNeeded: blueprint.integrationsNeeded ?? [],
    nextRecommendation,
    nativeFeatures: blueprint.nativeFeatures?.length ? blueprint.nativeFeatures : undefined,
    modulesWired: modulesWired.length > 0 ? modulesWired : undefined,
    ...(mobileBuildCritiqueMeta ? { critiquePass: mobileBuildCritiqueMeta } : {}),
    ...(mobileValidation.criticalErrors.length > 0
      ? {
          validationReport: {
            initialIssues: mobileValidation.criticalErrors,
            fixupAttempted: true,
            remainingIssues: mobileValidationRemainingErrors,
            passed: !mobileStructureFailed,
          },
        }
      : {}),
  };

  return {
    blueprint,
    files,
    report,
    assistantSummary: summary,
    correctionPasses: mobileValidation.criticalErrors.length > 0 ? 1 : 0,
    correctionFailed: mobileFinalCorrectionFailed,
    primaryErrorCategory: mobileStructureFailed ? "mobile_structure" : null,
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
  imageAttachments?: BuilderImageAttachment[];
  onEvent?: (type: string, message: string) => Promise<void>;
  signal?: AbortSignal;
  /** NabuFlow R2 Phase D: task ID for per-build token telemetry accumulation. */
  taskId?: number;
  taskMode?: string;
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
    imageAttachments,
    onEvent,
    signal,
    taskId,
    taskMode,
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
      content: knowledgeContext,
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

  pushUserMessageWithImages(messages, userPrompt, imageAttachments);

  await onEvent?.("generating_code", "Applying change request to Expo project…");
  const parsed = await callWithRetry(
    messages,
    modelFor(agentMode),
    32000,
    "mobile-refine",
    signal,
    "refine",
    agentMode,
    taskId,
    taskMode,
  );

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

  const summary = cleanSummary(
    typeof parsed.summary === "string" ? parsed.summary : null,
    `Updated ${changedFiles.length} file(s) in the Expo project.`,
  );

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
  const _filesCreated = changedFiles.filter((f) => !existingPaths.has(f.path)).map((f) => f.path);
  const _filesChanged = changedFiles.filter((f) => existingPaths.has(f.path)).map((f) => f.path);

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

  // TypeScript check — blocking for mobile refines. Retry once with errors as context.
  // Merge changed files into the existing project snapshot, drop removed paths,
  // and type-check the resulting tree so cross-file references resolve correctly.
  const mergedForTsCheck = new Map(existingFiles.map((f) => [f.path, f]));
  for (const rp of removedPaths) mergedForTsCheck.delete(rp);
  for (const cf of changedFiles) mergedForTsCheck.set(cf.path, cf);
  let mergedFiles = [...mergedForTsCheck.values()];

  await onEvent?.("validating_output", "Running TypeScript type-check…");
  const tsResult = await runTsCheck(mergedFiles);
  let tsCheckFailed = false;
  let tsErrors = tsResult.errors;
  let correctionPasses = 0;

  if (tsResult.errors.length > 0) {
    logger.warn(
      { errorCount: tsResult.errors.length },
      "Mobile refine: TypeScript errors found — running TS correction pass",
    );
    await onEvent?.(
      "validating_output",
      `TypeScript: ${tsResult.errors.length} error(s) — running correction…`,
    );

    const tsErrorText = formatTsErrors(tsResult.errors);
    const tsCorrection: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      ...messages,
      { role: "assistant", content: JSON.stringify(parsed) },
      {
        role: "user",
        content: `The updated TypeScript files have type errors that would prevent the app from compiling. Fix all errors below and return ONLY the corrected files with full content:\n\n${tsErrorText}`,
      },
    ];

    try {
      const tsCorrected = await callWithRetry(
        tsCorrection,
        modelFor(agentMode),
        32000,
        "mobile-refine-ts-correction",
        signal,
        "refine",
        agentMode,
        taskId,
        taskMode,
      );
      const tsCorrectedRaw = Array.isArray(tsCorrected.files) ? tsCorrected.files : [];
      const tsCorrectedFiles: BuilderFile[] = tsCorrectedRaw
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

      // Merge corrections into both the changedFiles list (returned to caller)
      // and the merged tree (for the re-check).
      const changedMap = new Map(changedFiles.map((f) => [f.path, f]));
      for (const cf of tsCorrectedFiles) changedMap.set(cf.path, cf);
      changedFiles.length = 0;
      changedFiles.push(...changedMap.values());

      const mergedMap = new Map(mergedFiles.map((f) => [f.path, f]));
      for (const cf of tsCorrectedFiles) mergedMap.set(cf.path, cf);
      mergedFiles = [...mergedMap.values()];

      correctionPasses = 1;

      // Re-check after correction — surface remaining errors without blocking further
      const tsRecheck = await runTsCheck(mergedFiles);
      tsErrors = tsRecheck.errors;
      if (tsRecheck.errors.length > 0) {
        logger.warn(
          { remaining: tsRecheck.errors.length },
          "Mobile refine: TypeScript errors remain after correction pass",
        );
        tsCheckFailed = true;
      }
    } catch (err) {
      logger.warn({ err }, "Mobile refine TS correction pass failed — using pre-correction output");
      tsCheckFailed = true;
      correctionPasses = 1;
    }
  }

  // Recompute created/changed lists in case correction added new files.
  const _finalFilesCreated = changedFiles
    .filter((f) => !existingPaths.has(f.path))
    .map((f) => f.path);
  const _finalFilesChanged = changedFiles
    .filter((f) => existingPaths.has(f.path))
    .map((f) => f.path);

  const tsWarnings = tsCheckFailed
    ? [
        `TypeScript check: ${tsErrors.length} error(s) remain after correction. The app may not compile correctly.`,
      ]
    : [];
  let refineWarnings = [...aiWarnings, ...tsWarnings];

  // Power/Pro critique pass — holistic mobile review against the user's request.
  // Lite/Eco: skip to keep costs down. Skip when prior validation failed.
  let mobileRefineCritiqueMeta: TaskReport["critiquePass"] = null;
  if ((agentMode === "power" || agentMode === "pro") && !tsCheckFailed) {
    await onEvent?.("validating_output", "Running quality critique (Power/Pro)…");
    const {
      issues: critiqueIssues,
      fixedFiles: critiqueFixed,
      critiqueFailed,
      critiqueFailureReason,
    } = await runCritiquePass(
      messages,
      mergedFiles,
      userPrompt,
      refineWarnings,
      agentMode,
      "mobile-refine-critique",
      MOBILE_CRITIQUE_SYSTEM_PROMPT,
    );

    if (critiqueFailed) {
      const unavailableMsg = `[critique_unavailable] QA auto-fix could not complete — ${critiqueFailureReason ?? "model error"}.`;
      logger.warn(
        { label: "mobile-refine-critique", reason: critiqueFailureReason },
        unavailableMsg,
      );
      refineWarnings = [...refineWarnings, unavailableMsg];
      mobileRefineCritiqueMeta = {
        issuesFound: [],
        autoFixed: false,
        critiqueFailed: true,
        critiqueFailureReason,
      };
    } else if (critiqueFixed !== null) {
      // Keep only the files the critique actually changed (existing changedFiles or net-new)
      const originalPaths = new Set(existingFiles.map((f) => f.path));
      const tentativeChangedMap = new Map(changedFiles.map((f) => [f.path, f]));
      const critiqueChangedOnly: BuilderFile[] = [];
      for (const cf of critiqueFixed) {
        const wasChangedAlready = tentativeChangedMap.has(cf.path);
        const isNew = !originalPaths.has(cf.path);
        if (wasChangedAlready || isNew) {
          tentativeChangedMap.set(cf.path, cf);
          critiqueChangedOnly.push(cf);
        }
      }

      if (critiqueChangedOnly.length > 0) {
        // Revalidate the merged project against Expo structure before accepting
        const tentativeMergedMap = new Map(mergedFiles.map((f) => [f.path, f]));
        for (const cf of critiqueChangedOnly) tentativeMergedMap.set(cf.path, cf);
        const tentativeMerged = [...tentativeMergedMap.values()];
        const critiqueRevalidation = validateMobileFiles(tentativeMerged);

        if (!critiqueRevalidation.passed) {
          logger.warn(
            { critiqueErrors: critiqueRevalidation.criticalErrors },
            "Mobile refine critique patch failed Expo structure revalidation — discarding critique patches",
          );
          mobileRefineCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
          refineWarnings = [...refineWarnings, ...critiqueIssues.map((i) => `[critique] ${i}`)];
        } else {
          // Re-run TS check on the post-critique merged tree — never accept
          // patches that reintroduce TypeScript errors after the TS gate passed.
          const critiqueTsRecheck = await runTsCheck(tentativeMerged);
          if (critiqueTsRecheck.errors.length > 0) {
            logger.warn(
              { errorCount: critiqueTsRecheck.errors.length },
              "Mobile refine critique patch reintroduced TypeScript errors — discarding critique patches",
            );
            mobileRefineCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
            refineWarnings = [...refineWarnings, ...critiqueIssues.map((i) => `[critique] ${i}`)];
          } else {
            const newChanged = [...tentativeChangedMap.values()];
            changedFiles.length = 0;
            changedFiles.push(...newChanged);
            // eslint-disable-next-line no-useless-assignment
            mergedFiles = tentativeMerged;
            mobileRefineCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: true };
            logger.info(
              { issueCount: critiqueIssues.length },
              "Mobile critique pass auto-fixed issues in refine",
            );
            await onEvent?.(
              "validating_output",
              `Critique auto-fixed ${critiqueIssues.length} issue(s)`,
            );
          }
        }
      } else {
        mobileRefineCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
      }
    } else if (critiqueIssues.length > 0) {
      mobileRefineCritiqueMeta = { issuesFound: critiqueIssues, autoFixed: false };
      refineWarnings = [...refineWarnings, ...critiqueIssues.map((i) => `[critique] ${i}`)];
    }
  }

  // Recompute created/changed lists in case critique added new files.
  const postCritiqueFilesCreated = changedFiles
    .filter((f) => !existingPaths.has(f.path))
    .map((f) => f.path);
  const postCritiqueFilesChanged = changedFiles
    .filter((f) => existingPaths.has(f.path))
    .map((f) => f.path);

  const warnings = refineWarnings;

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: null,
    filesCreated: postCritiqueFilesCreated,
    filesChanged: postCritiqueFilesChanged,
    filesRemoved: removedPaths,
    previewUpdated: false,
    warnings,
    integrationsNeeded,
    nextRecommendation,
    nativeFeatures: nativeFeatures?.length ? nativeFeatures : undefined,
    modulesWired: modulesWired.length > 0 ? modulesWired : undefined,
    ...(mobileRefineCritiqueMeta ? { critiquePass: mobileRefineCritiqueMeta } : {}),
  };

  return {
    changedFiles,
    removedPaths,
    unchangedFiles: [],
    report,
    assistantSummary: summary,
    detectedModuleIds,
    correctionPasses,
    correctionFailed: tsCheckFailed,
    primaryErrorCategory: tsCheckFailed ? "typescript" : null,
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

// ─────────────────────────────────────────────────────────────────────────────
// Planning Agent — project investigation (deterministic, no AI)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectInvestigationResult {
  fileCount: number;
  detectedPages: string[];
  detectedLibraries: string[];
  detectedPlatform: string;
  summary: string;
}

/**
 * Deterministically analyses the current project files and returns a brief
 * structured summary. Called at the start of runPlanPipeline so the Planning
 * Agent can describe what already exists in the project. No AI call — derived
 * from file content alone.
 */
export function runProjectInvestigation(files: BuilderFile[]): ProjectInvestigationResult {
  const fileCount = files.length;

  // Detect platform from file extensions / presence of known config files
  const paths = files.map((f) => f.path);
  const isMobile =
    paths.some((p) => p === "app.json" || p === "app/_layout.tsx" || p === "app/index.tsx") ||
    paths.some((p) => p.endsWith(".tsx") || p.endsWith(".ts"));
  const detectedPlatform = isMobile ? "mobile (Expo)" : "web (HTML/CSS/JS)";

  // Detect pages: look for HTML <a href> tags and file names that look like pages
  const detectedPages: string[] = [];
  const pagePathRe = /^(pages?\/|screens?\/|views?\/|routes?\/)/i;
  const htmlFileRe = /\.html?$/i;
  for (const f of files) {
    if (htmlFileRe.test(f.path)) {
      // Extract page name from filename
      const name =
        f.path
          .split("/")
          .pop()
          ?.replace(/\.html?$/i, "") ?? f.path;
      if (name && name !== "index") detectedPages.push(name);
    } else if (pagePathRe.test(f.path)) {
      const name =
        f.path
          .split("/")
          .pop()
          ?.replace(/\.[^.]+$/, "") ?? f.path;
      if (name && name !== "index" && name !== "_layout" && !detectedPages.includes(name)) {
        detectedPages.push(name);
      }
    }
  }
  // Also scan HTML content for <a href> nav links
  for (const f of files) {
    if (!htmlFileRe.test(f.path) && !f.path.endsWith(".html")) continue;
    const linkRe = /href=["']([^"'#?]+\.html?)['"]/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(f.content)) !== null) {
      const page = m[1]?.replace(/\.html?$/i, "") ?? "";
      if (page && !detectedPages.includes(page)) detectedPages.push(page);
    }
  }

  // Detect libraries: scan CDN script src attributes
  const cdnRe = /src=["']https?:\/\/(?:cdn\.|unpkg\.|esm\.sh\/|jspm\.dev\/)?[^"']*\/([^/"'@]+)/gi;
  const libSet = new Set<string>();
  for (const f of files) {
    let m: RegExpExecArray | null;
    while ((m = cdnRe.exec(f.content)) !== null) {
      const lib = m[1]?.toLowerCase().split("@")[0]?.split(".")[0];
      if (lib && lib.length > 1 && !["cdn", "js", "min", "umd", "esm", "www"].includes(lib)) {
        libSet.add(lib);
      }
    }
    // Also scan import statements for well-known libraries
    const importRe = /from ["']([a-z@][a-z0-9-/@.]+)["']/g;
    while ((m = importRe.exec(f.content)) !== null) {
      const lib = m[1]?.split("/")[0] ?? "";
      if (lib && !lib.startsWith(".")) libSet.add(lib);
    }
  }
  const detectedLibraries = [...libSet].slice(0, 12);

  // Build human-readable summary
  const parts: string[] = [`${fileCount} file${fileCount !== 1 ? "s" : ""}`];
  if (detectedPages.length > 0) {
    parts.push(
      `${detectedPages.length} page${detectedPages.length !== 1 ? "s" : ""} (${detectedPages.slice(0, 4).join(", ")}${detectedPages.length > 4 ? "…" : ""})`,
    );
  }
  if (detectedLibraries.length > 0) {
    parts.push(`libraries: ${detectedLibraries.slice(0, 5).join(", ")}`);
  }
  const summary = fileCount === 0 ? "No files yet — this is a fresh project." : parts.join(" · ");

  return { fileCount, detectedPages, detectedLibraries, detectedPlatform, summary };
}

export async function runPlanPipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
  currentFiles?: BuilderFile[];
  /** Distilled summary of earlier conversation turns — gives the planner long-range context. */
  conversationSummary?: string;
  deepReasoning?: boolean;
  signal?: AbortSignal;
}): Promise<{
  summary: string;
  plan: Record<string, unknown> | null;
  currentState: ProjectInvestigationResult | null;
  recommendedAgent: "planning" | "task" | "main";
}> {
  const {
    projectName,
    projectKind,
    userPrompt,
    agentMode,
    conversationHistory,
    currentFiles,
    conversationSummary,
    deepReasoning = false,
    signal,
  } = args;

  const isMobile = ["mobile-ios", "mobile-android", "mobile-cross"].includes(projectKind);
  const planPrompt = isMobile ? MOBILE_PLAN_SYSTEM_PROMPT : PLAN_SYSTEM_PROMPT;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: planPrompt },
    {
      role: "system",
      content: `Project: "${projectName}" (kind: ${projectKind}).`,
    },
  ];

  if (conversationSummary) {
    messages.push({
      role: "system",
      content: `CONVERSATION CONTEXT — summary of earlier exchanges with the user:\n${conversationSummary}`,
    });
  }

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-4)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  messages.push({ role: "user", content: userPrompt });

  // eslint-disable-next-line no-useless-assignment
  let plan: Record<string, unknown> | null = null;
  try {
    plan = await runPlanningBrain<Record<string, unknown>>({
      entryPoint: "planning_agent",
      mode: agentMode,
      deepReasoning,
      systemPrompt: planPrompt,
      messages: messages.slice(1),
      maxCompletionTokens: 8000,
      signal,
    });

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
      plan = await runPlanningBrain<Record<string, unknown>>({
        entryPoint: "planning_agent",
        mode: agentMode,
        deepReasoning,
        systemPrompt: planPrompt,
        messages: messages.slice(1),
        maxCompletionTokens: 8000,
        signal,
      });
    }
  } catch (error) {
    // Cancellation must escape the fallback path so the task owner can write
    // one cancelled terminal event instead of retrying or returning a fallback.
    if (signal?.aborted) throw error;
    plan = null;
  }

  // Ensure backward compat: if sitemap exists but pages doesn't, derive pages from sitemap
  if (plan && Array.isArray(plan.sitemap) && !Array.isArray(plan.pages)) {
    plan.pages = (plan.sitemap as Array<{ name: string }>).map((s) => s.name);
  }

  // Run project investigation (deterministic — no AI call)
  const currentState =
    currentFiles && currentFiles.length > 0 ? runProjectInvestigation(currentFiles) : null;

  // Attach currentState to the plan object so the frontend plan card can render it
  if (plan && currentState) {
    plan.currentState = currentState as unknown as Record<string, unknown>;
  }

  // Derive recommended agent from plan complexity score:
  //   score 1-4 → main (fast direct edit)
  //   score 5-7 → task (staging gate — worth reviewing)
  //   score 8-10 or no score → task (complex, definitely stage it)
  const complexityScore =
    typeof plan?.complexityScore === "number" ? plan.complexityScore : (currentFiles?.length ?? 0);
  const recommendedAgent: "planning" | "task" | "main" = complexityScore <= 4 ? "main" : "task";

  // Attach recommended agent to plan so frontend can render the badge
  if (plan) {
    plan.recommendedAgent = recommendedAgent;
  }

  const summary =
    typeof plan?.summary === "string"
      ? plan.summary
      : "Here's a plan. Tell me to build it with the recommended agent.";
  return { summary, plan, currentState, recommendedAgent };
}

// ─────────────────────────────────────────────────────────────────────────────
// Node.js (Express) builder prompts
// ─────────────────────────────────────────────────────────────────────────────

const NODE_BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder. You generate complete, working Node.js / Express web API projects. Your only output is valid JSON — no prose.

TECH STACK — use exactly:
- Node.js (20 or 22 LTS) + Express 4 for the HTTP server
- Plain JavaScript (CommonJS with require()) — no TypeScript, no build step
- Tailwind CSS via CDN only (for any HTML pages served statically)

REQUIRED PROJECT STRUCTURE — always include ALL of these files:
- package.json (name, version, scripts: { "start": "node src/index.js", "dev": "node --watch src/index.js" }, dependencies: { express })
- src/index.js (main entry point — creates Express app, registers routes, calls app.listen(PORT || 3000))
- src/routes/ directory (at least one route file imported by index.js)
- index.html (static landing page served at GET /, uses Tailwind CDN to show the app name and API docs)
- README.md (brief project overview, how to run, API endpoint docs)

CODE RULES:
- Use const, let — never var
- Use async/await for async operations; always use try/catch around awaits
- Express error handler middleware (4 args: err, req, res, next) at the end of index.js
- Never hardcode secrets — use process.env.MY_KEY with helpful comments
- Every route must respond with JSON (except GET / which serves the HTML landing page)
- Include CORS headers: app.use(require('cors')()) — add cors to dependencies

MIME types: .js → "application/javascript", .json → "application/json", .html → "text/html", .md → "text/plain"

OUTPUT STRICT JSON:
{
  "blueprint": {
    "projectName": string,
    "projectType": string,
    "targetPlatforms": ["node"],
    "pages": [{ "name": string, "route": string }],
    "components": string[],
    "data": string[],
    "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
    "theme": string
  },
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "summary": "One or two plain-English sentences describing what was built — describe the API endpoints and what the server does. No code, no file paths.",
  "warnings": string[],
  "nextRecommendation": string
}

The "files" array MUST include every file in the project. package.json, src/index.js, and index.html are REQUIRED.`;

const NODE_REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder, in CHANGE MODE for a Node.js / Express project. You receive the current project files and a change request. Return ONLY files that changed (full new content for each changed file).

${REFINE_BIAS_TO_ACTION}

TECH STACK: Node.js + Express 4 + plain JavaScript (CommonJS)

RULES:
- Maintain the established project structure (src/routes/, etc.)
- Never hardcode secrets — use process.env.*
- Do NOT remove package.json, src/index.js, or index.html unless explicitly asked
- If you add a new npm package, update package.json accordingly
- Use async/await with try/catch; always include an error handler middleware

${REFINE_SCOPE_CLOSER}

OUTPUT STRICT JSON:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "filesRemoved": string[],
  "unchangedFiles": string[],
  "summary": "One or two plain-English sentences describing what changed. No code, no file paths.",
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nextRecommendation": string
}

"files" = ONLY files created or changed (full new content).
"unchangedFiles" = every path you deliberately did not touch (MUST list all untouched files).
"filesRemoved" = paths to delete.`;

// ─────────────────────────────────────────────────────────────────────────────
// Python (Flask) builder prompts
// ─────────────────────────────────────────────────────────────────────────────

const PYTHON_BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder. You generate complete, working Python / Flask web API projects. Your only output is valid JSON — no prose.

TECH STACK — use exactly:
- Python 3.12 + Flask 3 for the HTTP server
- flask-cors for CORS support
- python-dotenv for environment variable loading

REQUIRED PROJECT STRUCTURE — always include ALL of these files:
- requirements.txt (list one package per line: flask, flask-cors, python-dotenv — add extras as needed)
- app.py (main entry point — creates Flask app, registers blueprints/routes, calls app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 3000))) inside if __name__ == "__main__")
- routes/ directory (at least one route module imported by app.py)
- index.html (static landing page served at GET /, uses Tailwind CDN to show the app name and API docs)
- README.md (brief project overview, how to run locally, API endpoint docs)
- .env.example (commented-out list of all required env vars, e.g. # MY_API_KEY=your_key_here)

CODE RULES:
- Python 3.12 style: type hints, f-strings, dataclasses where useful
- Use Flask Blueprints for route organisation — one blueprint per logical group
- Every route must return jsonify(data) (except GET / which returns render_template or send_file for index.html)
- Never hardcode secrets — use os.environ.get("KEY") with a descriptive comment
- Always wrap DB / external calls in try/except and return structured JSON errors on failure
- Use flask.abort() for 4xx errors; register a @app.errorhandler(Exception) catch-all

MIME types: .py → "text/x-python", .txt → "text/plain", .html → "text/html", .md → "text/plain", .json → "application/json"

OUTPUT STRICT JSON:
{
  "blueprint": {
    "projectName": string,
    "projectType": string,
    "targetPlatforms": ["python"],
    "pages": [{ "name": string, "route": string }],
    "components": string[],
    "data": string[],
    "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
    "theme": string
  },
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "summary": "One or two plain-English sentences describing what was built — describe the API endpoints and what the server does. No code, no file paths.",
  "warnings": string[],
  "nextRecommendation": string
}

The "files" array MUST include every file in the project. requirements.txt, app.py, and index.html are REQUIRED.`;

const PYTHON_REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder, in CHANGE MODE for a Python / Flask project. You receive the current project files and a change request. Return ONLY files that changed (full new content for each changed file).

${REFINE_BIAS_TO_ACTION}

TECH STACK: Python 3.12 + Flask 3 + flask-cors + python-dotenv

RULES:
- Maintain the established project structure (routes/ blueprints, etc.)
- Never hardcode secrets — use os.environ.get("KEY")
- Do NOT remove requirements.txt, app.py, or index.html unless explicitly asked
- If you add a new package, update requirements.txt accordingly
- Use try/except with proper error handling; return structured JSON errors

${REFINE_SCOPE_CLOSER}

OUTPUT STRICT JSON:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "filesRemoved": string[],
  "unchangedFiles": string[],
  "summary": "One or two plain-English sentences describing what changed. No code, no file paths.",
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nextRecommendation": string
}

"files" = ONLY files created or changed (full new content).
"unchangedFiles" = every path you deliberately did not touch (MUST list all untouched files).
"filesRemoved" = paths to delete.`;

/**
 * Build pipeline for Node.js (Express) projects.
 * Generates a complete Node.js API project structure.
 */
export async function runNodeBuildPipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  planContext?: Record<string, unknown> | null;
  onEvent?: (type: string, message: string) => Promise<void>;
}): Promise<BuilderResult> {
  const {
    projectName,
    projectKind,
    userPrompt,
    agentMode,
    conversationHistory,
    knowledgeContext,
    planContext,
    onEvent,
  } = args;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: NODE_BUILD_SYSTEM_PROMPT },
    { role: "system", content: `Project: "${projectName}" (kind: ${projectKind}).` },
  ];

  if (knowledgeContext) {
    messages.push({
      role: "system",
      content: knowledgeContext,
    });
  }

  if (planContext) {
    const { goal, approach } = planContext as { goal?: string; approach?: string };
    const planLines = [
      "STRUCTURED PLAN from Planning Agent — follow this plan exactly when building:",
    ];
    if (goal) planLines.push(`Goal: ${goal}`);
    if (approach) planLines.push(`Approach: ${approach}`);
    messages.push({ role: "system", content: planLines.join("\n") });
  }

  messages.push({ role: "system", content: MODE_QUALITY_STANDARDS[agentMode] });

  if (agentMode === "power" || agentMode === "pro") {
    messages.push({ role: "system", content: SELF_REVIEW_CLAUSE });
  }

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  messages.push({ role: "user", content: userPrompt });

  await onEvent?.("generating_code", "Generating Node.js / Express project with AI…");
  const parsed = await callWithRetry(
    messages,
    modelFor(agentMode),
    32000,
    "node-build",
    undefined,
    "build",
    agentMode,
  );

  const blueprint = (parsed.blueprint ?? {
    projectName,
    projectType: projectKind,
    targetPlatforms: ["node"],
    pages: [],
    components: [],
    integrationsNeeded: [],
  }) as Blueprint;

  const rawFiles = Array.isArray(parsed.files) ? parsed.files : [];
  const files: BuilderFile[] = rawFiles
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

  const { files: sanitisedFiles } = scanForSecrets(files);
  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : "Run `npm install && npm start` in the container to start the server.";
  const summary = cleanSummary(
    typeof parsed.summary === "string" ? parsed.summary : null,
    `Generated ${sanitisedFiles.length} files for ${projectName}.`,
  );

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: blueprint as unknown as Record<string, unknown>,
    filesCreated: sanitisedFiles.map((f) => f.path),
    filesChanged: [],
    filesRemoved: [],
    previewUpdated: false,
    warnings: aiWarnings,
    integrationsNeeded: blueprint.integrationsNeeded ?? [],
    nextRecommendation,
  };

  return {
    blueprint,
    files: sanitisedFiles,
    report,
    assistantSummary: summary,
    correctionPasses: 0,
    correctionFailed: false,
    primaryErrorCategory: null,
  };
}

/**
 * Refine pipeline for Node.js (Express) projects.
 */
export async function runNodeRefinePipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  existingFiles: BuilderFile[];
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  unchangedFilesHint?: string[];
  planContext?: Record<string, unknown> | null;
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
    unchangedFilesHint,
    planContext,
    onEvent,
  } = args;

  const fileManifest = makeCompactManifest(existingFiles, userPrompt, unchangedFilesHint);

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: NODE_REFINE_SYSTEM_PROMPT },
    {
      role: "system",
      content: `Project: "${projectName}" (kind: ${projectKind}).\n\nCURRENT PROJECT FILES:\n${fileManifest}`,
    },
  ];

  if (knowledgeContext) {
    messages.push({ role: "system", content: knowledgeContext });
  }

  if (planContext) {
    const { goal, approach } = planContext as { goal?: string; approach?: string };
    const planLines = ["STRUCTURED PLAN:"];
    if (goal) planLines.push(`Goal: ${goal}`);
    if (approach) planLines.push(`Approach: ${approach}`);
    messages.push({ role: "system", content: planLines.join("\n") });
  }

  messages.push({ role: "system", content: MODE_QUALITY_STANDARDS[agentMode] });

  if (agentMode === "power" || agentMode === "pro") {
    messages.push({ role: "system", content: SELF_REVIEW_CLAUSE });
  }

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  messages.push({ role: "user", content: userPrompt });

  await onEvent?.("generating_code", "Applying changes to Node.js project…");
  const parsed = await callWithRetry(
    messages,
    modelFor(agentMode),
    32000,
    "node-refine",
    undefined,
    "refine",
    agentMode,
  );

  const rawFiles = Array.isArray(parsed.files) ? parsed.files : [];
  let changedFiles: BuilderFile[] = rawFiles
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
  const unchangedFiles = Array.isArray(parsed.unchangedFiles)
    ? parsed.unchangedFiles.filter((p): p is string => typeof p === "string")
    : [];

  const { files: sanitisedChangedFiles } = scanForSecrets(changedFiles);
  changedFiles = sanitisedChangedFiles;

  const summary = cleanSummary(
    typeof parsed.summary === "string" ? parsed.summary : null,
    `Updated ${changedFiles.length} file(s).`,
  );
  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const integrationsNeeded = Array.isArray(parsed.integrationsNeeded)
    ? (parsed.integrationsNeeded as TaskReport["integrationsNeeded"])
    : [];
  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : "Restart the dev server to pick up the changes.";

  const existingPaths = new Set(existingFiles.map((f) => f.path));
  const filesCreated = changedFiles.filter((f) => !existingPaths.has(f.path)).map((f) => f.path);
  const filesChanged = changedFiles.filter((f) => existingPaths.has(f.path)).map((f) => f.path);

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: null,
    filesCreated,
    filesChanged,
    filesRemoved: removedPaths,
    previewUpdated: false,
    warnings: aiWarnings,
    integrationsNeeded,
    nextRecommendation,
  };

  return {
    changedFiles,
    removedPaths,
    unchangedFiles,
    report,
    assistantSummary: summary,
    correctionPasses: 0,
    correctionFailed: false,
    primaryErrorCategory: null,
  };
}

/**
 * Build pipeline for Python (Flask) projects.
 * Generates a complete Python API project structure.
 */
export async function runPythonBuildPipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  planContext?: Record<string, unknown> | null;
  onEvent?: (type: string, message: string) => Promise<void>;
}): Promise<BuilderResult> {
  const {
    projectName,
    projectKind,
    userPrompt,
    agentMode,
    conversationHistory,
    knowledgeContext,
    planContext,
    onEvent,
  } = args;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: PYTHON_BUILD_SYSTEM_PROMPT },
    { role: "system", content: `Project: "${projectName}" (kind: ${projectKind}).` },
  ];

  if (knowledgeContext) {
    messages.push({
      role: "system",
      content: knowledgeContext,
    });
  }

  if (planContext) {
    const { goal, approach } = planContext as { goal?: string; approach?: string };
    const planLines = [
      "STRUCTURED PLAN from Planning Agent — follow this plan exactly when building:",
    ];
    if (goal) planLines.push(`Goal: ${goal}`);
    if (approach) planLines.push(`Approach: ${approach}`);
    messages.push({ role: "system", content: planLines.join("\n") });
  }

  messages.push({ role: "system", content: MODE_QUALITY_STANDARDS[agentMode] });

  if (agentMode === "power" || agentMode === "pro") {
    messages.push({ role: "system", content: SELF_REVIEW_CLAUSE });
  }

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  messages.push({ role: "user", content: userPrompt });

  await onEvent?.("generating_code", "Generating Python / Flask project with AI…");
  const parsed = await callWithRetry(
    messages,
    modelFor(agentMode),
    32000,
    "python-build",
    undefined,
    "build",
    agentMode,
  );

  const blueprint = (parsed.blueprint ?? {
    projectName,
    projectType: projectKind,
    targetPlatforms: ["python"],
    pages: [],
    components: [],
    integrationsNeeded: [],
  }) as Blueprint;

  const rawFiles = Array.isArray(parsed.files) ? parsed.files : [];
  const files: BuilderFile[] = rawFiles
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

  const { files: sanitisedFiles } = scanForSecrets(files);
  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : "Run `pip install -r requirements.txt && python app.py` in the container to start the server.";
  const summary = cleanSummary(
    typeof parsed.summary === "string" ? parsed.summary : null,
    `Generated ${sanitisedFiles.length} files for ${projectName}.`,
  );

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: blueprint as unknown as Record<string, unknown>,
    filesCreated: sanitisedFiles.map((f) => f.path),
    filesChanged: [],
    filesRemoved: [],
    previewUpdated: false,
    warnings: aiWarnings,
    integrationsNeeded: blueprint.integrationsNeeded ?? [],
    nextRecommendation,
  };

  return {
    blueprint,
    files: sanitisedFiles,
    report,
    assistantSummary: summary,
    correctionPasses: 0,
    correctionFailed: false,
    primaryErrorCategory: null,
  };
}

/**
 * Refine pipeline for Python (Flask) projects.
 */
export async function runPythonRefinePipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  existingFiles: BuilderFile[];
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
  unchangedFilesHint?: string[];
  planContext?: Record<string, unknown> | null;
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
    unchangedFilesHint,
    planContext,
    onEvent,
  } = args;

  const fileManifest = makeCompactManifest(existingFiles, userPrompt, unchangedFilesHint);

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: PYTHON_REFINE_SYSTEM_PROMPT },
    {
      role: "system",
      content: `Project: "${projectName}" (kind: ${projectKind}).\n\nCURRENT PROJECT FILES:\n${fileManifest}`,
    },
  ];

  if (knowledgeContext) {
    messages.push({ role: "system", content: knowledgeContext });
  }

  if (planContext) {
    const { goal, approach } = planContext as { goal?: string; approach?: string };
    const planLines = ["STRUCTURED PLAN:"];
    if (goal) planLines.push(`Goal: ${goal}`);
    if (approach) planLines.push(`Approach: ${approach}`);
    messages.push({ role: "system", content: planLines.join("\n") });
  }

  messages.push({ role: "system", content: MODE_QUALITY_STANDARDS[agentMode] });

  if (agentMode === "power" || agentMode === "pro") {
    messages.push({ role: "system", content: SELF_REVIEW_CLAUSE });
  }

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  messages.push({ role: "user", content: userPrompt });

  await onEvent?.("generating_code", "Applying changes to Python project…");
  const parsed = await callWithRetry(
    messages,
    modelFor(agentMode),
    32000,
    "python-refine",
    undefined,
    "refine",
    agentMode,
  );

  const rawFiles = Array.isArray(parsed.files) ? parsed.files : [];
  let changedFiles: BuilderFile[] = rawFiles
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
  const unchangedFiles = Array.isArray(parsed.unchangedFiles)
    ? parsed.unchangedFiles.filter((p): p is string => typeof p === "string")
    : [];

  const { files: sanitisedChangedFiles } = scanForSecrets(changedFiles);
  changedFiles = sanitisedChangedFiles;

  const summary = cleanSummary(
    typeof parsed.summary === "string" ? parsed.summary : null,
    `Updated ${changedFiles.length} file(s).`,
  );
  const aiWarnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const integrationsNeeded = Array.isArray(parsed.integrationsNeeded)
    ? (parsed.integrationsNeeded as TaskReport["integrationsNeeded"])
    : [];
  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : "Restart the Flask server to pick up the changes.";

  const existingPaths = new Set(existingFiles.map((f) => f.path));
  const filesCreated = changedFiles.filter((f) => !existingPaths.has(f.path)).map((f) => f.path);
  const filesChanged = changedFiles.filter((f) => existingPaths.has(f.path)).map((f) => f.path);

  const report: TaskReport = {
    userRequest: userPrompt,
    blueprint: null,
    filesCreated,
    filesChanged,
    filesRemoved: removedPaths,
    previewUpdated: false,
    warnings: aiWarnings,
    integrationsNeeded,
    nextRecommendation,
  };

  return {
    changedFiles,
    removedPaths,
    unchangedFiles,
    report,
    assistantSummary: summary,
    correctionPasses: 0,
    correctionFailed: false,
    primaryErrorCategory: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent classification — one closed answer / clarify / plan / mutate / observe contract
// ─────────────────────────────────────────────────────────────────────────────

export type IntentResult = {
  intent: "answer" | "clarify" | "plan" | "mutate" | "observe";
  /** What the pre-receipt router would have done, retained only for comparison logging. */
  legacyIntent: "converse" | "plan" | "build" | "debug" | "refactor" | "review" | "explain";
  confidence: number;
  decisionSource: "deterministic_rule" | "classifier" | "classifier_fallback";
};

export const INTENT_CLASSIFIER_SYSTEM = `You are a router for an AI app-builder chat. Read the user's latest message in the context of the recent conversation and classify their true intent into exactly one of:

- "answer": The user is asking a question, requesting an explanation or advice, reacting to a previous result, or chatting about their app. No mutation is requested.
- "clarify": The request is genuinely ambiguous and exactly one focused question is needed before any action can be chosen safely.
- "plan": The user wants a structured plan, architecture overview, or design spec BEFORE building. Examples: "Plan me a dashboard", "Design the data model", "What should I build first?", "Create an architecture plan for..."
- "observe": The user asks to inspect, diagnose, review, test, verify, or explain observed project state without asking for a change.
- "mutate": The user unambiguously instructs you to change code or project state now. Examples: "Add a dark mode toggle", "Fix the login bug", "Create a settings page", "Remove the sidebar".

Direct requests such as "build a...", "create a...", or "I want to build..." are "mutate" unless the user explicitly asks for a plan first.

Reasoning principles (apply in order, BEFORE judging):
1. A question or explanation request with no explicit change instruction is "answer".
2. Short reactions and meta-comments are "answer" unless they contain an explicit change instruction.
3. Asking about a previous error, result, or agent behavior is "answer" unless the user explicitly asks for a repair.
4. A repeat or rephrase is "answer": the user is course-correcting, not requesting another build.
5. Discussion about the product or the agent is "answer".
6. Bug reports and diagnostic requests are "observe" unless the user explicitly asks to fix or change something.
7. Run, test, inspect, and verify requests are "observe" when they ask for evidence only; they are "mutate" only when they explicitly request a repair or change.
8. "mutate" requires an explicit change instruction. Being on-topic about the app is not enough.
9. When genuinely torn between two intents, choose "clarify".

Respond with ONLY valid JSON: {"intent": "answer"|"clarify"|"plan"|"mutate"|"observe", "confidence": 0.0-1.0}

confidence should reflect how certain you are. Use < 0.7 only when the request is genuinely ambiguous between two intents.`;

// Deterministic fast-path: catch obvious conversational messages without an LLM
// round-trip. Prevents short questions like "So what happened?" from being
// misrouted to "build" by gpt-5-nano just because they follow a failed task.
const BUILD_ACTION_VERBS =
  /\b(add|remove|delete|create|build|make|generate|change|update|modify|fix|refactor|implement|set\s*up|setup|install|integrate|wire|connect|enable|disable|hide|show|render|style|design|move|rename|replace|swap|upgrade|migrate|extract|split|merge|deploy|publish|undo|rollback|try\s*again|retry)\b/i;
const QUESTION_STARTERS =
  /^\s*(what|why|how|when|who|where|which|can|could|should|would|is|are|am|do|does|did|will|won't|isn't|aren't|doesn't|didn't)\b/i;
const SHORT_REACTIONS = new Set([
  "ok",
  "okay",
  "thanks",
  "thank you",
  "ty",
  "huh",
  "hmm",
  "wait",
  "hi",
  "hello",
  "yo",
  "cool",
  "nice",
  "got it",
  "sure",
  "yes",
  "no",
  "lol",
]);

// Detect whether the message is phrased as a direct command/imperative
// ("Fix the header", "Add login"). Only true when the very first word is a
// build action verb — questions like "why isn't this fixed?" or "nothing is
// fixed, why?" use the same vocabulary but are NOT imperatives.
const STARTS_WITH_BUILD_IMPERATIVE =
  /^\s*(please\s+|pls\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|i\s+want\s+(?:to\s+)?|i'?d\s+like\s+(?:to\s+)?|let'?s\s+|now\s+|just\s+)?(add|remove|delete|create|build|make|generate|change|update|modify|fix|refactor|implement|set\s*up|setup|install|integrate|wire|connect|enable|disable|hide|show|render|style|design|move|rename|replace|swap|upgrade|migrate|extract|split|merge|deploy|publish|undo|rollback|retry|try\s+again|launch|start|apply|confirm|ensure|complete|finish)\b/i;
const STARTS_WITH_OBSERVE_IMPERATIVE =
  /^\s*(please\s+|pls\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|i\s+want\s+(?:to\s+)?|i'?d\s+like\s+(?:to\s+)?|let'?s\s+|now\s+|just\s+)?(find|look\s+at|look\s+into|check|open|read|examine|investigate|diagnose|debug|inspect|scan|search|analyze|analyse|review|trace|test|run|execute|perform|verify|validate)\b/i;
const STARTS_WITH_PLAN_IMPERATIVE =
  /^\s*(please\s+|pls\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|i\s+want\s+(?:to\s+)?|i'?d\s+like\s+(?:to\s+)?|let'?s\s+|now\s+|just\s+)?(plan|outline|architect|draft\s+(?:a\s+)?plan)\b/i;

// Detect problem / bug reports and diagnostic requests without an explicit
// repair instruction. They route to observation so the agent can establish
// evidence without silently turning the report into a mutation.
const PROBLEM_REPORT_PATTERNS =
  /\b(not\s+(?:working|running|loading|opening|showing|displaying|rendering|responding|found)|doesn'?t\s+(?:work|load|open|run|show|display|respond|function)|isn'?t\s+(?:working|loading|running|opening|showing)|(?:app|page|site|button|form|link|feature|screen|component)\s+(?:is\s+)?(?:not\s+working|broken|blank|empty|crashed?|down|failing|bugged?)|(?:broken|crashed?|glitchy|bugged?)\s*(?:app|page|site)?|white\s+screen|blank\s+(?:screen|page)|nothing\s+(?:works?|happens?|loads?|shows?|displays?)|something(?:\s+is)?\s+(?:wrong|broken|off|not\s+right)|not\s+(?:able\s+to|working\s+at\s+all)|(?:there(?:\s+is|'s)\s+(?:a\s+)?(?:an\s+)?(?:error|bug|issue|problem|glitch))|(?:error|bug|issue|problem|glitch)\s+(?:in|with|on)\s+(?:the\s+)?(?:app|page|site|code)|(?:app|it)\s+(?:is\s+)?(?:not\s+)?(?:running|working)|(?:keeps?\s+(?:crashing|failing|breaking))|(?:can'?t|cannot)\s+(?:open|load|use|access|see|view|click)|(?:stuck|freezing|frozen|hangs?|hanged?)|(?:find|look\s+(?:at|into|for)|check|open|read|examine|investigate|diagnose|debug|inspect|scan|search|analyze|review|trace)\s+(?:the\s+)?(?:logs?|errors?|issues?|bugs?|problems?|console|output|crash|stacktrace|stack\s+trace|exception|warnings?|failures?|files?|code|cause|reason)|(?:the\s+)?(?:logs?|console)\s+(?:show|has|have|says?|shows?|contains?|reports?)|need\s+to\s+(?:find|fix|resolve|debug|diagnose|check|investigate)\s+(?:the\s+)?(?:issue|bug|error|problem|cause|reason)|what(?:'s|\s+is)\s+(?:wrong|the\s+(?:issue|problem|error|bug|cause)))\b/i;

/** Normalize a message for fuzzy "is this the same thing they just said?" comparison. */
function normalizeForRepeatCheck(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Developer intent patterns — checked before the general converse/build routing.
const DEBUG_PATTERNS =
  /\b(stack\s*trace|TypeError|ReferenceError|SyntaxError|exception|is\s+broken|error\s+at|unhandled\s+rejection|crash|debug\s+this|why\s+is\s+this\s+(?:failing|broken|erroring)|traceback|cannot\s+read\s+propert|undefined\s+is\s+not|null\s+is\s+not)\b/i;
const REFACTOR_PATTERNS =
  /\b(refactor|clean\s*up|restructure|improve\s+(?:the\s+)?code|simplify|reorganise|reorganize|extract\s+(?:a\s+)?(?:function|component|class|module)|split\s+(?:this\s+)?(?:into|up)|dry\s+(?:this\s+)?(?:up|out)|remove\s+duplication|make\s+(?:it\s+)?more\s+(?:readable|maintainable|clean))\b/i;
const REVIEW_PATTERNS =
  /\b(review|code\s*review|check\s+my\s+code|audit|look\s+over|critique|give\s+(?:me\s+)?feedback\s+on|what\s+do\s+you\s+think\s+of\s+(?:this\s+)?code|any\s+(?:issues|problems|improvements)\s+(?:with|in)\s+(?:this\s+)?code)\b/i;
const EXPLAIN_PATTERNS =
  /\b(explain|what\s+does\s+(?:this|the)\b|how\s+does\s+(?:this|the)\b|walk\s+me\s+through|take\s+me\s+through|help\s+me\s+understand|break\s+(?:this\s+)?down|what\s+is\s+(?:this\s+)?(?:doing|for|used\s+for)|how\s+(?:does|do)\s+(?:this|the|it)\b|what\s+(?:is|are)\s+(?:this|these)\b)\b/i;

function fastClassify(
  userPrompt: string,
  conversationHistory: ConversationTurn[] = [],
  hasFiles: boolean = false,
): IntentResult | null {
  const trimmed = userPrompt.trim();
  if (!trimmed) return null;

  if (isZeroProjectChoiceCaptureOnlyMessage(trimmed)) {
    return {
      intent: "answer",
      legacyIntent: "converse",
      confidence: 1,
      decisionSource: "deterministic_rule",
    };
  }

  const normalized = trimmed.toLowerCase().replace(/[.!?…]+$/g, "");
  if (SHORT_REACTIONS.has(normalized)) {
    return {
      intent: "answer",
      legacyIntent: "converse",
      confidence: 0.95,
      decisionSource: "deterministic_rule",
    };
  }

  // Developer-specific intents — check early so they take precedence over generic
  // build/converse routing. Only trigger on non-imperative messages (questions or
  // descriptions) that don't look like direct code-change commands.
  if (!STARTS_WITH_BUILD_IMPERATIVE.test(trimmed) || trimmed.endsWith("?")) {
    if (hasFiles && DEBUG_PATTERNS.test(trimmed)) {
      return {
        intent: "observe",
        legacyIntent: "debug",
        confidence: 0.9,
        decisionSource: "deterministic_rule",
      };
    }
    if (REFACTOR_PATTERNS.test(trimmed)) {
      return {
        intent: "mutate",
        legacyIntent: "refactor",
        confidence: 0.9,
        decisionSource: "deterministic_rule",
      };
    }
    if (REVIEW_PATTERNS.test(trimmed)) {
      return {
        intent: "observe",
        legacyIntent: "review",
        confidence: 0.9,
        decisionSource: "deterministic_rule",
      };
    }
    if (EXPLAIN_PATTERNS.test(trimmed)) {
      return {
        intent: "answer",
        legacyIntent: "explain",
        confidence: 0.9,
        decisionSource: "deterministic_rule",
      };
    }
  }

  const isImperative = STARTS_WITH_BUILD_IMPERATIVE.test(trimmed);

  if (STARTS_WITH_PLAN_IMPERATIVE.test(trimmed)) {
    return {
      intent: "plan",
      legacyIntent: "plan",
      confidence: 0.95,
      decisionSource: "deterministic_rule",
    };
  }

  if (STARTS_WITH_OBSERVE_IMPERATIVE.test(trimmed) && !BUILD_ACTION_VERBS.test(trimmed)) {
    return {
      intent: "observe",
      legacyIntent: "build",
      confidence: 0.95,
      decisionSource: "deterministic_rule",
    };
  }

  // Strong build imperative ("Create the app please", "Add login", "Build it") —
  // route directly to the builder. The agentic loop owns the file work; there
  // is no reason to send "please create the app" through the LLM classifier
  // and risk a converse misroute that tells the user to start a new project.
  if (isImperative && !trimmed.endsWith("?")) {
    return {
      intent: "mutate",
      legacyIntent: "build",
      confidence: 0.95,
      decisionSource: "deterministic_rule",
    };
  }

  // Strong signal: any message ending in "?" that is not a direct imperative
  // is a question/conversation, regardless of length or vocabulary used
  // inside it. ("Why isn't it fixed?", "Nothing changed, why?", "How do I
  // make this work?") all → converse.
  if (trimmed.endsWith("?") && !isImperative) {
    return {
      intent: "answer",
      legacyIntent: "converse",
      confidence: 0.95,
      decisionSource: "deterministic_rule",
    };
  }

  // Problem report: investigate and establish evidence. Mutation requires a
  // separate explicit repair instruction.
  // Only applies when there are already files (hasFiles) so we don't fire on
  // vague initial prompts like "there's an issue" before a project exists.
  if (
    hasFiles &&
    !trimmed.endsWith("?") &&
    !QUESTION_STARTERS.test(trimmed) &&
    PROBLEM_REPORT_PATTERNS.test(trimmed)
  ) {
    return {
      intent: "observe",
      legacyIntent: "build",
      confidence: 0.9,
      decisionSource: "deterministic_rule",
    };
  }

  // Repeat / rephrase detection: if the user is re-sending the same (or very
  // similar) message they already sent, and we already responded, they are
  // almost certainly course-correcting / asking for a different answer — not
  // requesting another identical build. Force converse so the next reply is
  // an explanation, not another build pass.
  if (!isImperative && conversationHistory.length >= 2) {
    const currentNorm = normalizeForRepeatCheck(trimmed);
    if (currentNorm.length >= 6) {
      const priorUserTurns = conversationHistory
        .filter((t) => t.role === "user")
        .slice(-3)
        .map((t) => normalizeForRepeatCheck(t.content));
      for (const prior of priorUserTurns) {
        if (!prior) continue;
        if (prior === currentNorm) {
          return {
            intent: "answer",
            legacyIntent: "converse",
            confidence: 0.95,
            decisionSource: "deterministic_rule",
          };
        }
        // High-overlap rephrase: share most non-trivial tokens with a prior
        // user turn (Jaccard ≥ 0.6 on 3+ char tokens).
        const a = new Set(currentNorm.split(" ").filter((w) => w.length >= 3));
        const b = new Set(prior.split(" ").filter((w) => w.length >= 3));
        if (a.size >= 3 && b.size >= 3) {
          let inter = 0;
          for (const w of a) if (b.has(w)) inter++;
          const union = a.size + b.size - inter;
          if (union > 0 && inter / union >= 0.6) {
            return {
              intent: "answer",
              legacyIntent: "converse",
              confidence: 0.9,
              decisionSource: "deterministic_rule",
            };
          }
        }
      }
    }
  }

  // Short messages that start with a question word (what/why/how/...) and
  // are not direct imperatives are also reliably converse.
  const wordCount = trimmed.split(/\s+/).length;
  if (QUESTION_STARTERS.test(trimmed) && !isImperative && wordCount <= 20) {
    return {
      intent: "answer",
      legacyIntent: "converse",
      confidence: 0.9,
      decisionSource: "deterministic_rule",
    };
  }

  return null;
}

export async function runIntentClassifierPipeline(
  userPrompt: string,
  conversationHistory: ConversationTurn[],
  hasFiles: boolean,
): Promise<IntentResult> {
  const fast = fastClassify(userPrompt, conversationHistory, hasFiles);
  if (fast) return fast;
  try {
    // Show more of the back-and-forth so the classifier can spot follow-ups,
    // repeats, and course-corrections instead of judging each message in
    // isolation.
    const recentHistory = conversationHistory.slice(-8);
    const historyText =
      recentHistory.length > 0
        ? recentHistory
            .map((t) => {
              // Trim very long assistant turns (build reports etc.) so the
              // classifier sees the shape of the conversation, not a wall of
              // generated text.
              const body =
                t.role === "assistant" && t.content.length > 600
                  ? `${t.content.slice(0, 600)}… [truncated]`
                  : t.content;
              return `${t.role}: ${body}`;
            })
            .join("\n")
        : "";

    const userContent = [
      historyText ? `Recent conversation:\n${historyText}` : "",
      `Current message: ${userPrompt}`,
      !hasFiles ? "Note: This project has no files yet (no app built)." : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
    const { provider, model } = resolveStageProvider("intent", "lite", "gpt-5-nano");
    const response = await createChatCompletion({
      provider,
      model,
      zeroCall: { tier: "lite", stage: "intent" },
      max_completion_tokens: 60,
      messages: [
        { role: "system", content: INTENT_CLASSIFIER_SYSTEM },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
    const parsed = JSON.parse(raw) as { intent?: string; confidence?: number };
    const intent: IntentResult["intent"] =
      parsed.intent === "answer" ||
      parsed.intent === "clarify" ||
      parsed.intent === "plan" ||
      parsed.intent === "mutate" ||
      parsed.intent === "observe"
        ? parsed.intent
        : "clarify";
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.8;

    if (confidence < 0.7) {
      return {
        intent: "clarify",
        legacyIntent: intent === "mutate" ? "build" : intent === "plan" ? "plan" : "converse",
        confidence,
        decisionSource: "classifier",
      };
    }
    return {
      intent,
      legacyIntent:
        intent === "mutate" || intent === "observe"
          ? "build"
          : intent === "plan"
            ? "plan"
            : "converse",
      confidence,
      decisionSource: "classifier",
    };
  } catch (err) {
    // Safer fallback than "always build": if we can't classify and the
    // message doesn't even contain a build verb, treat it as conversation.
    logger.warn({ err }, "Intent classifier failed, falling back");
    const legacyIntent: IntentResult["legacyIntent"] =
      hasFiles && BUILD_ACTION_VERBS.test(userPrompt) ? "build" : "converse";
    return {
      intent: "clarify",
      legacyIntent,
      confidence: 0.6,
      decisionSource: "classifier_fallback",
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Converse pipeline — answers questions / gives advice without modifying files
// ─────────────────────────────────────────────────────────────────────────────

export type ConverseResult = {
  markdown: string;
  stopEvidence: ConverseStopEvidence;
  clarifying?: {
    question: string;
    options: string[];
  };
};

function createMustaflowPlatformPrimer(): string {
  const { provider } = resolveStageProvider("build", "eco");
  const liteCost = creditCostFor("lite", provider);
  const ecoCost = creditCostFor("eco", provider);
  const powerCost = creditCostFor("power", provider);
  const proCost = creditCostFor("pro", provider);

  return `NABUFLOW PRODUCT KNOWLEDGE — you are the in-app assistant inside NabuFlow, an AI app builder for non-technical users. Know these features cold and reference them by their real names so users can find them in the UI.

WHAT NABUFLOW BUILDS
- Web apps: static HTML/CSS/JS using Tailwind + lucide via CDN (the default and most reliable kind).
- React + Vite, Next.js 14 App Router, Node.js + Express APIs, Python Flask, Python FastAPI — for users who pick those project kinds.
- Mobile apps: Expo SDK 52 + Expo Router + NativeWind (cross-platform iOS + Android). Web preview is an index.html mock; real device requires Expo Go and the QR code in the Preview tab.

WORKSPACE LAYOUT (so you can point users at the right place)
- Left rail: project sections.
- Top tab bar: Preview, Files / Code, Canvas, Tools & Files, Page Map, Publishing, Terminal, Logs, Manage.
- Bottom: the NabuFlow chat (where you live). It has a Plan Mode toggle and a Lite / Eco / Power / Pro agent-mode picker.

AGENT MODES (route to different OpenAI models, different cost in credits)
- Lite (${liteCost} credits) — fastest, smallest model. Quick tweaks, tiny UI changes.
- Eco (${ecoCost} credits) — balanced. Default for most refines.
- Power (${powerCost} credits) — higher-quality model + a critique pass for holistic review.
- Pro (${proCost} credits) — top-tier model + critique pass. Best for complex multi-page or backend work.
- Recommend higher modes only when the request genuinely needs them.

PLAN MODE
- The agent automatically detects planning requests. When a user asks to "plan", "design", "architect", "outline", or "create a spec/blueprint/roadmap", the agent produces a structured plan card (sitemap, pages, data model, integrations, risks, test plan) without writing files.
- Do NOT tell users to "switch to plan mode", "enable plan mode", or "toggle the Plan Mode button" — the agent handles routing automatically.
- The Plan Mode toggle in the UI stays in sync with the agent's auto-detection. Users can also set it manually if they prefer.

PUBLISHING
- Publishing tab freezes the current files into a snapshot and returns a public URL: /api/p/<slug>/ (slug-based, stable across republishes).
- Custom domains: enter a domain in the Domains section, point a CNAME to the platform CNAME target, then click "Check DNS". Auto-subdomain <slug>.mustaflow.app is always available.
- Publish readiness gate runs checks (required secrets set, files present, last build succeeded). Blocking failures stop publish.
- Unpublish clears the public URL; deployment history is preserved.

SECRETS & INTEGRATIONS
- The workspace Secrets tab stores project environment variables. Values are AES-256-GCM encrypted server-side; saved values are returned only as a fixed mask (••••••••).
- Each secret can be verified server-side per category (HTTP ping etc.). Verification status shows in the UI.
- Site settings (title, meta description, theme color) live on the Publishing tab.

CONTAINERS & TERMINAL
- Some projects can run a dedicated Node.js container (Fly.io machine). Lifecycle buttons: Start / Stop / Destroy. Container auto-stops after 10 minutes of inactivity and wakes on next request.
- Terminal tab opens a WebSocket shell into the running container. File saves stream into the live container.

VERSIONS, ROLLBACK, EXPORT, DUPLICATE
- Every successful build snapshots all files. Use the Versions list (Manage tab) to rollback.
- Export downloads a ZIP of all files plus a .env.example (secret names only).
- Duplicate copies metadata + files (skips secrets) into a new project owned by the same user.
- Delete is a 2-step confirmation → soft delete (recoverable only by admin SQL).

KNOWLEDGE VAULT
- Auto-records lessons after every build, refine, rollback, publish, duplicate. Influences future builds.

PREVIEW BEHAVIOUR
- Web preview is sandboxed (allow-scripts allow-forms allow-popups) — no allow-same-origin, so apps cannot reach NabuFlow APIs from the iframe.
- Mobile preview is a static web mock; native features (Camera, Location, Push, Biometrics, MediaLibrary) need Expo Go on a real device.
- "Ask AI to fix this" buttons on validation warnings auto-send a refine request with build intent.

HELPING USERS BUILD THEIR OWN APPS
- When a user describes an idea, suggest the right project kind (web for marketing/landing, React+Vite for SPAs, Node/Flask/FastAPI for backends, mobile-cross for iOS+Android).
- When a feature needs an API key or third-party service (Stripe, Twilio, OpenAI, Sendgrid, Google Maps, etc.), name the integration, list the exact env-var names, and tell the user to add them in Tools & Files → Secrets before retrying.
- When a user is stuck, recommend the concrete tab/button to click in NabuFlow, not just generic web advice.
- If a request is genuinely beyond what static previews can do (real auth, persistent DB, file uploads to S3), say so honestly and suggest the React+Vite or backend kinds, or external services they can integrate.
- Cite the user's own files and existing code when answering. Be specific, not generic.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Developer-intent system prompts
// Each prompt is injected as a systemPromptOverride into runConverseStreamPipeline
// when the corresponding intent is detected (debug / refactor / review / explain).
// ─────────────────────────────────────────────────────────────────────────────

const DEVELOPER_TONE_ADAPTIVE = `Adaptive tone: if the message contains code blocks, file extensions (.js/.ts/.py/.go/.tsx), stack-trace keywords (TypeError, Traceback, at Object, ReferenceError, Exception), or explicit technical terminology — respond with precise technical language, exact symbol names, and concrete code examples. Otherwise use plain, accessible language.`;

export const DEBUG_SYSTEM_PROMPT = `You are a senior debugger embedded in NabuFlow. Your job is root-cause analysis and minimal targeted fixes.

${DEVELOPER_TONE_ADAPTIVE}

When the user shares an error, stack trace, or symptom:
1. Read every file snippet in your context that could be related.
2. Identify the EXACT root cause — name the file, function, and line/pattern where the fault originates.
3. Explain why it fails (one short paragraph, technical precision welcome).
4. Provide the minimal fix: show only the changed code, not the whole file. Use a diff-style \`\`\`diff block when the change is surgical.
5. If the fix is simple enough for the builder to apply automatically, end with: "Ready to apply — send any message to let the builder patch it."

Never speculate with multiple "maybe" causes. Pick the most likely one. If you genuinely cannot determine the cause from the snippets available, name exactly which file you need in full and ask the user to trigger the builder.`;

export const REFACTOR_SYSTEM_PROMPT = `You are a senior software engineer reviewing code for quality and maintainability. Your goal: preserve existing behaviour while improving structure.

${DEVELOPER_TONE_ADAPTIVE}

Refactoring principles to apply:
- Extract repeated logic into named functions or hooks.
- Replace magic strings/numbers with named constants.
- Simplify deeply nested conditionals (early returns, guard clauses).
- Enforce consistent naming conventions across the file.
- Remove dead code and unused imports.
- Break large functions (>40 lines) into well-named sub-functions with a single responsibility.
- For TypeScript: tighten loose types, replace \`any\` with proper interfaces.

Format your response:
1. A brief diagnosis of the most impactful issues (bullet list).
2. The refactored code in a code block.
3. A short "What changed" summary listing the specific transformations applied.

If the refactor affects multiple files, describe the cross-file plan first, then show each file's change.`;

export const REVIEW_SYSTEM_PROMPT = `You are a senior engineer conducting a thorough code review. Produce a structured, actionable review.

${DEVELOPER_TONE_ADAPTIVE}

Review the provided code across these dimensions and output findings in this exact structure:

## Critical
Issues that will cause bugs, security vulnerabilities, data loss, or broken behaviour. Must be fixed before shipping.

## Warnings
Code smells, performance issues, accessibility gaps, unhandled edge cases. Should be addressed but won't break things today.

## Suggestions
Style, maintainability, and best-practice improvements. Nice to have.

## Summary
One paragraph verdict: overall quality, biggest win, recommended next action.

Be specific: cite the exact function name, variable, or line pattern. Avoid generic advice. If the code is clean in a dimension, say "None" for that section rather than inventing issues.`;

export const EXPLAIN_SYSTEM_PROMPT = `You are a senior engineer explaining code to a colleague. Provide deep technical explanation with architectural context.

${DEVELOPER_TONE_ADAPTIVE}

Structure your explanation:
1. **What it does** — one sentence purpose statement.
2. **How it works** — walk through the logic step by step, referencing actual variable names and control flow from the code.
3. **Why it's designed this way** — architectural rationale: trade-offs made, patterns used (e.g. singleton, observer, factory), constraints respected.
4. **Key details to know** — edge cases handled, hidden assumptions, gotchas, or subtle behaviours the reader should not miss.
5. **Related files / dependencies** — what else this code talks to and why.

Use code blocks to illustrate specific points. Keep explanations precise; avoid over-simplifying for non-technical readers unless the user's question is clearly non-technical.`;

export function createConverseSystemPrompt(): string {
  return `You are the NabuFlow assistant for an AI app builder. You help users understand their app, answer questions, give advice, explain code, and guide them through NabuFlow's features. In this mode you are explaining, not editing — but you ARE a full-capability builder in other modes.

${DEVELOPER_TONE_ADAPTIVE}

${createMustaflowPlatformPrimer()}

CRITICAL — do not misrepresent your capabilities:
- You CAN build, edit, and refine apps. You have a real tool-calling agent loop that reads/writes files, runs commands inside the project's container, runs tests, and iterates until checks pass. You are NOT an "advisory copilot that cannot modify files."
- The user is already inside a project. NEVER tell them to "create a new project" or "go to the project creation flow" to get changes made — they are already there. If they want changes to THIS project, the next message they send (without Plan Mode on) will run the builder.
- If a user asks you to build/create/add/change something in this mode, briefly acknowledge what they want, then tell them to resend the request (or hit send again) and the builder will run it — do NOT tell them you lack the ability.
- You are answering in this turn only because the previous classifier picked "explain", not because you lack tools.
- You CAN generate images inline in this chat. NabuFlow has an Image Studio and an inline image generation feature. If the user asks you to generate, create, draw, render, or make any kind of image, picture, graphic, visual, logo, banner, or illustration — do NOT say you cannot do this. Tell them: "Just resend that as an image request — type something like 'generate a [description]' and I'll create it right here in the chat."

BUG REPORTS & DIAGNOSTIC REQUESTS — always investigate, never deflect:
- If the user describes a problem OR asks you to investigate one ("find the issue", "open the logs", "check what's wrong", "look at the errors", "why is it broken") — you MUST investigate immediately using the file contents provided below.
- NEVER say "I can't open tabs", "I can't access the logs", "I don't have access to files", "in this turn I can't read", or anything similar. You DO have the file contents in your context — use them.
- Read the actual file snippets provided. Look for: import errors, missing exports, broken native module references, platform guard omissions, unresolved dependencies, syntax errors, misconfigured routes, missing environment variables, and crash-prone startup code.
- Name the SPECIFIC file, line/section, and suspected cause. Do not give generic guesses — reference what you actually see in the file content.
- After your diagnosis, say: "I'll fix this now — just send any message (or tap the send button) and the builder will apply the repair."
- If the file content snippets are too short to confirm the cause, say exactly which file you need to read in full and redirect the user to send any message so the builder can run a complete file inspection and fix loop.

NEVER DO THESE THINGS — absolute prohibitions:
- NEVER write a pre-written message for the user to copy-paste and send.
- NEVER say "Send this as your next message", "Copy this message", "Paste this into the chat", "Use this prompt", or anything that asks the user to manually trigger an action you should be doing yourself.
- NEVER produce a "Next steps:" section that instructs the user to copy-paste text or re-send a request. The agent can do the work — it must not delegate work back to the user through copy-paste instructions.
- NEVER analyze what needs to happen, list it out, and then tell the user to trigger it. If the user asked to run something, test something, verify something, or execute something — respond with one sentence: "I'll do that now — just send any message and I'll run it." Do NOT explain what the test would cover in detail. Do NOT pre-write the command.
- NEVER explain what YOU would do "if asked to build". If there's work to be done, say you'll do it and tell the user to trigger it with any message.

Your responses:
- Are clear, concise, and in plain Markdown (use headings, lists, bold, code blocks as appropriate)
- Reference the user's actual files and code when relevant
- Reference the specific NabuFlow tab/button/setting by its real name when guiding the user
- Only suggest "Next steps:" for things the USER controls (UI settings, external config, third-party services) — never for actions the agent should take itself
- Stay friendly and practical — you're a knowledgeable co-pilot AND a builder, not just a code generator
- Never produce JSON, build reports, or file modifications in this mode
- Keep responses focused — 2-4 paragraphs for explanations, shorter for simple questions
- If the user asks something you genuinely don't know about their codebase, say so and tell them which file or tab to check`;
}

/** Static compatibility export for prompt-evaluation tooling. Runtime paths use the factory. */
export const CONVERSE_SYSTEM_PROMPT = createConverseSystemPrompt();

const CLARIFY_SYSTEM_PROMPT = `You are the NabuFlow assistant. The user's request is ambiguous — it could mean different things. Ask ONE short, friendly clarifying question and provide 2-3 specific quick-reply options.

Respond with ONLY valid JSON: {"question": string, "options": string[]}
- question: a single short sentence asking for clarification
- options: 2-3 specific action chips the user can click (keep each under 8 words)`;

export interface ConverseImageAttachment {
  dataUri: string;
  alt?: string;
}

export async function runConversePipeline(args: {
  projectName: string;
  userPrompt: string;
  conversationHistory: ConversationTurn[];
  currentFiles: { path: string; content: string; mimeType: string }[];
  agentMode: AgentMode;
  isAmbiguous?: boolean;
  imageAttachments?: ConverseImageAttachment[];
  conversationSummary?: string;
  systemPromptOverride?: string;
  taskId?: number;
}): Promise<ConverseResult> {
  const {
    projectName,
    userPrompt,
    conversationHistory,
    currentFiles,
    agentMode,
    isAmbiguous,
    imageAttachments,
    conversationSummary,
    systemPromptOverride,
    taskId,
  } = args;

  if (isAmbiguous) {
    try {
      const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
      const { provider: cProvider, model: cModel } = resolveStageProvider(
        "converse",
        "lite",
        "gpt-5-nano",
      );
      const response = await createChatCompletion({
        provider: cProvider,
        model: cModel,
        taskId,
        taskMode: agentMode,
        zeroCall: { tier: agentMode, stage: "converse" },
        max_completion_tokens: 200,
        messages: [
          { role: "system", content: CLARIFY_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      });
      const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
      const parsed = JSON.parse(raw) as { question?: string; options?: unknown[] };
      const question =
        typeof parsed.question === "string" && parsed.question.trim()
          ? parsed.question.trim()
          : "Could you clarify what you'd like to do?";
      const options = Array.isArray(parsed.options)
        ? parsed.options.filter((o): o is string => typeof o === "string").slice(0, 3)
        : ["Explain how it works", "Build something new", "Create a plan first"];
      const stopEvidence = requireCleanConverseCompletion(
        completionSummaryFromResponse({
          finishReason: response.choices[0]?.finish_reason ?? null,
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? undefined,
          refusal: Boolean(response.choices[0]?.message?.refusal),
        }),
        question,
      );
      return { markdown: question, stopEvidence, clarifying: { question, options } };
    } catch (err) {
      if (err instanceof ConverseCompletionInterruptedError) throw err;
      logger.warn({ err }, "Clarify call failed, falling through to converse");
    }
  }

  // Build file context: path + up to 1200 chars of content per file, 20 files max.
  // Enough for the AI to actually read startup code, imports, and key logic —
  // not just guess from filenames. Short files are included in full.
  const fileContext =
    currentFiles.length > 0
      ? currentFiles
          .slice(0, 20)
          .map((f) => {
            const snippet = f.content.slice(0, 1200).trim();
            const truncated = f.content.length > 1200;
            return `--- ${f.path} ---\n${snippet}${truncated ? "\n…(truncated)" : ""}`;
          })
          .join("\n\n")
      : "No files yet — the app hasn't been built.";

  const effectiveSystemPrompt = systemPromptOverride ?? createConverseSystemPrompt();
  const model = modelFor(agentMode);

  type TextPart = { type: "text"; text: string };
  type ImagePart = { type: "image_url"; image_url: { url: string } };
  type ChatMsg =
    | { role: "system" | "assistant"; content: string }
    | { role: "user"; content: string | Array<TextPart | ImagePart> };

  const messages: ChatMsg[] = [
    { role: "system", content: effectiveSystemPrompt },
    {
      role: "system",
      content: `Project: "${projectName}"\n\nCurrent files:\n${fileContext}`,
    },
  ];

  if (conversationSummary) {
    messages.push({
      role: "system",
      content: `Earlier conversation context (summary of prior exchanges):\n${conversationSummary}`,
    });
  }

  for (const turn of conversationHistory.slice(-6)) {
    messages.push({ role: turn.role, content: turn.content });
  }

  if (imageAttachments && imageAttachments.length > 0) {
    const parts: Array<TextPart | ImagePart> = [{ type: "text", text: userPrompt }];
    for (const att of imageAttachments) {
      parts.push({ type: "image_url", image_url: { url: att.dataUri } });
    }
    messages.push({ role: "user", content: parts });
  } else {
    messages.push({ role: "user", content: userPrompt });
  }

  try {
    const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
    const { provider: cProvider, model: cModel } = resolveStageProvider(
      "converse",
      agentMode,
      model,
    );
    const response = await createChatCompletion({
      provider: cProvider,
      model: cModel,
      taskId,
      taskMode: agentMode,
      zeroCall: { tier: agentMode, stage: "converse" },
      max_completion_tokens: CONVERSE_MAX_COMPLETION_TOKENS,
      ...(cProvider === "gemini" ? { disableThinking: true } : {}),
      reasoning_effort: "low",
      // OpenAI types accept multimodal content; our local union mirrors that shape.
      messages: messages as Parameters<typeof openai.chat.completions.create>[0]["messages"],
    });
    const completionSummary = completionSummaryFromResponse({
      finishReason: response.choices[0]?.finish_reason ?? null,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? undefined,
      refusal: Boolean(response.choices[0]?.message?.refusal),
    });
    const markdown = response.choices[0]?.message?.content?.trim();
    if (!markdown) {
      requireCleanConverseCompletion(completionSummary, "");
      throw new EmptyCompletionError({
        finishReason: response.choices[0]?.finish_reason ?? null,
        outputTokens: response.usage?.completion_tokens ?? 0,
        reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? undefined,
        refusal: Boolean(response.choices[0]?.message?.refusal),
      });
    }
    const stopEvidence = requireCleanConverseCompletion(completionSummary, markdown);
    return { markdown, stopEvidence };
  } catch (err) {
    logger.error({ err }, "Converse pipeline failed");
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Summarises older conversation turns into a concise bullet-point context
 * block that can be stored in the Knowledge Vault and injected back into
 * the converse pipeline so the AI feels consistent across long sessions.
 */
export async function runConversationSummarizePipeline(
  projectName: string,
  turns: ConversationTurn[],
): Promise<string> {
  const turnText = turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 800)}`)
    .join("\n\n");

  const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
  const { provider: sProv, model: sModel } = resolveStageProvider("converse", "eco", "gpt-5-mini");
  const response = await createChatCompletion({
    provider: sProv,
    model: sModel,
    zeroCall: { tier: "eco", stage: "converse" },
    max_completion_tokens: 600,
    messages: [
      {
        role: "system",
        content: `Summarize the following conversation history for the project "${projectName}".
Focus on: decisions made, user preferences expressed, features discussed, problems solved, and any important context established.
Write 3–6 concise bullet points in plain text. Be factual and specific — this will be used as memory context for future AI responses.`,
      },
      { role: "user", content: turnText },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * Streaming variant of runConversePipeline.
 * Calls `onToken` for each incremental text chunk. Returns the full assembled markdown.
 * The ambiguous/clarifying path uses JSON mode (no streaming) and calls onToken once
 * with the full question text so the caller always gets a consistent stream.
 */
export async function runConverseStreamPipeline(
  args: {
    projectName: string;
    userPrompt: string;
    conversationHistory: ConversationTurn[];
    currentFiles: { path: string; content: string; mimeType: string }[];
    agentMode: AgentMode;
    isAmbiguous?: boolean;
    imageAttachments?: ConverseImageAttachment[];
    conversationSummary?: string;
    signal?: AbortSignal;
    systemPromptOverride?: string;
    taskId?: number;
  },
  onToken: (token: string) => void,
): Promise<ConverseResult> {
  const {
    projectName,
    userPrompt,
    conversationHistory,
    currentFiles,
    agentMode,
    isAmbiguous,
    imageAttachments,
    conversationSummary,
    signal,
    systemPromptOverride,
    taskId,
  } = args;

  // Ambiguous path uses JSON mode — not streamable; call onToken once with full text.
  if (isAmbiguous) {
    try {
      const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
      const { provider: cProvider, model: cModel } = resolveStageProvider(
        "converse",
        "lite",
        "gpt-5-nano",
      );
      const response = await createChatCompletion({
        provider: cProvider,
        model: cModel,
        taskId,
        taskMode: agentMode,
        zeroCall: { tier: agentMode, stage: "converse" },
        max_completion_tokens: 200,
        messages: [
          { role: "system", content: CLARIFY_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      });
      const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
      const parsed = JSON.parse(raw) as { question?: string; options?: unknown[] };
      const question =
        typeof parsed.question === "string" && parsed.question.trim()
          ? parsed.question.trim()
          : "Could you clarify what you'd like to do?";
      const options = Array.isArray(parsed.options)
        ? parsed.options.filter((o): o is string => typeof o === "string").slice(0, 3)
        : ["Explain how it works", "Build something new", "Create a plan first"];
      onToken(question);
      const stopEvidence = requireCleanConverseCompletion(
        completionSummaryFromResponse({
          finishReason: response.choices[0]?.finish_reason ?? null,
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? undefined,
          refusal: Boolean(response.choices[0]?.message?.refusal),
        }),
        question,
      );
      return { markdown: question, stopEvidence, clarifying: { question, options } };
    } catch (err) {
      if (err instanceof ConverseCompletionInterruptedError) throw err;
      logger.warn({ err }, "Clarify call failed, falling through to converse stream");
    }
  }

  const fileContext =
    currentFiles.length > 0
      ? currentFiles
          .slice(0, 20)
          .map((f) => {
            const snippet = f.content.slice(0, 1200).trim();
            const truncated = f.content.length > 1200;
            return `--- ${f.path} ---\n${snippet}${truncated ? "\n…(truncated)" : ""}`;
          })
          .join("\n\n")
      : "No project files yet — starting fresh.";

  const model = modelFor(agentMode);
  const _effectiveSystemPromptStream = systemPromptOverride ?? createConverseSystemPrompt();

  type TextPart = { type: "text"; text: string };
  type ImagePart = { type: "image_url"; image_url: { url: string } };
  type ChatMsg =
    | { role: "system" | "assistant"; content: string }
    | { role: "user"; content: string | Array<TextPart | ImagePart> };

  const messages: ChatMsg[] = [
    { role: "system", content: systemPromptOverride ?? createConverseSystemPrompt() },
    {
      role: "system",
      content: `Project: "${projectName}"\n\nCurrent files:\n${fileContext}`,
    },
  ];

  if (conversationSummary) {
    messages.push({
      role: "system",
      content: `Earlier conversation context (summary of prior exchanges):\n${conversationSummary}`,
    });
  }

  for (const turn of conversationHistory.slice(-6)) {
    messages.push({ role: turn.role, content: turn.content });
  }

  if (imageAttachments && imageAttachments.length > 0) {
    const parts: Array<TextPart | ImagePart> = [{ type: "text", text: userPrompt }];
    for (const att of imageAttachments) {
      parts.push({ type: "image_url", image_url: { url: att.dataUri } });
    }
    messages.push({ role: "user", content: parts });
  } else {
    messages.push({ role: "user", content: userPrompt });
  }

  try {
    // Provider-aware streaming (Task #533 step 4). Anthropic + Gemini deltas
    // are normalized into the same `onToken(delta)` contract as OpenAI's
    // chat completion deltas, so the SSE channel above stays unchanged.
    const { streamChatCompletion, resolveStageProvider } = await import("./ai-providers");
    // Pass `model` (legacy hardcoded OpenAI default for converse streaming)
    // as the openaiOverride so an `AI_PROVIDER_CONVERSE=openai:<model>` env
    // wins, but unset env keeps the historical OpenAI default.
    const { provider: streamProv, model: streamModel } = resolveStageProvider(
      "converse",
      agentMode,
      model,
    );
    let markdown = "";
    const completion = { summary: null as StreamCompletionSummary | null };
    try {
      for await (const delta of streamChatCompletion({
        provider: streamProv,
        model: streamModel,
        taskId,
        taskMode: agentMode,
        zeroCall: { tier: agentMode, stage: "converse" },
        max_completion_tokens: CONVERSE_MAX_COMPLETION_TOKENS,
        ...(streamProv === "gemini" ? { disableThinking: true } : {}),
        reasoning_effort: "low",
        messages: messages as Parameters<typeof streamChatCompletion>[0]["messages"],
        signal,
        onFinish: (summary) => {
          completion.summary = summary;
        },
      })) {
        markdown += delta;
        onToken(delta);
      }
    } catch (error) {
      if (completion.summary) {
        requireCleanConverseCompletion(completion.summary, markdown);
      }
      throw error;
    }
    const stopEvidence = requireCleanConverseCompletion(completion.summary, markdown);
    return { markdown, stopEvidence };
  } catch (err) {
    logger.error({ err }, "Converse stream pipeline failed");
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export const TEST_GENERATION_MAX_STEPS = 10;

export const TEST_GENERATION_SYSTEM_PROMPT = `You are a browser test planner. Given HTML content and a project description, generate a concise test plan (3-${TEST_GENERATION_MAX_STEPS} steps) that verifies the key user-facing functionality.

OUTPUT STRICT JSON matching this exact shape:
{
  "steps": [
    {
      "name": "string — short, human-readable test name",
      "action": "waitForSelector" | "click" | "fill" | "expectText" | "expectVisible" | "expectNotVisible" | "expectTitle" | "expectCount",
      "selector": "CSS selector (omit for expectTitle)",
      "value": "text to match or fill (required for expectText, fill, expectTitle)",
      "timeout": 5000
    }
  ]
}

RULES:
- First step MUST be waitForSelector for a prominent element (h1, main, [role="main"], header, nav, or .container)
- Include expectTitle to verify the page has a meaningful title
- Add 2-4 interaction steps: click a button/link, fill a form if present, expect visible content
- When the description names both invalid and successful form outcomes, exercise both: submit invalid input and assert its user-visible error, then fill valid input, submit, and assert the user-visible success state
- Use CSS selectors that are robust — prefer tag names and roles over fragile class hashes
- Keep selectors simple: h1, button, nav a, form, input[type="email"], .hero, #main, [role="main"]
- Do NOT use XPath or complex pseudo-selectors
- Timeout should be 5000ms for all steps
- Maximum ${TEST_GENERATION_MAX_STEPS} steps total — use only the steps required to exercise every named outcome
- Never include steps that require network requests to external APIs`;

/**
 * Generate a structured test plan (JSON test steps) for an HTML app using AI.
 * Uses gpt-5-mini for speed — this is a lightweight background call.
 */
export async function runTestGenerationPipeline(
  indexHtmlContent: string,
  projectDescription: string,
): Promise<TestPlan | null> {
  try {
    const htmlSnippet = indexHtmlContent.slice(0, 3000);

    const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
    const { provider: tProv, model: tModel } = resolveStageProvider("build", "eco", "gpt-5-mini");
    const response = await createChatCompletion({
      provider: tProv,
      model: tModel,
      zeroCall: { tier: "eco", stage: "build" },
      max_completion_tokens: 800,
      messages: [
        { role: "system", content: TEST_GENERATION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Project description: ${projectDescription.slice(0, 200)}\n\nHTML content (first 3000 chars):\n${htmlSnippet}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { steps?: unknown[] };

    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      logger.warn("Test generation returned no steps");
      return null;
    }

    const validActions = new Set([
      "waitForSelector",
      "click",
      "fill",
      "expectText",
      "expectVisible",
      "expectNotVisible",
      "expectTitle",
      "expectCount",
    ]);

    const steps = parsed.steps
      .filter(
        (s) =>
          s !== null &&
          typeof s === "object" &&
          typeof (s as Record<string, unknown>).name === "string" &&
          typeof (s as Record<string, unknown>).action === "string" &&
          validActions.has((s as Record<string, unknown>).action as string),
      )
      .slice(0, TEST_GENERATION_MAX_STEPS)
      .map((s) => {
        const step = s as Record<string, unknown>;
        return {
          name: String(step.name).slice(0, 100),
          action: step.action as TestPlan["steps"][number]["action"],
          selector: typeof step.selector === "string" ? step.selector : undefined,
          value: typeof step.value === "string" ? step.value : undefined,
          timeout: typeof step.timeout === "number" ? step.timeout : 5000,
        };
      });

    if (steps.length === 0) return null;

    return { steps };
  } catch (err) {
    logger.warn({ err }, "Test generation pipeline failed (non-fatal)");
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser Test Auto-Fix Pipeline
// ─────────────────────────────────────────────────────────────────────────────

const BROWSER_FIX_SYSTEM_PROMPT = `You are a senior web developer fixing specific browser test failures.
The app was loaded in headless Chromium and these issues were found at runtime.
Your job is to fix ONLY the reported failures — do not redesign, restructure, or rewrite working parts.

OUTPUT STRICT JSON:
{
  "files": [{ "path": string, "content": string, "mimeType": string }]
}

Rules:
- Return ONLY the files that genuinely need changes, with their full corrected content
- If a JavaScript console error occurred (e.g. "Uncaught ReferenceError: foo is not defined"), fix the JS
- If a network request failed, replace it with a local fallback or remove it
- If an element selector was not found, ensure that element exists in the HTML with the expected tag/class
- If a button click threw an error, fix the event handler
- Do NOT return files you did not change
- Do NOT change styles, colours, layout, or content that was not involved in the failure`;

/**
 * AI pipeline that fixes specific browser test failures found by headless Chromium.
 * Targeted: only touches files involved in the reported failures.
 * Non-fatal — returns null on any error.
 */
export async function runBrowserTestFixPipeline(
  files: BuilderFile[],
  failures: Array<{
    name: string;
    message: string;
    consoleErrors?: string[];
    networkFailures?: Array<{ url: string; message: string }>;
  }>,
  projectDescription: string,
): Promise<BuilderFile[] | null> {
  try {
    const failureText = failures
      .map((f, i) => {
        const lines: string[] = [`${i + 1}. "${f.name}" — FAILED`];
        if (f.message) lines.push(`   Error: ${f.message}`);
        if (f.consoleErrors?.length) {
          lines.push(`   Console errors: ${f.consoleErrors.slice(0, 3).join("; ")}`);
        }
        if (f.networkFailures?.length) {
          lines.push(
            `   Network failures: ${f.networkFailures
              .slice(0, 2)
              .map((n) => `${n.url} (${n.message})`)
              .join("; ")}`,
          );
        }
        return lines.join("\n");
      })
      .join("\n");

    const fileContext = files
      .map((f) => `=== ${f.path} ===\n${f.content.slice(0, 4000)}`)
      .join("\n\n")
      .slice(0, 20000);

    const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
    const { provider, model } = resolveStageProvider("build", "eco", "gpt-5-mini");
    const response = await createChatCompletion({
      provider,
      model,
      zeroCall: { tier: "eco", stage: "build" },
      max_completion_tokens: 4000,
      messages: [
        { role: "system", content: BROWSER_FIX_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Project: ${projectDescription.slice(0, 200)}\n\nBrowser test failures:\n${failureText}\n\nCurrent files:\n${fileContext}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      files?: Array<{ path: string; content: string; mimeType?: string }>;
    };

    if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
      logger.info("Browser fix pipeline returned no file changes");
      return null;
    }

    const fixedFiles: BuilderFile[] = parsed.files
      .filter((f) => f.path && typeof f.content === "string")
      .map((f) => ({
        path: f.path,
        content: f.content,
        mimeType: f.mimeType ?? guessMime(f.path),
      }));

    return fixedFiles.length > 0 ? fixedFiles : null;
  } catch (err) {
    logger.warn({ err }, "Browser test fix pipeline failed (non-fatal)");
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CVE Auto-Protect Patch Pipeline
// ─────────────────────────────────────────────────────────────────────────────

export type CvePatchFile = {
  path: string;
  content: string;
};

export type CvePatchResult = {
  patchedFiles: CvePatchFile[];
  summary: string;
  error?: string;
};

const CVE_PATCH_SYSTEM_PROMPT = `You are a dependency security patcher. Given a CVE advisory and the current contents of a package.json or pnpm-workspace.yaml, you output a minimal patch that upgrades the affected package to the patched version.

Rules:
- Only change the version of the specific affected package — do not touch any other dependency.
- If the file is package.json: update the version in dependencies, devDependencies, peerDependencies, or overrides as appropriate.
- If the file is pnpm-workspace.yaml: update the version in the catalog section.
- Preserve all formatting, indentation, and comments as closely as possible.
- If the patched version is null or unknown, use the "latest" tag as a safe fallback.
- If the package is not found in the file, return the file unchanged.

OUTPUT STRICT JSON:
{
  "files": [{ "path": string, "content": string }],
  "summary": "One sentence describing what was changed."
}`;

/**
 * AI pipeline that generates a minimal dependency upgrade patch for a given CVE.
 * Takes the CVE advisory details and the current package files, returns updated file contents.
 */
export async function runCvePatchPipeline(opts: {
  packageName: string;
  currentVersion: string | null;
  patchedVersion: string | null;
  cveId: string | null;
  title: string | null;
  existingFiles: BuilderFile[];
}): Promise<CvePatchResult> {
  const { packageName, currentVersion, patchedVersion, cveId, title, existingFiles } = opts;

  const targetVersion = patchedVersion ?? "latest";
  const cveLabel = cveId ? ` (${cveId})` : "";
  const titleLabel = title ? `: ${title}` : "";

  const relevantFiles = existingFiles.filter(
    (f) => f.path === "package.json" || f.path === "pnpm-workspace.yaml",
  );

  if (relevantFiles.length === 0) {
    return {
      patchedFiles: [],
      summary: `No package.json or pnpm-workspace.yaml found to patch for ${packageName}.`,
    };
  }

  const filesContext = relevantFiles.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n\n");

  const userMessage = `CVE Advisory${cveLabel}${titleLabel}

Vulnerable package: ${packageName}
Current version: ${currentVersion ?? "unknown"}
Patched version: ${targetVersion}

Files to patch:
${filesContext}

Please upgrade "${packageName}" from "${currentVersion ?? "unknown"}" to "${targetVersion}" in the relevant file(s) above.`;

  try {
    const { createChatCompletion, resolveStageProvider } = await import("./ai-providers");
    const { provider: cveProv, model: cveModel } = resolveStageProvider(
      "refine",
      "eco",
      "gpt-5-mini",
    );
    const response = await createChatCompletion({
      provider: cveProv,
      model: cveModel,
      zeroCall: { tier: "eco", stage: "build" },
      max_completion_tokens: 2000,
      messages: [
        { role: "system", content: CVE_PATCH_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as { files?: CvePatchFile[]; summary?: string };

    if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
      return {
        patchedFiles: [],
        summary: `AI patch generation returned no files for ${packageName}${cveLabel}.`,
        error: "No files returned by AI",
      };
    }

    const validFiles = parsed.files.filter(
      (f) =>
        typeof f.path === "string" &&
        typeof f.content === "string" &&
        (f.path === "package.json" || f.path === "pnpm-workspace.yaml"),
    );

    return {
      patchedFiles: validFiles,
      summary: parsed.summary ?? `Upgraded ${packageName} to ${targetVersion}${cveLabel}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logger.warn({ err, packageName, cveId }, "CVE patch pipeline failed");
    return {
      patchedFiles: [],
      summary: `Patch generation failed for ${packageName}${cveLabel}.`,
      error: message,
    };
  }
}

export function normalizePath(p: string): string {
  let clean = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (clean.includes("..")) {
    throw new Error(`Unsafe file path: ${p}`);
  }
  if (clean === "") clean = "index.html";
  return clean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan Mode Leadership — Task #635
// ─────────────────────────────────────────────────────────────────────────────

export type PlanBuildStep = {
  stepNumber: number;
  title: string;
  description: string;
  prompt: string;
  files: string[];
  dependsOn: number[];
  estimatedSeconds: number;
};

export type PlanDecomposeResult = {
  steps: PlanBuildStep[];
  totalEstimatedSeconds: number;
  summary: string;
};

const PLAN_DECOMPOSE_SYSTEM_PROMPT = `You are the NabuFlow Planner decomposing a high-level app plan into a sequence of discrete, ordered build steps.

Each step should be self-contained enough that an AI builder can execute it independently in sequence. Steps must be ordered so that each step builds on top of the previous.

OUTPUT STRICT JSON:
{
  "steps": [
    {
      "stepNumber": integer (1-based),
      "title": string (short title, e.g. "Set up project scaffold and routing"),
      "description": string (what gets built in this step, 1-2 sentences),
      "prompt": string (the exact build prompt to send for this step — specific, actionable, imperative),
      "files": string[] (list of key files this step creates or modifies),
      "dependsOn": integer[] (step numbers this step depends on, empty for step 1),
      "estimatedSeconds": integer (realistic estimate for this step alone)
    }
  ],
  "totalEstimatedSeconds": integer,
  "summary": string (1 sentence describing the decomposition strategy)
}

Rules:
- Produce 3-6 steps total. Never more than 8.
- Step 1 must always be the project scaffold / foundation (routing, layout, base styles).
- Steps must be ordered — no circular dependencies.
- Each "prompt" must be a standalone instruction the builder can execute (imperative, specific).
- Steps should be roughly equal in size — avoid one huge step followed by trivial ones.
- Do NOT plan for deployment, testing infrastructure, or CI/CD — focus on the app itself.
- Output ONLY valid JSON — no prose, no code fences.`;

export async function runPlanDecomposePipeline(args: {
  projectName: string;
  projectKind: string;
  plan: Record<string, unknown>;
  agentMode: AgentMode;
  deepReasoning?: boolean;
}): Promise<PlanDecomposeResult> {
  const { projectName, projectKind, plan, agentMode, deepReasoning = false } = args;

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: PLAN_DECOMPOSE_SYSTEM_PROMPT },
    {
      role: "system",
      content: `Project: "${projectName}" (kind: ${projectKind}).`,
    },
    {
      role: "user",
      content: `Decompose this app plan into ordered build steps:\n\n${JSON.stringify(plan, null, 2)}`,
    },
  ];

  try {
    const result = await runPlanningBrain<Record<string, unknown>>({
      entryPoint: "decompose",
      mode: agentMode,
      deepReasoning,
      systemPrompt: PLAN_DECOMPOSE_SYSTEM_PROMPT,
      messages: messages.slice(1),
      maxCompletionTokens: 4000,
    });

    const steps = Array.isArray(result.steps) ? (result.steps as PlanBuildStep[]) : [];
    const totalEstimatedSeconds =
      typeof result.totalEstimatedSeconds === "number"
        ? result.totalEstimatedSeconds
        : steps.reduce((sum, s) => sum + (s.estimatedSeconds ?? 0), 0);
    const summary =
      typeof result.summary === "string"
        ? result.summary
        : `Decomposed into ${steps.length} build steps.`;

    return { steps, totalEstimatedSeconds, summary };
  } catch (err) {
    logger.error({ err, projectName }, "Plan decompose pipeline failed");
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Slides pipeline — Reveal.js HTML presentation
// ─────────────────────────────────────────────────────────────────────────────

const SLIDES_BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder. You generate complete, self-contained Reveal.js HTML slide decks from a single user request.

CRITICAL: Your entire response MUST be a single valid JSON object — no markdown, no code fences, no extra text.

Output schema:
{
  "summary": "one-sentence description of the deck",
  "files": [
    { "path": "index.html", "content": "<full HTML>" }
  ]
}

RULES FOR THE HTML:
- Load Reveal.js 4.x from CDN: https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.js and https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.css
- Choose a built-in theme (black, white, league, beige, sky, night, serif, simple, solarized) via CDN
- Place all slides inside <div class="reveal"><div class="slides">…</div></div>
- Each slide is a <section> element; nested sections create vertical stacks
- Use <aside class="notes">…</aside> inside each <section> for speaker notes
- Initialise with: Reveal.initialize({ hash: true, transition: 'slide' });
- Inline all CSS customisations in a <style> tag; do not reference external files
- Produce at least 6 slides with clear headings, bullets, and rich content
- Use appropriate HTML elements: <h1>/<h2>, <ul>/<li>, <table>, <blockquote>, <code>
- Make the design visually polished with custom colours or backgrounds where appropriate`;

const SLIDES_REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder, refining an existing Reveal.js slide deck.

CRITICAL: Your entire response MUST be a single valid JSON object — no markdown, no code fences, no extra text.

Output schema:
{
  "summary": "what changed",
  "changedFiles": [{ "path": "index.html", "content": "<full updated HTML>" }],
  "removedPaths": []
}

Apply the user's requested changes while keeping all existing slides unless explicitly told to remove them.
Preserve the Reveal.js CDN setup and initialisation.

${REFINE_SCOPE_CLOSER}`;

// ─────────────────────────────────────────────────────────────────────────────
// Animation pipeline — React + Framer Motion via CDN (single index.html)
// ─────────────────────────────────────────────────────────────────────────────

const ANIMATION_BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder. You generate self-contained animated web experiences using React and Framer Motion loaded from CDN — no bundler, no npm.

CRITICAL: Your entire response MUST be a single valid JSON object — no markdown, no code fences, no extra text.

Output schema:
{
  "summary": "one-sentence description of the animation",
  "files": [
    { "path": "index.html", "content": "<full HTML>" }
  ]
}

RULES FOR THE HTML:
- Load React 18 + ReactDOM via: https://cdn.jsdelivr.net/npm/react@18/umd/react.development.js and https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.development.js
- Load Framer Motion via: https://cdn.jsdelivr.net/npm/framer-motion@11/dist/framer-motion.js (exposes window.FramerMotion)
- Load Babel standalone: https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js
- Write React code inside <script type="text/babel"> … </script>
- Destructure from window.FramerMotion: const { motion, AnimatePresence, useAnimation } = window.FramerMotion;
- Render with ReactDOM.createRoot(document.getElementById('root')).render(<App />);
- The animation must auto-play on page load with no user interaction required
- Use only GPU-friendly CSS properties for animations: translate, scale, opacity, rotate
- Make the design visually rich: gradient backgrounds, bold typography, dynamic colours
- Target at least 4–6 distinct animation segments that tell a visual story
- Inline all styles; do not reference external CSS files`;

const ANIMATION_REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder, refining an existing animated web experience.

CRITICAL: Your entire response MUST be a single valid JSON object — no markdown, no code fences, no extra text.

Output schema:
{
  "summary": "what changed",
  "changedFiles": [{ "path": "index.html", "content": "<full updated HTML>" }],
  "removedPaths": []
}

Apply the user's requested changes while preserving the CDN setup (React, Framer Motion, Babel) and the auto-play behaviour.

${REFINE_SCOPE_CLOSER}`;

// ─────────────────────────────────────────────────────────────────────────────
// Automation pipeline — Node.js script + cron.json + README.md
// ─────────────────────────────────────────────────────────────────────────────

const AUTOMATION_BUILD_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder. You generate Node.js automation scripts from a single user request.

CRITICAL: Your entire response MUST be a single valid JSON object — no markdown, no code fences, no extra text.

Output schema:
{
  "summary": "one-sentence description of the automation",
  "files": [
    { "path": "automation.js", "content": "…" },
    { "path": "cron.json", "content": "…" },
    { "path": "README.md", "content": "…" }
  ]
}

RULES:
- automation.js: a complete, runnable Node.js ESM script. Must have:
  - A clear main() async function with try/catch error handling
  - Console log at each key step (start, fetch, transform, write/send, done)
  - Graceful degradation when env vars are missing (log a warning, skip the step)
  - No external bundler needed — use built-in node: modules + minimal npm deps
  - A --dry-run CLI flag that logs what would happen without actually doing it
- cron.json: a JSON object { "schedule": "<cron expression>", "timezone": "UTC", "description": "…" }
- README.md: must include:
  - Overview: what the script does and why
  - Setup: npm install command, list of required env vars with descriptions
  - Usage: how to run manually, how to use --dry-run, how to schedule with cron or a platform
  - Output: what files/emails/requests are produced
  - Extending: how to customise the script for different data sources or destinations`;

const AUTOMATION_REFINE_SYSTEM_PROMPT = `You are Zero, the NabuFlow builder, refining an existing Node.js automation script.

CRITICAL: Your entire response MUST be a single valid JSON object — no markdown, no code fences, no extra text.

Output schema:
{
  "summary": "what changed",
  "changedFiles": [{ "path": "…", "content": "…" }],
  "removedPaths": []
}

Apply the user's requested changes while preserving the --dry-run flag, error handling, and README.md structure.

${REFINE_SCOPE_CLOSER}`;

// ─────────────────────────────────────────────────────────────────────────────
// Exported pipeline functions for slides, animation, automation
// ─────────────────────────────────────────────────────────────────────────────

export async function runSlidesBuildPipeline(args: StackBuildArgs): Promise<BuilderResult> {
  return runStackBuildPipeline(args, SLIDES_BUILD_SYSTEM_PROMPT, "Slides");
}

export async function runSlidesRefinePipeline(args: StackRefineArgs): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedFiles: string[];
  report: TaskReport;
  assistantSummary: string;
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
}> {
  return runStackRefinePipeline(args, SLIDES_REFINE_SYSTEM_PROMPT, "Slides");
}

export async function runAnimationBuildPipeline(args: StackBuildArgs): Promise<BuilderResult> {
  return runStackBuildPipeline(args, ANIMATION_BUILD_SYSTEM_PROMPT, "Animation");
}

export async function runAnimationRefinePipeline(args: StackRefineArgs): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedFiles: string[];
  report: TaskReport;
  assistantSummary: string;
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
}> {
  return runStackRefinePipeline(args, ANIMATION_REFINE_SYSTEM_PROMPT, "Animation");
}

export async function runAutomationBuildPipeline(args: StackBuildArgs): Promise<BuilderResult> {
  return runStackBuildPipeline(args, AUTOMATION_BUILD_SYSTEM_PROMPT, "Automation");
}

export async function runAutomationRefinePipeline(args: StackRefineArgs): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  unchangedFiles: string[];
  report: TaskReport;
  assistantSummary: string;
  correctionPasses: number;
  correctionFailed: boolean;
  primaryErrorCategory: string | null;
}> {
  return runStackRefinePipeline(args, AUTOMATION_REFINE_SYSTEM_PROMPT, "Automation");
}

export function guessMime(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "application/typescript";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".py")) return "text/x-python";
  if (lower.endsWith(".go")) return "text/x-go";
  if (lower.endsWith(".mod") || lower.endsWith(".sum")) return "text/plain";
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
  if (lower.endsWith(".toml") || lower.endsWith(".ini") || lower.endsWith(".cfg"))
    return "text/plain";
  return "text/plain";
}
