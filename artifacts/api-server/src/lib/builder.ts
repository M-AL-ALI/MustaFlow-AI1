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

const PREVIEW_NOTE = `IMPORTANT preview-runtime constraints:
- This is a static preview. Generate only safe, self-contained files: HTML, CSS, vanilla JS (or React via CDN inside <script type="text/babel">), images via public CDNs.
- ALWAYS produce an index.html. Multi-page apps use additional .html files with relative links (e.g. <a href="./about.html">).
- Use Tailwind via the CDN: <script src="https://cdn.tailwindcss.com"></script>. Do NOT reference node_modules, npm packages, or build tools.
- Use lucide icons via CDN if you need icons: <script src="https://unpkg.com/lucide@latest"></script>.
- All <img> src must be absolute https URLs (use https://images.unsplash.com/... or https://picsum.photos/...). Never reference local image files.
- Keep total output under 16,000 characters across all files combined. Pages should be polished and complete, but concise.
- Forms should validate client-side and show a friendly success state — do NOT post to real servers.
- Do not use emojis in copy. Use lucide icons via class="lucide" or inline SVG instead.`;

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

export async function runBuildPipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
}): Promise<BuilderResult> {
  const { projectName, projectKind, userPrompt, agentMode } = args;
  const messages = [
    { role: "system" as const, content: BUILD_SYSTEM_PROMPT },
    {
      role: "system" as const,
      content: `Project: "${projectName}" (kind: ${projectKind}).`,
    },
    { role: "user" as const, content: userPrompt },
  ];

  const response = await openai.chat.completions.create({
    model: modelFor(agentMode),
    max_completion_tokens: 16000,
    messages,
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logger.error({ err, raw: raw.slice(0, 500) }, "Builder JSON parse failed");
    throw new Error("AI builder returned malformed output. Please try again.");
  }

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

  return {
    blueprint,
    files,
    report,
    assistantSummary: summary,
  };
}

export async function runRefinePipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
  existingFiles: BuilderFile[];
}): Promise<{
  changedFiles: BuilderFile[];
  removedPaths: string[];
  report: TaskReport;
  assistantSummary: string;
}> {
  const { projectName, projectKind, userPrompt, agentMode, existingFiles } =
    args;

  const fileManifest = existingFiles
    .map((f) => `--- ${f.path} (${f.mimeType}) ---\n${f.content}`)
    .join("\n\n");

  const messages = [
    { role: "system" as const, content: REFINE_SYSTEM_PROMPT },
    {
      role: "system" as const,
      content: `Project: "${projectName}" (kind: ${projectKind}).\n\nCURRENT PROJECT FILES:\n${fileManifest}`,
    },
    { role: "user" as const, content: userPrompt },
  ];

  const response = await openai.chat.completions.create({
    model: modelFor(agentMode),
    max_completion_tokens: 16000,
    messages,
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logger.error({ err, raw: raw.slice(0, 500) }, "Refine JSON parse failed");
    throw new Error("AI builder returned malformed output. Please try again.");
  }

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

  return {
    changedFiles,
    removedPaths,
    report,
    assistantSummary: summary,
  };
}

export async function runPlanPipeline(args: {
  projectName: string;
  projectKind: string;
  userPrompt: string;
  agentMode: AgentMode;
}): Promise<{ summary: string; plan: Record<string, unknown> | null }> {
  const { projectName, projectKind, userPrompt, agentMode } = args;
  const messages = [
    { role: "system" as const, content: PLAN_SYSTEM_PROMPT },
    {
      role: "system" as const,
      content: `Project: "${projectName}" (kind: ${projectKind}).`,
    },
    { role: "user" as const, content: userPrompt },
  ];

  const response = await openai.chat.completions.create({
    model: modelFor(agentMode),
    max_completion_tokens: 6000,
    messages,
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
  let plan: Record<string, unknown> | null = null;
  try {
    plan = JSON.parse(raw) as Record<string, unknown>;
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
