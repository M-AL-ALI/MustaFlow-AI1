/**
 * Zod schema for the dataset-analysis AI JSON response (Ora Phase 3 + 7B-4B).
 *
 * The AI must output ONLY this schema. The server validates it with Zod before
 * sending to the client. Server-added fields (usedFallback, sanitizedCellCount,
 * truncated, datasetProfile) are merged in after validation.
 *
 * Phase 7B-4B adds 8 new optional intelligence fields:
 *   healthScore, financialImpact, operationalImpact, customerImpact,
 *   whyThisMatters, enhancedRecommendations, strategicRoadmap, enhancedRisks
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

// ── Phase 7B-4B: AI Reporting Intelligence schemas ──────────────────────────

const impactLevelSchema = z.enum(["Low", "Moderate", "High", "Critical"]);
const confidenceLevelSchema = z.enum(["Low", "Medium", "High"]);
const recPrioritySchema = z.enum(["Critical", "High", "Medium", "Low"]);
const riskLevelSchema = z.enum(["Low", "Medium", "High", "Critical"]);
const difficultySchema = z.enum(["Low", "Medium", "High"]);

const impactDimensionSchema = z.object({
  level: impactLevelSchema,
  explanation: z.string().max(500),
});

const healthScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  category: z.enum(["Excellent", "Good", "Needs Attention", "High Risk", "Critical"]),
  explanation: z.string().max(1000),
});

const financialImpactSchema = z.object({
  costOfIssues: z.string().max(500).optional(),
  savingsOpportunity: z.string().max(500).optional(),
  revenueOpportunity: z.string().max(500).optional(),
  wasteReduction: z.string().max(500).optional(),
  confidence: confidenceLevelSchema,
  notes: z.string().max(500).optional(),
});

const operationalImpactSchema = z.object({
  productivity: impactDimensionSchema.optional(),
  throughput: impactDimensionSchema.optional(),
  downtime: impactDimensionSchema.optional(),
  labor: impactDimensionSchema.optional(),
  quality: impactDimensionSchema.optional(),
  capacity: impactDimensionSchema.optional(),
  overallLevel: impactLevelSchema,
  summary: z.string().max(500).optional(),
});

const customerImpactSchema = z.object({
  experience: impactDimensionSchema.optional(),
  service: impactDimensionSchema.optional(),
  delivery: impactDimensionSchema.optional(),
  productQuality: impactDimensionSchema.optional(),
  reputation: impactDimensionSchema.optional(),
  overallLevel: impactLevelSchema,
  summary: z.string().max(500).optional(),
});

const whyThisMattersSchema = z.object({
  leadershipRationale: z.string().max(1000),
  consequencesOfInaction: z.string().max(1000),
  strategicImplications: z.string().max(1000),
  competitiveImplications: z.string().max(500).optional(),
});

const enhancedRecommendationSchema = z.object({
  recommendation: z.string().max(500),
  priority: recPrioritySchema,
  impactScore: z.number().int().min(0).max(100),
  effortScore: z.number().int().min(0).max(100),
  confidenceScore: z.number().int().min(0).max(100),
  expectedBenefit: z.string().max(500),
  timeline: z.string().max(200),
  difficulty: difficultySchema,
  confidence: confidenceLevelSchema,
});

const roadmapItemSchema = z.object({
  action: z.string().max(500),
  owner: z.string().max(200).optional(),
  expectedOutcome: z.string().max(500),
  priority: recPrioritySchema,
});

const strategicRoadmapSchema = z.object({
  immediate: z.array(roadmapItemSchema).max(5),
  shortTerm: z.array(roadmapItemSchema).max(5),
  mediumTerm: z.array(roadmapItemSchema).max(5),
  strategic: z.array(roadmapItemSchema).max(5),
});

const enhancedRiskSchema = z.object({
  risk: z.string().max(500),
  riskScore: z.number().int().min(0).max(100),
  riskLevel: riskLevelSchema,
  probability: z.enum(["Low", "Medium", "High"]),
  impact: z.enum(["Low", "Medium", "High", "Critical"]),
  mitigation: z.string().max(500),
});

// ── Main schema ──────────────────────────────────────────────────────────────

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
  // Phase 7B-4B intelligence fields (all optional for backward compatibility)
  healthScore: healthScoreSchema.optional(),
  financialImpact: financialImpactSchema.optional(),
  operationalImpact: operationalImpactSchema.optional(),
  customerImpact: customerImpactSchema.optional(),
  whyThisMatters: whyThisMattersSchema.optional(),
  enhancedRecommendations: z.array(enhancedRecommendationSchema).max(10).optional(),
  strategicRoadmap: strategicRoadmapSchema.optional(),
  enhancedRisks: z.array(enhancedRiskSchema).max(10).optional(),
});

export type DatasetAnalysisAiOutput = z.infer<typeof DatasetAnalysisAiSchema>;

// Export sub-types for use in other modules
export type HealthScore = z.infer<typeof healthScoreSchema>;
export type FinancialImpact = z.infer<typeof financialImpactSchema>;
export type OperationalImpact = z.infer<typeof operationalImpactSchema>;
export type CustomerImpact = z.infer<typeof customerImpactSchema>;
export type WhyThisMatters = z.infer<typeof whyThisMattersSchema>;
export type EnhancedRecommendation = z.infer<typeof enhancedRecommendationSchema>;
export type StrategicRoadmap = z.infer<typeof strategicRoadmapSchema>;
export type RoadmapItem = z.infer<typeof roadmapItemSchema>;
export type EnhancedRisk = z.infer<typeof enhancedRiskSchema>;
