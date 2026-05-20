import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";

export type AgentMode = "lite" | "eco" | "power" | "pro";

const MODEL_FOR_MODE: Record<AgentMode, string> = {
  lite: "gpt-5-nano",
  eco: "gpt-5-mini",
  power: "gpt-5.4",
  pro: "gpt-5.4",
};

const SYSTEM_PROMPT = `You are MustaFlow AI, a friendly, focused AI app-building assistant. You help non-technical users plan, design, and build web, iOS, and Android apps. You are concise, encouraging, and never use emojis. You speak in plain English, never jargon.

When the user describes an app idea or a change:
- Restate the goal in one sentence so they know you understood.
- Recommend a concrete next step.
- If something is ambiguous, ask one focused question.
- Keep replies tight (under 180 words unless the user asks for detail).
- Never invent file changes you have not actually performed. The runtime that applies code changes is being built; for now, describe what you would do.`;

const PLAN_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

You are in PLAN MODE. Do not pretend to make changes. Produce a structured plan as STRICT JSON only (no prose, no markdown fences) matching this shape:
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
Be specific but realistic. If a section does not apply, return an empty array.`;

export interface ChatHistoryItem {
  role: "user" | "assistant" | "system";
  content: string;
}

export async function generateAssistantReply(
  projectName: string,
  projectKind: string,
  history: ChatHistoryItem[],
  userContent: string,
  agentMode: AgentMode,
): Promise<string> {
  const model = MODEL_FOR_MODE[agentMode] ?? MODEL_FOR_MODE.eco;
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    {
      role: "system" as const,
      content: `Current project: "${projectName}" (kind: ${projectKind}). Agent mode: ${agentMode}.`,
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userContent },
  ];

  try {
    const response = await openai.chat.completions.create({
      model,
      max_completion_tokens: 8192,
      messages,
    });
    return (
      response.choices[0]?.message?.content?.trim() ??
      "I'm here. Tell me what you'd like to build next."
    );
  } catch (err) {
    logger.error({ err }, "AI chat completion failed");
    return "I had trouble reaching the AI service just now. Please try again in a moment.";
  }
}

export interface PlanResult {
  text: string;
  plan: Record<string, unknown> | null;
}

export async function generatePlan(
  projectName: string,
  projectKind: string,
  history: ChatHistoryItem[],
  userContent: string,
  agentMode: AgentMode,
): Promise<PlanResult> {
  const model = MODEL_FOR_MODE[agentMode] ?? MODEL_FOR_MODE.eco;
  const messages = [
    { role: "system" as const, content: PLAN_SYSTEM_PROMPT },
    {
      role: "system" as const,
      content: `Current project: "${projectName}" (kind: ${projectKind}).`,
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userContent },
  ];

  try {
    const response = await openai.chat.completions.create({
      model,
      max_completion_tokens: 8192,
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
        : "Here's a plan. Review it and choose how to proceed.";
    return { text: summary, plan };
  } catch (err) {
    logger.error({ err }, "AI plan generation failed");
    return {
      text: "I had trouble generating a plan just now. Please try again in a moment.",
      plan: null,
    };
  }
}

export function buildInitialAssistantMessage(projectName: string, initialPrompt: string): string {
  return `Welcome to MustaFlow AI. I've spun up "${projectName}" for you. Here's what I heard:\n\n"${initialPrompt.trim()}"\n\nWhen you're ready, send me a message describing the first thing you want to see, or toggle Plan Mode and I'll lay out a full build plan for your approval.`;
}
