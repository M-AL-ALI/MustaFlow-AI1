import type { BuilderReceiptIntent } from "./builder-followup-submit";

const INTENT_CHIP_LABELS: Readonly<Record<BuilderReceiptIntent, string>> = {
  answer: "Answer",
  clarify: "Clarify",
  plan: "Plan",
  mutate: "Change",
  observe: "Observe",
};

export function builderIntentChipLabel(intent: unknown): string | null {
  return typeof intent === "string" && intent in INTENT_CHIP_LABELS
    ? INTENT_CHIP_LABELS[intent as BuilderReceiptIntent]
    : null;
}
