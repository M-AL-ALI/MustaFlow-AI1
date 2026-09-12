import type { ChatCompletion } from "openai/resources/chat/completions";
import type { CreateChatCompletionParams } from "./ai-providers";

export const AGENT_MODEL_RESPONSE_TOKEN_CAP = 16_384;
export const AGENT_MODEL_RECOVERY_TOKEN_CAP = 8_192;

const INCREMENTAL_BUILD_GUIDANCE =
  "[BOUNDED BUILD TURN] Keep this response to one focused module or patch, or a few small " +
  "complete files. Do not put the whole application into one file or one tool response. " +
  "Split large UI, styles, and server implementations into connected modules. " +
  "Keep every user requirement, backend persistence, integration, and validation requirement. " +
  "Continue building across tool turns; never use placeholders or truncate file contents to fit. " +
  "A saved file is not a completed app: use the existing checks and finalize gates.";

/** Bound output, not the user's scope, provider, model, or existing conversation. */
export function boundedAgentModelTurn(
  params: CreateChatCompletionParams,
  recovering: boolean,
): CreateChatCompletionParams {
  const cap = recovering ? AGENT_MODEL_RECOVERY_TOKEN_CAP : AGENT_MODEL_RESPONSE_TOKEN_CAP;
  const existingCap = params.max_completion_tokens;
  // Preserve the adapters' existing defaults when the caller has not set a budget.
  // These are application defaults, not claims about a provider's model limits.
  const providerDefault =
    params.provider === "anthropic"
      ? /haiku/i.test(params.model)
        ? 8_192
        : 16_000
      : params.provider === "gemini"
        ? 8_192
        : AGENT_MODEL_RESPONSE_TOKEN_CAP;
  return {
    ...params,
    max_completion_tokens:
      typeof existingCap === "number" && Number.isFinite(existingCap) && existingCap > 0
        ? Math.min(existingCap, cap)
        : Math.min(providerDefault, cap),
    messages: [...params.messages, { role: "system", content: INCREMENTAL_BUILD_GUIDANCE }],
  };
}

/** Never execute even an apparently valid tool fragment from a truncated response. */
export function isCompleteAgentModelResponse(response: ChatCompletion): boolean {
  const choice = response.choices[0];
  if (!choice || choice.finish_reason === "length") return false;
  return (choice.message.tool_calls ?? []).every((call) => {
    if (call.type !== "function") return false;
    try {
      const args: unknown = JSON.parse(call.function.arguments);
      return typeof args === "object" && args !== null && !Array.isArray(args);
    } catch {
      return false;
    }
  });
}
