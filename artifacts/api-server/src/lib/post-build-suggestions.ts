import { and, desc, eq } from "drizzle-orm";
import {
  chatMessagesTable,
  db,
  projectSuggestionsTable,
  projectsTable,
} from "@workspace/db";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { createChatCompletion } from "./ai-providers";
import { logger } from "./logger";

const VALID_CATEGORIES = new Set(["feature", "fix", "improvement", "idea"]);
const SEMANTIC_RETRY_CATEGORIES = new Set([
  "empty_output",
  "invalid_json",
  "empty_suggestions",
  "invalid_suggestions",
]);

export type PostBuildSuggestion = {
  title: string;
  description: string;
  category: "feature" | "fix" | "improvement" | "idea";
  prompt: string;
};

export type PostBuildSuggestionInput = {
  projectId: number;
  taskId: number;
  projectName: string;
  projectKind: string;
  projectFormat: string;
  userPrompt: string;
  assistantSummary: string;
  filePaths: string[];
  activeIntegrations: string;
};

export type PostBuildSuggestionContext = {
  pageMap: unknown;
  currentPlan: unknown;
  recentTaskId: number;
};

export type SuggestionDiagnostic = {
  finish_reason: string | null;
  reasoning_tokens: number | null;
  output_tokens: number | null;
  parsed_count: number;
  failure_category: string;
};

type CompletionAttempt = {
  suggestions: PostBuildSuggestion[];
  diagnostic: SuggestionDiagnostic;
};

export type SuggestionGenerationResult = {
  count: number;
  source: "model" | "fallback" | "none";
};

export type SuggestionGenerationDependencies = {
  createCompletion: typeof createChatCompletion;
  loadContext: (input: PostBuildSuggestionInput) => Promise<PostBuildSuggestionContext>;
  insertSuggestions: (
    input: PostBuildSuggestionInput,
    suggestions: PostBuildSuggestion[],
  ) => Promise<void>;
  logDiagnostic: (diagnostic: SuggestionDiagnostic) => void;
};

function platformHintFor(input: PostBuildSuggestionInput): string {
  const isMobile = ["mobile-ios", "mobile-android", "mobile-cross"].includes(input.projectKind);
  if (isMobile) return "React Native / Expo mobile app";
  if (input.projectFormat === "react-vite") {
    return "React + Vite web app (TypeScript + Tailwind CSS)";
  }
  return "static web app (HTML/CSS/JS + Tailwind)";
}

function normalizeSuggestion(value: unknown): PostBuildSuggestion | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.title !== "string" ||
    typeof candidate.description !== "string" ||
    typeof candidate.category !== "string" ||
    typeof candidate.prompt !== "string" ||
    !VALID_CATEGORIES.has(candidate.category)
  ) {
    return null;
  }

  const title = candidate.title.trim();
  const description = candidate.description.trim();
  const prompt = candidate.prompt.trim();
  if (!title || !description || !prompt) return null;

  return {
    title: title.slice(0, 120),
    description: description.slice(0, 300),
    category: candidate.category as PostBuildSuggestion["category"],
    prompt: prompt.slice(0, 1000),
  };
}

function usageFrom(response: ChatCompletion): Pick<
  SuggestionDiagnostic,
  "finish_reason" | "reasoning_tokens" | "output_tokens"
> {
  return {
    finish_reason: response.choices[0]?.finish_reason ?? null,
    reasoning_tokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    output_tokens: response.usage?.completion_tokens ?? null,
  };
}

