import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { chatMessagesTable, db, projectFilesTable, projectsTable } from "@workspace/db";
import { createChatCompletion } from "./ai-providers";
import { logger } from "./logger";

export type BrainstormMessage = {
  role: "user" | "assistant";
  content: string;
};

export type BrainstormProjectContext = {
  projectId: number;
  projectName: string;
  projectKind: string;
  projectSummary: string | null;
  files: Array<{ path: string; mimeType: string | null; content: string }>;
  currentPlan: Record<string, unknown> | null;
  pageMap: unknown;
};

export type ClarifyingQuestion = {
  id: string;
  question: string;
  hint?: string;
  required: boolean;
};

export type GuidedBrainstormResult = {
  needsClarification: boolean;
  questions: ClarifyingQuestion[];
  clarificationReason: string;
};

/** Budgets include reasoning tokens. Never substitute fake success for invalid output. */
export async function requestBrainstormJson<T>(args: {
  systemPrompt: string;
  messages: BrainstormMessage[];
  schema: z.ZodType<T>;
}): Promise<T> {
  const signal = AbortSignal.timeout(45_000);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal.throwIfAborted();
    const result = await createChatCompletion({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content:
            args.systemPrompt +
            (attempt === 0
              ? ""
              : "\nReturn only a complete JSON object matching the requested fields. Keep it concise."),
        },
        ...args.messages,
      ],
      response_format: { type: "json_object" },
      reasoning_effort: "low",
      max_completion_tokens: attempt === 0 ? 2048 : 4096,
      signal,
    });
    const choice = result.choices[0];
    if (choice?.message?.refusal) throw new Error("brainstorm_response_refused");
    const raw = choice?.message?.content?.trim() ?? "";
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      decoded = null;
    }
    const output = args.schema.safeParse(decoded);
    if (choice?.finish_reason === "stop" && output.success) return output.data;
    logger.warn(
      {
        attempt: attempt + 1,
        finishReason: choice?.finish_reason ?? null,
        contentLength: raw.length,
        completionTokens: result.usage?.completion_tokens ?? null,
        reasoningTokens: result.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      },
      "Brainstorm response was incomplete or invalid",
    );
  }
  throw new Error("brainstorm_response_invalid");
}

const BRAINSTORM_PERSONA = `You are a friendly, concise product ideation partner for NabuFlow.
Help the user clarify what they want by asking one short, focused question at a time.
Use the user's requested language, or otherwise the language of their latest message, including Arabic. Avoid technical jargon. Focus on the product, its users, workflow, and desired outcome.
Acknowledge requirements already supplied. Ask only about a genuinely missing decision; never ask the user to repeat a complete brief. If enough is known, summarize the proposed pages and connections and offer the next step.
For beginners, use a patient guided-refinement style: identify the single most important missing decision and offer a concrete example when helpful.
Never write code, code snippets, implementation patches, or file contents. Brainstorming thinks and clarifies; it never builds.`;

function boundedJson(value: unknown, maxLength = 8_000): string {
  if (value == null) return "None";
  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > maxLength ? `${json.slice(0, maxLength)}\n[truncated]` : json;
  } catch {
    return "Unavailable";
  }
}

export function summarizeBrainstormFiles(files: BrainstormProjectContext["files"]): string {
  if (files.length === 0) return "No project files exist yet.";
  const visible = files.slice(0, 50).map((file) => {
    const firstMeaningfulLine =
      file.content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
        ?.slice(0, 140) ?? "(empty)";
    return `- ${file.path} (${file.mimeType ?? "unknown"}, ${file.content.length} chars): ${firstMeaningfulLine}`;
  });
  if (files.length > visible.length) {
    visible.push(`- …and ${files.length - visible.length} more file(s)`);
  }
  return visible.join("\n");
}

export function formatBrainstormProjectContext(context: BrainstormProjectContext): string {
  return `[CURRENT PROJECT CONTEXT]
Project: "${context.projectName}" (#${context.projectId}, kind: ${context.projectKind})
Project summary: ${context.projectSummary ?? "No summary yet."}

Current file snapshot:
${summarizeBrainstormFiles(context.files)}

Current plan:
${boundedJson(context.currentPlan)}

Current page map:
${boundedJson(context.pageMap)}
[END CURRENT PROJECT CONTEXT]`;
}

