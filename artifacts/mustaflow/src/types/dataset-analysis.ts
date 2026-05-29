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
}
