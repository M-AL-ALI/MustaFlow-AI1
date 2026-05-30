export interface DatasetProfile {
  rowCount: number;
  colCount: number;
  truncated: boolean;
  sheetName?: string;
}

export interface KpiGap {
  metric: string;
  current: string;
  target?: string;
  gap?: string;
  trend?: string;
}

export interface TrendFinding {
  description: string;
  direction?: "up" | "down" | "flat" | "unknown";
}

export interface ParetoFinding {
  label: string;
  value: string | number;
  cumPct?: number;
}

export interface ActionItem {
  action: string;
  priority: "high" | "medium" | "low";
  owner?: string;
  timeline?: string;
}

export interface RootCauseAnalysis {
  fiveWhys: string[];
  fishbone: Record<string, string[]>;
  likelyCauses: string[];
}

// ── Phase 7B-4B: AI Reporting Intelligence types ─────────────────────────────

export type ImpactLevel = "Low" | "Moderate" | "High" | "Critical";
export type ConfidenceLevel = "Low" | "Medium" | "High";
export type RecPriority = "Critical" | "High" | "Medium" | "Low";
export type RiskLevel = "Low" | "Medium" | "High" | "Critical";
export type Difficulty = "Low" | "Medium" | "High";

export interface ImpactDimension {
  level: ImpactLevel;
  explanation: string;
}

export interface HealthScore {
  score: number;
  category: "Excellent" | "Good" | "Needs Attention" | "High Risk" | "Critical";
  explanation: string;
}

export interface FinancialImpact {
  costOfIssues?: string;
  savingsOpportunity?: string;
  revenueOpportunity?: string;
  wasteReduction?: string;
  confidence: ConfidenceLevel;
  notes?: string;
}

export interface OperationalImpact {
  productivity?: ImpactDimension;
  throughput?: ImpactDimension;
  downtime?: ImpactDimension;
  labor?: ImpactDimension;
  quality?: ImpactDimension;
  capacity?: ImpactDimension;
  overallLevel: ImpactLevel;
  summary?: string;
}

export interface CustomerImpact {
  experience?: ImpactDimension;
  service?: ImpactDimension;
  delivery?: ImpactDimension;
  productQuality?: ImpactDimension;
  reputation?: ImpactDimension;
  overallLevel: ImpactLevel;
  summary?: string;
}

export interface WhyThisMatters {
  leadershipRationale: string;
  consequencesOfInaction: string;
  strategicImplications: string;
  competitiveImplications?: string;
}

export interface EnhancedRecommendation {
  recommendation: string;
  priority: RecPriority;
  impactScore: number;
  effortScore: number;
  confidenceScore: number;
  expectedBenefit: string;
  timeline: string;
  difficulty: Difficulty;
  confidence: ConfidenceLevel;
}

export interface RoadmapItem {
  action: string;
  owner?: string;
  expectedOutcome: string;
  priority: RecPriority;
}

export interface StrategicRoadmap {
  immediate: RoadmapItem[];
  shortTerm: RoadmapItem[];
  mediumTerm: RoadmapItem[];
  strategic: RoadmapItem[];
}

export interface EnhancedRisk {
  risk: string;
  riskScore: number;
  riskLevel: RiskLevel;
  probability: "Low" | "Medium" | "High";
  impact: "Low" | "Medium" | "High" | "Critical";
  mitigation: string;
}

// ── Main result type ──────────────────────────────────────────────────────────

export interface DatasetAnalysisResult {
  type: "dataset-analysis";
  analysisType: "kpi" | "pareto" | "trend" | "root-cause" | "strategy" | "general";
  summary: string;
  datasetProfile?: DatasetProfile;
  keyFindings?: string[];
  kpiGaps?: KpiGap[];
  trendFindings?: TrendFinding[];
  paretoFindings?: ParetoFinding[];
  rootCauseAnalysis?: RootCauseAnalysis;
  recommendations?: string[];
  actionPlan?: ActionItem[];
  risksAndLimitations?: string[];
  nextSteps?: string[];
  usedFallback: boolean;
  sanitizedCellCount: number;
  truncated: boolean;
  // Phase 7B-4B intelligence fields (optional — present only when AI generates them)
  healthScore?: HealthScore;
  financialImpact?: FinancialImpact;
  operationalImpact?: OperationalImpact;
  customerImpact?: CustomerImpact;
  whyThisMatters?: WhyThisMatters;
  enhancedRecommendations?: EnhancedRecommendation[];
  strategicRoadmap?: StrategicRoadmap;
  enhancedRisks?: EnhancedRisk[];
}
