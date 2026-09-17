import { z } from "zod";

// Older saved plans need not have estimates, but an executable plan must
// contain actual instructions. Transport/terminal metadata is never a plan.
const text = z.string().trim().min(1);
const strings = z.array(z.string());
const planSchema = z
  .object({
    goal: text,
    approach: text,
    summary: z.string().optional(),
    sitemap: z.array(z.object({ name: text, route: text, purpose: text })).optional(),
    pages: strings.optional(),
    backend: strings.optional(),
    database: strings.optional(),
    dataModel: z.array(z.object({ table: text, fields: strings })).optional(),
    apiEndpoints: z.array(z.object({ method: text, path: text, purpose: text })).optional(),
    integrations: strings.optional(),
    keysNeeded: strings.optional(),
    filesAffected: strings.optional(),
    uxNotes: z.record(z.string(), z.string()).optional(),
    accessibilityNotes: z.string().optional(),
    complexityScore: z.number().finite().min(1).max(10).optional(),
    recommendedMode: z.enum(["lite", "eco", "power", "pro"]).optional(),
    recommendedAgent: z.enum(["planning", "task", "main"]).optional(),
    estimatedBuildSeconds: z.number().finite().positive().optional(),
    risks: strings.optional(),
    testPlan: strings.optional(),
    currentState: z
      .object({
        fileCount: z.number().int().nonnegative(),
        detectedPages: strings,
        detectedLibraries: strings,
        detectedPlatform: z.string(),
        summary: z.string(),
      })
      .optional(),
  })
  .passthrough()
  .refine((plan) => plan.kind === undefined || plan.kind === "plan");

export type UsableZeroPlan = z.infer<typeof planSchema>;
export const ZERO_PLAN_UNAVAILABLE_MESSAGE =
  "This planning attempt did not produce a usable plan. Ask Zero to try again; no build was started.";

export function hasUsableZeroPlan(value: unknown): value is UsableZeroPlan {
  return planSchema.safeParse(value).success;
}

export function hasCompleteGeneratedZeroPlan(value: unknown): value is UsableZeroPlan {
  return (
    hasUsableZeroPlan(value) &&
    !!value.sitemap?.length &&
    Number.isInteger(value.complexityScore) &&
    value.recommendedMode !== undefined &&
    Number.isInteger(value.estimatedBuildSeconds) &&
    value.uxNotes !== undefined
  );
}
