export type Provider = "openai" | "anthropic" | "gemini" | "deepseek";
export type ProviderAgentMode = "lite" | "eco" | "power" | "pro";

export function isDeepSeekAvailable(): boolean {
  if (process.env.DEEPSEEK_DISABLED === "true") return false;
  return !!process.env.DEEPSEEK_API_KEY;
}

export const VISION_MODEL: Partial<Record<Provider, string>> = {
  openai: "gpt-5.4",
  anthropic: "claude-sonnet-4-6",
  gemini: "gemini-3.1-pro-preview",
};

export const MODEL_DEFAULTS: Record<Provider, Record<ProviderAgentMode, string>> = {
  openai: {
    lite: "gpt-5-nano",
    eco: "gpt-5-mini",
    power: "gpt-5.4",
    pro: "gpt-5.4",
  },
  anthropic: {
    lite: "claude-haiku-4-5",
    eco: "claude-haiku-4-5",
    power: "claude-sonnet-4-6",
    pro: "claude-opus-4-7",
  },
  gemini: {
    lite: "gemini-3-flash-preview",
    eco: "gemini-3-flash-preview",
    power: "gemini-3.1-pro-preview",
    pro: "gemini-3.1-pro-preview",
  },
  deepseek: {
    lite: "deepseek-chat",
    eco: "deepseek-chat",
    power: "deepseek-reasoner",
    pro: "deepseek-reasoner",
  },
};
