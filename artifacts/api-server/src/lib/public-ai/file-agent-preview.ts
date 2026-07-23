import type {
  FileFormat,
  OraDatasetResult,
  OraFileAgentPreview,
  OraFileEditQuality,
  OraUsedFile,
} from "@workspace/ora-contracts";
import type { UploadedFileOperation } from "./file-edit-planner";

type ContentChange = { label: string; from?: string; to?: string };

/**
 * Extract specific before→after content pairs from the user's raw message.
 * Used to populate `contentChanges` in the preview card so the user can see
 * what will change before confirming a high-risk edit.
 *
 * Uses literal regex patterns (not string interpolation) to avoid character-
 * class nesting ambiguity with mixed straight + smart quote character sets.
 */
function extractContentChanges(
  message: string,
  operations: UploadedFileOperation[],
): ContentChange[] {
  const changes: ContentChange[] = [];
  let m: RegExpExecArray | null;

  // Pattern 1a: replace/change "A" to/with "B" — ASCII straight quotes
  const pairStraight =
    /\b(?:replace|change|rename|reword|update|set)\b[^"]{0,25}"([^"]{2,100})"\s+(?:to|with)\s+"([^"]{2,100})"/gi;
  while ((m = pairStraight.exec(message)) !== null && changes.length < 3) {
    changes.push({ label: "Text replacement", from: m[1].trim(), to: m[2].trim() });
  }

  // Pattern 1b: same with Unicode smart double quotes
  if (changes.length === 0) {
    const pairSmart =
      /\b(?:replace|change|rename|reword|update|set)\b[^\u201c\u2018]{0,25}[\u201c\u2018]([^\u201c\u201d\u2018\u2019]{2,100})[\u201d\u2019]\s+(?:to|with)\s+[\u201c\u2018]([^\u201c\u201d\u2018\u2019]{2,100})[\u201d\u2019]/gi;
    while ((m = pairSmart.exec(message)) !== null && changes.length < 3) {
      changes.push({ label: "Text replacement", from: m[1].trim(), to: m[2].trim() });
    }
  }

  // Pattern 2a: verb ... "new value" — only the target is quoted (ASCII)
  if (changes.length === 0) {
    const targetStraight =
      /\b(?:change|rename|update|set)\b[^"]{0,40}"([^"]{2,100})"/gi;
    while ((m = targetStraight.exec(message)) !== null && changes.length < 3) {
      changes.push({ label: "New content", to: m[1].trim() });
    }
  }

  // Pattern 2b: same with Unicode smart double quotes
  if (changes.length === 0) {
    const targetSmart =
      /\b(?:change|rename|update|set)\b[^\u201c\u2018]{0,40}[\u201c\u2018]([^\u201c\u201d\u2018\u2019]{2,100})[\u201d\u2019]/gi;
    while ((m = targetSmart.exec(message)) !== null && changes.length < 3) {
      changes.push({ label: "New content", to: m[1].trim() });
    }
  }

  // Pattern 3: structural operations — "delete slide 3", "move row 5"
  const hasStructural = operations.some((op) => ["delete", "move", "reorder"].includes(op));
  if (hasStructural && changes.length < 3) {
    const structPattern =
      /\b(delete|remove|move|reorder)\b[^.!\n]{0,15}\b(slides?\s+\d+(?:[–\-]\d+)?(?:\s+(?:and|,)\s+\d+)*|rows?\s+\d+|sheets?\s+\d+|section\s+\d+)\b/gi;
    while ((m = structPattern.exec(message)) !== null && changes.length < 3) {
      const verb = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      changes.push({ label: `${verb} ${m[2].trim()}` });
    }
  }

  return changes.slice(0, 5);
}

function uniqueNonEmpty(values: Array<string | null | undefined>, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw?.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value.slice(0, 180));
    if (out.length >= max) break;
  }
  return out;
}

function formatLabel(format: FileFormat): string {
  switch (format) {
    case "xlsx":
      return "Excel workbook";
    case "csv":
      return "CSV file";
    case "docx":
      return "Word document";
    case "pptx":
      return "PowerPoint deck";
    case "pdf":
      return "PDF report";
  }
}

function actionsForFormat(format: FileFormat, hasSourceData: boolean): string[] {
  const base = hasSourceData
    ? ["Use uploaded source content", `Return a downloadable ${formatLabel(format)}`]
    : [`Create a downloadable ${formatLabel(format)}`];
  if (format === "xlsx") {
    return [...base, "Organize data into workbook sheets", "Add formulas/tables when requested"];
  }
  if (format === "pptx") {
    return [
      ...base,
      "Structure content into presentation slides",
      "Add charts when the data supports them",
    ];
  }
  if (format === "pdf") {
    return [
      ...base,
      "Format the output as a polished report",
      "Include charts/tables when requested",
    ];
  }
  if (format === "docx") {
    return [...base, "Organize the document into professional sections"];
  }
  return [...base, "Keep the output easy to import into spreadsheets"];
}

function actionLabel(operation: UploadedFileOperation): string {
  switch (operation) {
    case "delete":
      return "Remove the requested content from the uploaded file";
    case "replace":
      return "Replace the requested text inside the original file";
    case "add":
    case "insert":
      return "Add the requested content while preserving the file structure";
    case "move":
    case "reorder":
      return "Rearrange the requested content in the uploaded file";
    case "rename":
      return "Rename the requested title, heading, sheet, or slide";
    case "rewrite":
    case "professionalize":
      return "Polish the requested content in place";
    case "format":
      return "Clean up formatting while keeping the original file usable";
    case "translate":
      return "Translate the requested content in the uploaded file";
    case "convert":
      return "Create the requested converted output";
    case "chart":
      return "Add the requested chart if the uploaded data supports it";
    case "dashboard":
      return "Build the requested dashboard view if the data supports it";
    case "formula":
      return "Add the requested formulas or calculations";
    case "merge":
      return "Combine the requested uploaded files";
    case "split":
      return "Split the requested content into separate parts";
    case "extract":
      return "Extract the requested content";
    case "compare":
      return "Compare the requested uploaded files";
    case "analyze":
      return "Inspect the uploaded file before editing";
    case "summarize":
      return "Summarize the uploaded file content";
    case "code_review_zip":
      return "Inspect the uploaded archive safely";
  }
}

export function buildFileEditConfirmationPreview(input: {
  format: FileFormat;
  fileNames: string[];
  operations: UploadedFileOperation[];
  requestedPreview: boolean;
  /** Raw user message — used to extract specific before→after content pairs. */
  message?: string;
}): OraFileAgentPreview {
  const detectedInputs = uniqueNonEmpty(
    [...input.fileNames.slice(0, 5), `Output: ${formatLabel(input.format)}`],
    8,
  );
  const plannedActions = uniqueNonEmpty(
    input.operations.length
      ? input.operations.map(actionLabel)
      : ["Apply the requested edit to the uploaded file"],
    8,
  );
  const contentChanges =
    input.message && input.message.trim().length > 0
      ? extractContentChanges(input.message, input.operations)
      : undefined;

  return {
    kind: "file_edit",
    status: "needs_confirmation",
    title: "Review edit before applying",
    summary: input.requestedPreview
      ? "Ora prepared an edit plan and will wait for you to confirm before changing the file."
      : "This edit can materially change the uploaded file, so Ora is waiting for confirmation.",
    detectedInputs,
    plannedActions,
    safetyNotes: [
      "No downloadable file will be created until you choose Apply edit.",
      "If the edit cannot be applied safely, Ora returns the original file unchanged instead of rebuilding a lookalike.",
    ],
    canApply: true,
    canRedesign: true,
    contentChanges: contentChanges && contentChanges.length > 0 ? contentChanges : undefined,
  };
}

export function buildFileAgentPreview(input: {
  format: FileFormat;
  fileName: string;
  hasSourceData: boolean;
  sourceCount?: number;
  editQuality?: OraFileEditQuality;
  usedFiles?: OraUsedFile[];
}): OraFileAgentPreview {
  const usedFileNames = uniqueNonEmpty(
    (input.usedFiles ?? []).map((f) => f.name),
    5,
  );
  const detectedInputs = uniqueNonEmpty(
    [
      input.sourceCount && input.sourceCount > 0
        ? `${input.sourceCount} uploaded ${input.sourceCount === 1 ? "file" : "files"}`
        : null,
      ...usedFileNames,
      `Output: ${input.fileName}`,
    ],
    8,
  );

  const quality = input.editQuality;
  if (quality) {
    const status: OraFileAgentPreview["status"] =
      quality.editMode === "original_edited"
        ? "applied"
        : quality.editMode === "redesigned"
          ? "applied"
          : quality.editMode === "unchanged"
            ? "unchanged"
            : "failed_safe";
    const title =
      quality.editMode === "original_edited"
        ? "Edited original file"
        : quality.editMode === "redesigned"
          ? "Rebuilt from uploaded content"
          : quality.editMode === "unchanged"
            ? "Returned original file unchanged"
            : "Could not safely apply edit";
    const safetyNotes = uniqueNonEmpty(
      [
        quality.preservedLayout === false
          ? "Original layout was not preserved"
          : "Original layout and design preserved",
        quality.warning,
      ],
      4,
    );
    return {
      kind: quality.editMode === "redesigned" ? "file_generation" : "file_edit",
      status,
      title,
      summary:
        quality.editMode === "failed_safe"
          ? "Ora returned the source file unchanged instead of risking a corrupt or incorrect edit."
          : `Ora prepared ${formatLabel(input.format)} output from the requested file task.`,
      detectedInputs,
      plannedActions: uniqueNonEmpty(
        quality.changes?.length ? quality.changes : actionsForFormat(input.format, true),
        8,
      ),
      safetyNotes,
      canApply: quality.editMode !== "failed_safe",
      canRedesign: quality.canRedesign,
    };
  }

  return {
    kind: input.format === "pdf" ? "report_export" : "file_generation",
    status: "applied",
    title: `Created ${formatLabel(input.format)}`,
    summary: input.hasSourceData
      ? "Ora used the uploaded source content to build the downloadable file."
      : "Ora generated a new downloadable file from the prompt.",
    detectedInputs,
    plannedActions: actionsForFormat(input.format, input.hasSourceData),
    calculations:
      input.format === "xlsx"
        ? ["Add formulas, summary tables, and repeatable calculations when requested"]
        : undefined,
    charts:
      input.format === "xlsx" || input.format === "pptx" || input.format === "pdf"
        ? ["Create charts or histograms when the request and data support them"]
        : undefined,
    canApply: true,
    canRedesign: input.hasSourceData,
  };
}

export function buildDatasetAgentPreview(result: OraDatasetResult): OraFileAgentPreview {
  const workflow = result.analystWorkflow;
  const sheet = result.datasetProfile?.sheetName;
  return {
    kind: "data_analysis",
    status: "planned",
    title: "Data analysis workflow",
    summary:
      result.summary?.slice(0, 500) || "Ora inspected the dataset and prepared analysis steps.",
    detectedInputs: uniqueNonEmpty(
      [
        result.datasetProfile?.rowCount != null ? `${result.datasetProfile.rowCount} rows` : null,
        result.datasetProfile?.colCount != null
          ? `${result.datasetProfile.colCount} columns`
          : null,
        sheet ? `Sheet: ${sheet}` : null,
      ],
      8,
    ),
    plannedActions: uniqueNonEmpty(
      [...(result.keyFindings ?? []).slice(0, 3), ...(result.recommendations ?? []).slice(0, 3)],
      8,
    ),
    calculations: uniqueNonEmpty(workflow?.calculationSuggestions?.map((c) => c.label) ?? [], 6),
    charts: uniqueNonEmpty(workflow?.chartSuggestions?.map((c) => c.title) ?? [], 5),
    outputSections: uniqueNonEmpty(workflow?.reportSuggestions?.map((r) => r.title) ?? [], 6),
    assumptions: result.truncated ? ["Large dataset was summarized from a safe sample"] : undefined,
    canApply: true,
    canRedesign: true,
  };
}