async function runModelAttempt(
  input: PostBuildSuggestionInput,
  dependencies: SuggestionGenerationDependencies,
): Promise<CompletionAttempt> {
  const platformHint = platformHintFor(input);
  const systemPrompt = `You are a senior product and engineering advisor reviewing a just-completed AI-generated ${platformHint} build.
Based on the build context, generate 3-5 specific, actionable next-step suggestions the user could build or improve next.
Each suggestion must be concrete and directly relevant to this project, not generic advice.

Categories:
- feature: a new capability or page to add
- fix: a bug, UX issue, or missing piece to address
- improvement: make existing functionality better, faster, or more polished
- idea: an experimental or innovative enhancement

OUTPUT STRICT JSON:
{
  "suggestions": [
    { "title": "...", "description": "...", "category": "feature|fix|improvement|idea", "prompt": "..." }
  ]
}

Rules:
- title: 3-6 words max, action-oriented
- description: one sentence (max 15 words) explaining the value
- prompt: exact text to feed the refine pipeline, specific and self-contained (30-80 words)
- Mix categories; do not return all features
- Vary difficulty; include at least one quick win and one more ambitious idea
- If active integrations exist, suggest at least one integration-specific improvement`;

  const userContent = `Project: "${input.projectName}" (${platformHint})
Last build request: "${input.userPrompt.slice(0, 200)}"
Build summary: "${input.assistantSummary.slice(0, 300)}"
Files in project: ${input.filePaths.slice(0, 20).join(", ")}
${input.activeIntegrations ? `Active integrations: ${input.activeIntegrations}` : ""}`;

  let response: ChatCompletion;
  try {
    response = await dependencies.createCompletion({
      provider: "openai",
      model: "gpt-5-mini",
      max_completion_tokens: 4000,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    });
  } catch {
    return {
      suggestions: [],
      diagnostic: {
        finish_reason: null,
        reasoning_tokens: null,
        output_tokens: null,
        parsed_count: 0,
        failure_category: "provider_error",
      },
    };
  }

  const usage = usageFrom(response);
  const raw = response.choices[0]?.message?.content ?? "";
  if (!raw.trim()) {
    return {
      suggestions: [],
      diagnostic: {
        ...usage,
        parsed_count: 0,
        failure_category: "empty_output",
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      suggestions: [],
      diagnostic: {
        ...usage,
        parsed_count: 0,
        failure_category: "invalid_json",
      },
    };
  }

  const rawSuggestions =
    parsed && typeof parsed === "object"
      ? (parsed as { suggestions?: unknown }).suggestions
      : undefined;
  if (!Array.isArray(rawSuggestions) || rawSuggestions.length === 0) {
    return {
      suggestions: [],
      diagnostic: {
        ...usage,
        parsed_count: 0,
        failure_category: "empty_suggestions",
      },
    };
  }

  const suggestions = rawSuggestions
    .map(normalizeSuggestion)
    .filter((suggestion): suggestion is PostBuildSuggestion => suggestion !== null)
    .slice(0, 5);
  return {
    suggestions,
    diagnostic: {
      ...usage,
      parsed_count: suggestions.length,
      failure_category: suggestions.length > 0 ? "none" : "invalid_suggestions",
    },
  };
}

type PageCandidate = {
  label: string;
  filePath: string;
};

function firstRealPage(pageMap: unknown): PageCandidate | null {
  if (!pageMap || typeof pageMap !== "object") return null;
  const map = pageMap as Record<string, unknown>;
  for (const platformName of ["web", "ios", "android"]) {
    const platform = map[platformName];
    if (!platform || typeof platform !== "object") continue;
    const nodes = (platform as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const candidate = node as Record<string, unknown>;
      if (
        candidate.planned !== true &&
        typeof candidate.label === "string" &&
        candidate.label.trim() &&
        typeof candidate.filePath === "string" &&
        candidate.filePath.trim()
      ) {
        return {
          label: candidate.label.trim().replace(/\s+/g, " ").slice(0, 60),
          filePath: candidate.filePath.trim(),
        };
      }
    }
  }
  return null;
}

function hasSavedPlan(plan: unknown): boolean {
  if (Array.isArray(plan)) return plan.length > 0;
  return Boolean(plan && typeof plan === "object" && Object.keys(plan).length > 0);
}

export function buildDeterministicFallbackSuggestions(
  context: PostBuildSuggestionContext,
): PostBuildSuggestion[] {
  const suggestions: PostBuildSuggestion[] = [];
  if (Number.isInteger(context.recentTaskId) && context.recentTaskId > 0) {
    suggestions.push({
      title: "Review the latest task",
      description: "Check the latest task against the current project before another change.",
      category: "improvement",
      prompt:
        "Review the most recent build task against the current project files. If the project evidence supports a correction, make one small, focused improvement. Do not add unrelated features or assume requirements that are not present.",
    });
  }

  const page = firstRealPage(context.pageMap);
  if (page) {
    suggestions.push({
      title: `Review ${page.label}`.slice(0, 120),
      description: "Check this existing page for one clear usability improvement.",
      category: "improvement",
      prompt: `Review the existing "${page.label}" page in the current project. Use only its actual files and behavior as evidence, then make one focused usability improvement if warranted. Do not invent features or requirements.`,
    });
  }

  if (hasSavedPlan(context.currentPlan)) {
    suggestions.push({
      title: "Check the saved plan",
      description: "Compare the saved plan with the current project before choosing what is next.",
      category: "idea",
      prompt:
        "Compare the saved plan with the current project files. Identify one explicit plan item that still applies, then propose or make only that next step. Do not infer requirements that are not present in the saved plan.",
    });
  }

  return suggestions.slice(0, 3);
}

async function loadFallbackContext(
  input: PostBuildSuggestionInput,
): Promise<PostBuildSuggestionContext> {
  const [[project], [planMessage]] = await Promise.all([
    db
      .select({ pageMap: projectsTable.pageMapData })
      .from(projectsTable)
      .where(eq(projectsTable.id, input.projectId))
      .limit(1),
    db
      .select({ plan: chatMessagesTable.plan })
      .from(chatMessagesTable)
      .where(
        and(
          eq(chatMessagesTable.projectId, input.projectId),
          eq(chatMessagesTable.role, "assistant"),
          eq(chatMessagesTable.planMode, true),
        ),
      )
      .orderBy(desc(chatMessagesTable.createdAt))
      .limit(1),
  ]);

  return {
    pageMap: project?.pageMap ?? null,
    currentPlan: planMessage?.plan ?? null,
    recentTaskId: input.taskId,
  };
}

async function insertSuggestions(
  input: PostBuildSuggestionInput,
  suggestions: PostBuildSuggestion[],
): Promise<void> {
  await db.insert(projectSuggestionsTable).values(
    suggestions.map((suggestion) => ({
      projectId: input.projectId,
      taskId: input.taskId,
      title: suggestion.title,
      description: suggestion.description,
      category: suggestion.category,
      prompt: suggestion.prompt,
      status: "pending" as const,
    })),
  );
}

function logDiagnostic(diagnostic: SuggestionDiagnostic): void {
  logger.info(diagnostic, "Post-build suggestion generation diagnostic");
}

const DEFAULT_DEPENDENCIES: SuggestionGenerationDependencies = {
  // Keep the provider lookup lazy so jobs.ts remains importable in focused
  // suites that partially mock ai-providers without exercising suggestions.
  createCompletion: (params) => createChatCompletion(params),
  loadContext: loadFallbackContext,
  insertSuggestions,
  logDiagnostic,
};

/**
 * Generates suggestions after task completion. This function is intentionally
 * outside the credit charge path; neither model attempts nor fallback
 * persistence call billing code.
 */
export async function generatePostBuildSuggestions(
  input: PostBuildSuggestionInput,
  dependencies: SuggestionGenerationDependencies = DEFAULT_DEPENDENCIES,
): Promise<SuggestionGenerationResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runModelAttempt(input, dependencies);
    dependencies.logDiagnostic(result.diagnostic);
    if (result.suggestions.length > 0) {
      try {
        await dependencies.insertSuggestions(input, result.suggestions);
        return { count: result.suggestions.length, source: "model" };
      } catch {
        dependencies.logDiagnostic({
          finish_reason: result.diagnostic.finish_reason,
          reasoning_tokens: result.diagnostic.reasoning_tokens,
          output_tokens: result.diagnostic.output_tokens,
          parsed_count: result.suggestions.length,
          failure_category: "persistence_error",
        });
        return { count: 0, source: "none" };
      }
    }

    if (!SEMANTIC_RETRY_CATEGORIES.has(result.diagnostic.failure_category)) break;
  }

  let context: PostBuildSuggestionContext;
  try {
    context = await dependencies.loadContext(input);
  } catch {
    dependencies.logDiagnostic({
      finish_reason: null,
      reasoning_tokens: null,
      output_tokens: null,
      parsed_count: 0,
      failure_category: "context_load_error",
    });
    context = {
      pageMap: null,
      currentPlan: null,
      recentTaskId: input.taskId,
    };
  }

  const fallbacks = buildDeterministicFallbackSuggestions(context);
  if (fallbacks.length === 0) {
    dependencies.logDiagnostic({
      finish_reason: null,
      reasoning_tokens: null,
      output_tokens: null,
      parsed_count: 0,
      failure_category: "fallback_empty",
    });
    return { count: 0, source: "none" };
  }

  try {
    await dependencies.insertSuggestions(input, fallbacks);
    dependencies.logDiagnostic({
      finish_reason: null,
      reasoning_tokens: null,
      output_tokens: null,
      parsed_count: fallbacks.length,
      failure_category: "fallback_used",
    });
    return { count: fallbacks.length, source: "fallback" };
  } catch {
    dependencies.logDiagnostic({
      finish_reason: null,
      reasoning_tokens: null,
      output_tokens: null,
      parsed_count: fallbacks.length,
      failure_category: "persistence_error",
    });
    return { count: 0, source: "none" };
  }
}
