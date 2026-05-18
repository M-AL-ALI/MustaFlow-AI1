import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";
import type { AgentMode } from "./ai";
import type { TaskReport } from "@workspace/db";

const MODEL_FOR_MODE: Record<AgentMode, string> = {
  lite: "gpt-5-mini",
  eco: "gpt-5-mini",
  power: "gpt-5.4",
  pro: "gpt-5.4",
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

const REFINE_SYSTEM_PROMPT = `You are the MustaFlow AI Builder in CHANGE MODE. You receive the current project files and a change request. You modify the affected files and return the FULL updated file contents (not patches).

${PREVIEW_NOTE}

OUTPUT STRICT JSON matching this exact shape:
{
  "files": [{ "path": string, "content": string, "mimeType": string }],
  "filesRemoved": string[],
  "summary": string,
  "warnings": string[],
  "integrationsNeeded": [{ "name": string, "why": string, "keysNeeded": string[], "environment": "test"|"production" }],
  "nextRecommendation": string
}

The "files" array should contain ONLY the files that were created or changed (full new content). The "filesRemoved" array lists files to delete. Do NOT echo files that are unchanged.`;

const PLAN_SYSTEM_PROMPT = `You are the MustaFlow AI Planner. You do NOT generate code in this mode. You output a structured plan as STRICT JSON only:
{
  "summary": string,
  "goal": string,
  "approach": string,
  "pages": string[],
  "backend": string[],
  "database": string[],
  "integrations": string[],
  "keysNeeded": string[],
  "filesAffected": string[],
  "risks": string[],
  "testPlan": string[]
}
Be concrete. Empty arrays for sections that don't apply.`;

function modelFor(mode: AgentMode): string {
  return MODEL_FOR_MODE[mode] ?? MODEL_FOR_MODE.eco;
}

/**
 * For refine mode: if the full file manifest is too large (> 20k chars),
 * truncate each file body to the first 400 chars to keep the prompt manageable
 * while still giving the AI full awareness of all file paths and types.
 */
function makeCompactManifest(files: BuilderFile[]): string {
  const full = files
    .map((f) => `--- ${f.path} (${f.mimeType}) ---\n${f.content}`)
    .join("\n\n");
  if (full.length <= 20000) return full;
  return files
    .map((f) => {
      const body =
        f.content.length > 400
          ? f.content.slice(0, 400) +
            `\n…(${f.content.length - 400} more chars)`
          : f.content;
      return `--- ${f.path} (${f.mimeType}, ${f.content.length} chars total) ---\n${body}`;
    })
    .join("\n\n");
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

export async function runBuildPipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  conversationHistory?: ConversationTurn[];
  knowledgeContext?: string;
}): Promise<BuilderResult> {
  const { projectName, projectKind, userPrompt, agentMode, conversationHistory, knowledgeContext } = args;

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

  messages.push({
    role: "system",
    content: `Quality mode: ${MODE_QUALITY_HINTS[agentMode]}`,
  });

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  messages.push({ role: "user", content: userPrompt });

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

  if (!files.some((f) => f.path === "index.html")) {
    throw new Error("AI builder did not produce an index.html file.");
  }

  const summary =
    typeof parsed.summary === "string"
      ? parsed.summary
      : `Generated ${files.length} files for ${projectName}.`;
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
  const nextRecommendation =
    typeof parsed.nextRecommendation === "string"
      ? parsed.nextRecommendation
      : "Open the Preview tab to see your app, then tell me what to change.";

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
}): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  report: TaskReport;
  assistantSummary: string;
}> {
  const { projectName, projectKind, userPrompt, agentMode, existingFiles, conversationHistory, knowledgeContext } = args;

  const fileManifest = makeCompactManifest(existingFiles);

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

  messages.push({
    role: "system",
    content: `Quality mode: ${MODE_QUALITY_HINTS[agentMode]}`,
  });

  if (conversationHistory && conversationHistory.length > 0) {
    for (const turn of conversationHistory.slice(-6)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  messages.push({ role: "user", content: userPrompt });

  const parsed = await callWithRetry(messages, modelFor(agentMode), 32000, "refine");

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
    ? parsed.filesRemoved
        .filter((p): p is string => typeof p === "string")
        .map(normalizePath)
    : [];

  const summary =
    typeof parsed.summary === "string"
      ? parsed.summary
      : `Updated ${changedFiles.length} file(s).`;
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string")
    : [];
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
    plan = await callWithRetry(messages, modelFor(agentMode), 6000, "plan");
  } catch {
    plan = null;
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
