import type {
  FileFormat,
  OraDatasetResult,
  OraFileAgentPreview,
  OraFileEditQuality,
  OraUsedFile,
} from "@workspace/ora-contracts";
import type { UploadedFileOperation } from "./file-edit-planner";

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
