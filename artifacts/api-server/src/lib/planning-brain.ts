import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AgentMode } from "./ai";
import { createChatCompletion, resolveStageProvider } from "./ai-providers";

export type PlanningDepth = "minimal" | "standard" | "deep" | "deepest";
export type PlanningEntryPoint = "planning_agent" | "pro_micro" | "plan_subtasks" | "decompose";

export const PLANNING_DEPTH_FOR_MODE: Record<AgentMode, PlanningDepth> = {
  lite: "minimal",
  eco: "standard",
  power: "deep",
  pro: "deepest",
};

export function resolvePlanningDepth(mode: AgentMode, deepReasoning = false): PlanningDepth {
  return deepReasoning && mode !== "lite" ? "deepest" : PLANNING_DEPTH_FOR_MODE[mode];
}

const DEPTH_INSTRUCTIONS: Record<PlanningDepth, string> = {
  minimal:
    "Planning depth: MINIMAL. Produce the smallest useful outline. Do not reduce the requested app's capability; spend less effort describing it.",
  standard:
    "Planning depth: STANDARD. Cover the complete requested product with a practical implementation sequence and ordinary edge cases.",
  deep: "Planning depth: DEEP. Analyse architecture, dependencies, risks, edge cases, and validation. Check the plan for omissions before returning it.",
  deepest:
    "Planning depth: DEEPEST. Fully reason through architecture, dependencies, risks, validation, and per-step implementation details. Include micro-planning within each step while preserving the requested JSON shape.",
};

export interface PlanningBrainInput {
  entryPoint: PlanningEntryPoint;
  mode: AgentMode;
  deepReasoning?: boolean;
  systemPrompt: string;
  messages: ChatCompletionMessageParam[];
  maxCompletionTokens: number;
  signal?: AbortSignal;
}

async function planningCall<T>(
  input: PlanningBrainInput,
  messages: ChatCompletionMessageParam[],
  reasoningEffort?: "high",
): Promise<T> {
  const depth = resolvePlanningDepth(input.mode, input.deepReasoning);
  const fallbackModel = input.mode === "lite" ? "gpt-5-nano" : "gpt-5-mini";
  const { provider, model } = resolveStageProvider("plan", input.mode, fallbackModel);
  const response = await createChatCompletion({
    provider,
    model,
    zeroCall: { tier: input.mode, stage: "plan" },
    messages: [
      {
        role: "system",
        content: `${input.systemPrompt}\n\n${DEPTH_INSTRUCTIONS[depth]}`,
      },
      ...messages,
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: input.maxCompletionTokens,
    signal: input.signal,
    reasoning_effort: reasoningEffort,
  });
  const raw = response.choices[0]?.message?.content?.trim() ?? "{}";
  return JSON.parse(raw) as T;
}

export async function runPlanningBrain<T>(input: PlanningBrainInput): Promise<T> {
  const depth = resolvePlanningDepth(input.mode, input.deepReasoning);
  const reasoningEffort =
    input.mode === "pro" && input.deepReasoning ? ("high" as const) : undefined;
  const initial = await planningCall<T>(input, input.messages, reasoningEffort);

  if (depth !== "deep") return initial;

  return planningCall<T>(
    input,
    [
      ...input.messages,
      { role: "assistant", content: JSON.stringify(initial) },
      {
        role: "user",
        content:
          "Self-check this plan for missing dependencies, edge cases, and validation. Return the corrected JSON in exactly the same shape.",
      },
    ],
    reasoningEffort,
  );
}

export async function runUpfrontBuildPlan(args: {
  mode: AgentMode;
  deepReasoning: boolean;
  projectName: string;
  userPrompt: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown> | null> {
  if (args.mode === "lite" || (!args.deepReasoning && args.mode !== "pro")) return null;
  return runPlanningBrain<Record<string, unknown>>({
    entryPoint: "pro_micro",
    mode: args.mode,
    deepReasoning: args.deepReasoning,
    systemPrompt:
      'Create a deepest up-front build plan. Return JSON: {"goal": string, "approach": string, "steps": [{"title": string, "details": string, "files": string[]}]}. Do not write code.',
    messages: [
      {
        role: "user",
        content: `Project: "${args.projectName}". Build request: ${args.userPrompt}`,
      },
    ],
    maxCompletionTokens: 1800,
    signal: args.signal,
  });
}
