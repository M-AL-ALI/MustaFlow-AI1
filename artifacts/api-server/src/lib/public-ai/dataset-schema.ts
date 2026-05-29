/**
 * Zod schema for the dataset-analysis AI JSON response (Ora Phase 3).
 *
 * The AI must output ONLY this schema. The server validates it with Zod before
 * sending to the client. Server-added fields (usedFallback, sanitizedCellCount,
 * truncated, datasetProfile) are merged in after validation.
 */

import { z } from "zod";

const kpiGapSchema = z.object({
  metric: z.string().max(200),
  current: z.string().max(200),
  target: z.string().max(200).optional(),
  gap: z.string().max(200).optional(),
  trend: z.string().max(200).optional(),
});

const trendFindingSchema = z.object({
  description: z.string().max(500),
  direction: z.enum(["up", "down", "flat", "unknown"]).optional(),
});

const paretoFindingSchema = z.object({
  label: z.string().max(200),
  value: z.union([z.string().max(200), z.number()]),
  cumPct: z.number().min(0).max(100).optional(),
});

const actionItemSchema = z.object({
  action: z.string().max(500),
  priority: z.enum(["high", "medium", "low"]),
  owner: z.string().max(200).optional(),
  timeline: z.string().max(200).optional(),
});

const rootCauseSchema = z.object({
  fiveWhys: z.array(z.string().max(500)).max(10),
  fishbone: z.record(z.string().max(100), z.array(z.string().max(300))),
  likelyCauses: z.array(z.string().max(500)).max(8),
});

export const DatasetAnalysisAiSchema = z.object({
  type: z.literal("dataset-analysis"),
  analysisType: z.enum(["kpi", "pareto", "trend", "root-cause", "strategy", "general"]),
  summary: z.string().min(1).max(2000),
  keyFindings: z.array(z.string().max(500)).max(10).optional(),
  kpiGaps: z.array(kpiGapSchema).max(12).optional(),
  trendFindings: z.array(trendFindingSchema).max(12).optional(),
  paretoFindings: z.array(paretoFindingSchema).max(20).optional(),
  rootCauseAnalysis: rootCauseSchema.optional(),
  recommendations: z.array(z.string().max(500)).max(10).optional(),
  actionPlan: z.array(actionItemSchema).max(10).optional(),
  risksAndLimitations: z.array(z.string().max(500)).max(8).optional(),
  nextSteps: z.array(z.string().max(500)).max(8).optional(),
});

export type DatasetAnalysisAiOutput = z.infer<typeof DatasetAnalysisAiSchema>;