export function buildBrainstormChatSystemPrompt(
  context: BrainstormProjectContext | null,
  beginnerMode: boolean,
): string {
  const modeInstruction = beginnerMode
    ? "Use the beginner guided-refinement style: ask especially simple questions, one at a time, with a brief example answer where useful."
    : "Ask one focused clarifying question at a time.";
  const contextInstruction = context
    ? `${formatBrainstormProjectContext(context)}

Reason about THIS existing project and the specific step or decision where the user is stuck. Do not treat this as a greenfield idea unless the context shows the project is empty.`
    : "This is a pre-project brainstorm. Help the user discover and shape an idea without assuming a project already exists.";

  return `${BRAINSTORM_PERSONA}

${modeInstruction}

${contextInstruction}

When the user clearly signals readiness to plan or build, set buildIntent to true.
Respond with valid JSON: {"reply": "...", "buildIntent": false}`;
}

export function buildBrainstormResolveSystemPrompt(
  context: BrainstormProjectContext | null,
  action: "plan" | "build",
): string {
  const contextInstruction = context
    ? `${formatBrainstormProjectContext(context)}

Resolve the conversation as a ${action} request for this existing project. Preserve requested changes and do not reframe it as a new product.`
    : `Resolve the conversation as a ${action} request for a new project.`;

  return `${BRAINSTORM_PERSONA}

${contextInstruction}

Given the conversation, respond with valid JSON containing exactly: name (preserve an explicitly requested project name, up to 80 characters; otherwise suggest a concise name in the user's language), prompt (one clear paragraph of at most 2000 characters summarising what to plan or build, retaining the agreed requirements), kind (either "web" or "mobile-cross" — use "mobile-cross" only if a native iOS/Android app was explicitly discussed).
Do not write code.`;
}

export async function loadBrainstormProjectContext(
  projectId: number,
  userId: string,
): Promise<BrainstormProjectContext | null> {
  const [project] = await db
    .select({
      id: projectsTable.id,
      ownerId: projectsTable.ownerId,
      name: projectsTable.name,
      kind: projectsTable.kind,
      summary: projectsTable.summary,
      description: projectsTable.description,
      pageMapData: projectsTable.pageMapData,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  if (!project || project.ownerId !== userId) return null;

  const [files, latestPlans] = await Promise.all([
    db
      .select({
        path: projectFilesTable.path,
        mimeType: projectFilesTable.mimeType,
        content: projectFilesTable.content,
      })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId)),
    db
      .select({ plan: chatMessagesTable.plan })
      .from(chatMessagesTable)
      .where(and(eq(chatMessagesTable.projectId, projectId), isNotNull(chatMessagesTable.plan)))
      .orderBy(desc(chatMessagesTable.createdAt))
      .limit(1),
  ]);

  return {
    projectId,
    projectName: project.name,
    projectKind: project.kind,
    projectSummary: project.summary ?? project.description ?? null,
    files,
    currentPlan: (latestPlans[0]?.plan as Record<string, unknown> | null) ?? null,
    pageMap: project.pageMapData ?? null,
  };
}

export async function runGuidedBrainstormClarification(args: {
  projectContext: BrainstormProjectContext;
  userPrompt: string;
}): Promise<GuidedBrainstormResult> {
  const systemPrompt = `${buildBrainstormChatSystemPrompt(args.projectContext, true)}

For this compatibility response, return ONLY valid JSON:
{
  "needsClarification": boolean,
  "questions": [{"id": string, "question": string, "hint": string, "required": boolean}],
  "clarificationReason": string
}
Return 2-4 short questions only when clarification is genuinely needed; otherwise return an empty questions array. Never ask about stack, hosting, or database choices.`;

  try {
    const result = await createChatCompletion({
      provider: "openai",
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: args.userPrompt },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 700,
    });
    const raw = result.choices[0]?.message?.content?.trim() ?? "{}";
    const parsed = JSON.parse(raw) as Partial<GuidedBrainstormResult>;
    return {
      needsClarification: Boolean(parsed.needsClarification),
      questions: Array.isArray(parsed.questions)
        ? parsed.questions.filter(
            (question): question is ClarifyingQuestion =>
              Boolean(question) &&
              typeof question.id === "string" &&
              typeof question.question === "string" &&
              typeof question.required === "boolean",
          )
        : [],
      clarificationReason:
        typeof parsed.clarificationReason === "string" ? parsed.clarificationReason : "",
    };
  } catch (err) {
    logger.error(
      { err, projectId: args.projectContext.projectId },
      "Guided brainstorm clarification failed",
    );
    return { needsClarification: false, questions: [], clarificationReason: "" };
  }
}
