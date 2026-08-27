import type { AgentMode } from "./ai";
import type { Provider, Stage } from "./ai-providers";

export const ZERO_MODEL_TIERS = ["lite", "eco", "power", "pro"] as const;
export const ZERO_MODEL_STAGES = [
  "build",
  "refine",
  "plan",
  "architect",
  "intent",
  "converse",
] as const;
export const ZERO_MODEL_PROVIDERS = ["openai", "anthropic", "gemini", "deepseek", "local"] as const;

export type ZeroModelTier = (typeof ZERO_MODEL_TIERS)[number];
export type ZeroModelStage = (typeof ZERO_MODEL_STAGES)[number];
export type ZeroModelProvider = (typeof ZERO_MODEL_PROVIDERS)[number];

declare const zeroModelCallIdentityBrand: unique symbol;
export type ZeroModelCallIdentity = Readonly<{
  callId: string;
  operationId: string;
  tier: ZeroModelTier;
  stage: ZeroModelStage;
  provider: ZeroModelProvider;
  model: string;
  bindingVersionId: number | null;
  taskId: number | null;
  [zeroModelCallIdentityBrand]: true;
}>;

export type ZeroModelIdentityInput = Readonly<{
  callId: string;
  operationId: string;
  tier: AgentMode;
  stage: Stage;
  provider: Provider | "local";
  model: string;
  bindingVersionId?: number | null;
  taskId?: number | null;
}>;

export class ZeroModelIdentityError extends Error {
  constructor(readonly code: "zero_model_call_identity_invalid") {
    super(code);
    this.name = "ZeroModelIdentityError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,127}$/i;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,199}$/i;

/**
 * The only constructor for a call identity. Provider, model and tier are
 * validated independently so none can be reconstructed from another field.
 */
export function createZeroModelCallIdentity(input: ZeroModelIdentityInput): ZeroModelCallIdentity {
  if (
    !UUID_PATTERN.test(input.callId) ||
    !OPERATION_ID_PATTERN.test(input.operationId) ||
    !ZERO_MODEL_TIERS.includes(input.tier) ||
    !ZERO_MODEL_STAGES.includes(input.stage) ||
    !ZERO_MODEL_PROVIDERS.includes(input.provider) ||
    !MODEL_ID_PATTERN.test(input.model) ||
    (input.bindingVersionId != null &&
      (!Number.isInteger(input.bindingVersionId) || input.bindingVersionId < 1)) ||
    (input.taskId != null && (!Number.isInteger(input.taskId) || input.taskId < 1))
  ) {
    throw new ZeroModelIdentityError("zero_model_call_identity_invalid");
  }
  return {
    ...input,
    bindingVersionId: input.bindingVersionId ?? null,
    taskId: input.taskId ?? null,
  } as ZeroModelCallIdentity;
}

export type ZeroModelBindingState = "candidate" | "active" | "previous" | "retired";

export interface ZeroModelBinding {
  readonly id: number;
  readonly tier: ZeroModelTier;
  readonly version: number;
  readonly provider: ZeroModelProvider;
  readonly model: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly state: ZeroModelBindingState;
}

export function isZeroModelTier(value: string): value is ZeroModelTier {
  return ZERO_MODEL_TIERS.includes(value as ZeroModelTier);
}
