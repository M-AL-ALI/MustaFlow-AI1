export type UploadedFileOperation =
  | "analyze"
  | "summarize"
  | "rewrite"
  | "replace"
  | "delete"
  | "add"
  | "insert"
  | "move"
  | "reorder"
  | "rename"
  | "translate"
  | "format"
  | "professionalize"
  | "convert"
  | "chart"
  | "dashboard"
  | "formula"
  | "merge"
  | "split"
  | "extract"
  | "compare"
  | "code_review_zip";

export interface UploadedFileEditPlan {
  operations: UploadedFileOperation[];
  requiresFileOutput: boolean;
  isAnalysisOnly: boolean;
  reason: string;
}

const FILE_TARGET_PATTERN =
  /\b(it|this|that|file|document|report|deck|presentation|slides?|power[\s-]?point|pptx?|spreadsheet|workbook|worksheet|sheet|excel|xlsx|csv|pdf|docx|word|uploaded|attached|layout|style|format|title|heading|section|conclusion|paragraph|row|column|table|chart|graph|histogram|dashboard|zip|archive|project|repo|repository|codebase)\b/i;

const FILE_OUTPUT_PATTERN =
  /\b(return|send|give|export|download|save|create|generate|make)\b[^.?!\n]{0,80}\b(file|document|deck|presentation|slides?|power[\s-]?point|pptx?|spreadsheet|workbook|excel|xlsx|csv|pdf|docx|word|copy|version|back|it)\b/i;

const ANALYSIS_ONLY_PATTERN =
  /\b(analy[sz]e|summari[sz]e|explain|review|inspect|read|tell\s+me|what\s+(?:is|are|does|did|can)|find|identify|extract|compare)\b/i;

const OPERATION_PATTERNS: Array<{ operation: UploadedFileOperation; pattern: RegExp }> = [
  { operation: "replace", pattern: /\b(replace|change|swap|substitute)\b/i },
  { operation: "delete", pattern: /\b(delete|remove|drop|clear)\b/i },
  { operation: "add", pattern: /\b(add|append|include|create|make|new)\b/i },
  { operation: "insert", pattern: /\b(insert|put|place)\b/i },
  { operation: "move", pattern: /\b(move|relocate|shift)\b/i },
  { operation: "reorder", pattern: /\b(reorder|rearrange|sort|sequence|organize)\b/i },
  {
    operation: "rename",
    pattern:
      /\b(rename|retitle|change\s+(?:the\s+)?(?:name|title|heading)|set\s+(?:the\s+)?(?:name|title|heading))\b/i,
  },
  {
    operation: "rewrite",
    pattern:
      /\b(rewrite|reword|revise|edit|modify|update|proofread|fix|correct|expand|shorten|condense)\b/i,
  },
  { operation: "translate", pattern: /\b(translate|locali[sz]e)\b/i },
  {
    operation: "format",
    pattern:
      /\b(format|formatting|reformat|clean\s+up|cleanup|tidy|normalize|dedupe|deduplicate)\b/i,
  },
  {
    operation: "professionalize",
    pattern:
      /\b(professional|polish|board[-\s]?ready|executive[-\s]?ready|presentation[-\s]?ready|improve|redesign|restyle|cleaner)\b/i,
  },
  {
    operation: "convert",
    pattern: /\b(convert|turn\s+(?:it|this|that)\s+into|change\s+(?:it|this|that)\s+into)\b/i,
  },
  { operation: "chart", pattern: /\b(chart|graph|histogram|plot|visuali[sz]e)\b/i },
  { operation: "dashboard", pattern: /\b(dashboard|scorecard|kpi\s+view|executive\s+view)\b/i },
  {
    operation: "formula",
    pattern:
      /\b(formulas?|calculations?|calculate|computed?|totals?|sum|average|avg|minimum|maximum|min|max|count|commission|quota|margin|rate|kpi|metrics?|model)\b/i,
  },
  { operation: "merge", pattern: /\b(merge|combine|consolidate|join)\b/i },
  { operation: "split", pattern: /\b(split|separate|break\s+(?:out|into))\b/i },
  { operation: "extract", pattern: /\b(extract|pull\s+out|export\s+only)\b/i },
  { operation: "compare", pattern: /\b(compare|difference|diff|versus|vs\.?)\b/i },
  { operation: "analyze", pattern: /\b(analy[sz]e|inspect|review|audit|check|verify)\b/i },
  { operation: "summarize", pattern: /\b(summari[sz]e|brief|overview|recap)\b/i },
  {
    operation: "code_review_zip",
    pattern: /\b(zip|archive|repo|repository|github|project|codebase|source\s+code)\b/i,
  },
];

export const FILE_OUTPUT_OPERATIONS = new Set<UploadedFileOperation>([
  "rewrite",
  "replace",
  "delete",
  "add",
  "insert",
  "move",
  "reorder",
  "rename",
  "translate",
  "format",
  "professionalize",
  "convert",
  "chart",
  "dashboard",
  "formula",
  "merge",
  "split",
]);

export function planUploadedFileRequest(message: string): UploadedFileEditPlan {
  const operations: UploadedFileOperation[] = [];
  for (const { operation, pattern } of OPERATION_PATTERNS) {
    if (pattern.test(message) && !operations.includes(operation)) operations.push(operation);
  }

  const mentionsFile = FILE_TARGET_PATTERN.test(message);
  const hasFileOutputOperation = operations.some((op) => FILE_OUTPUT_OPERATIONS.has(op));
  const asksForFileOutput = FILE_OUTPUT_PATTERN.test(message);
  const analysisOnly =
    operations.length > 0 &&
    operations.every(
      (op) =>
        op === "analyze" ||
        op === "summarize" ||
        op === "compare" ||
        op === "extract" ||
        op === "code_review_zip",
    ) &&
    ANALYSIS_ONLY_PATTERN.test(message) &&
    !asksForFileOutput;

  const requiresFileOutput =
    mentionsFile && !analysisOnly && (hasFileOutputOperation || asksForFileOutput);

  return {
    operations,
    requiresFileOutput,
    isAnalysisOnly: analysisOnly,
    reason: requiresFileOutput
      ? `uploaded-file operations: ${operations.join(", ") || "file-output"}`
      : analysisOnly
        ? `analysis-only operations: ${operations.join(", ")}`
        : "no uploaded-file edit operation detected",
  };
}
