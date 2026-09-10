export type CalmBuilderPhase =
  | "idle"
  | "answering"
  | "planning"
  | "building"
  | "images"
  | "testing"
  | "fixing";

export const CALM_STATUS_VOCABULARY = {
  idle: "Ready for your next change.",
  answering: "Answering your question...",
  planning: "Planning your app...",
  building: "Building your app...",
  images: "Creating images for your app...",
  testing: "Testing what I built...",
  fixing: "Fixing an issue I found...",
} as const;

export function getCalmBuilderStatus({
  phase,
  fileCount = 0,
  previewSyncPending = false,
}: {
  phase: CalmBuilderPhase;
  fileCount?: number;
  previewSyncPending?: boolean;
}): string {
  if (previewSyncPending) return "Updating preview\u2026";
  if (phase === "building" && fileCount > 0) {
    return `Building — ${fileCount} file${fileCount === 1 ? "" : "s"} so far`;
  }
  return CALM_STATUS_VOCABULARY[phase];
}

export function calmPhaseForTaskEvent(eventType: string, message = ""): CalmBuilderPhase | null {
  const normalizedType = eventType.toLowerCase();
  const normalizedMessage = message.toLowerCase();

  if (
    normalizedType.includes("repair") ||
    normalizedType.includes("self_heal") ||
    /\b(fixing|repairing|self-heal|self heal)\b/.test(normalizedMessage)
  ) {
    return "fixing";
  }

  if (
    normalizedType === "qa_step" ||
    normalizedType === "qa_done" ||
    normalizedType === "command_output" ||
    normalizedType === "check_result" ||
    normalizedType === "review_context" ||
    normalizedType.includes("validation") ||
    normalizedType.includes("test")
  ) {
    return "testing";
  }

  if (
    normalizedType === "file_diff" ||
    normalizedType === "editing_files" ||
    normalizedType === "generating_code" ||
    normalizedType === "project_files_changed" ||
    normalizedType === "updating_preview"
  ) {
    return "building";
  }

  if (normalizedType.includes("plan") || /\bplanning\b/.test(normalizedMessage)) {
    return "planning";
  }

  if (
    normalizedType === "completed" ||
    normalizedType === "failed" ||
    normalizedType === "cancelled"
  ) {
    return "idle";
  }

  return null;
}

export type EditorRunTerminal = "completed" | "failed" | "cancelled" | "unknown";

export interface EditorRunReceipt {
  projectId: number;
  taskId: number;
  phase?: CalmBuilderPhase;
  activityLabel?: string;
  terminal?: EditorRunTerminal;
}

/** Only the currently selected project/task can update the header's receipt. */
export function reconcileEditorRunReceipt(
  current: EditorRunReceipt | null,
  incoming: EditorRunReceipt,
  scope: { projectId: number; taskId: number | null },
): EditorRunReceipt | null {
  if (incoming.projectId !== scope.projectId || incoming.taskId !== scope.taskId) return current;
  const previous =
    current?.projectId === incoming.projectId && current.taskId === incoming.taskId
      ? current
      : null;
  // A replayed progress frame must never revive a terminal run.
  if (previous?.terminal) return previous;
  return {
    ...incoming,
    phase: incoming.phase ?? previous?.phase,
    activityLabel:
      incoming.activityLabel ??
      (incoming.phase !== undefined && incoming.phase !== previous?.phase
        ? undefined
        : previous?.activityLabel),
  };
}

export interface EditorWorkStatus {
  label: string;
  tone: "muted" | "active" | "success" | "warning" | "error";
  previousBuildFailed: boolean;
}

function editorTaskTerminal(status: string | undefined): EditorRunTerminal | undefined {
  if (status === "completed" || status === "failed") return status;
  if (status === "cancelled" || status === "canceled" || status === "discarded") return "cancelled";
  return undefined;
}

/** Presentation only: this never changes task, runtime, publishing, or access state. */
export function getEditorWorkStatus(input: {
  projectId: number;
  projectStatus?: string;
  task?: { projectId: number; id: number; status: string } | null;
  receipt?: EditorRunReceipt | null;
  requestPending?: boolean;
}): EditorWorkStatus {
  const task = input.task?.projectId === input.projectId ? input.task : null;
  const receipt =
    task && input.receipt?.projectId === input.projectId && input.receipt.taskId === task.id
      ? input.receipt
      : null;
  const previousBuildFailed = input.projectStatus === "failed";
  const terminal = receipt?.terminal ?? editorTaskTerminal(task?.status);
  if (terminal) {
    const label = {
      completed: "Run completed",
      failed: "Request failed",
      cancelled: "Run cancelled",
      unknown: "Run ended; status unavailable",
    }[terminal];
    return {
      label,
      tone:
        terminal === "failed"
          ? "error"
          : terminal === "completed"
            ? "success"
            : terminal === "unknown"
              ? "warning"
              : "muted",
      previousBuildFailed,
    };
  }

  const waitingLabels: Record<string, string> = {
    queued: "Queued",
    needs_approval: "Approval needed",
    needs_review: "Review needed",
    needs_fix: "Changes need attention",
  };
  if (task && Object.prototype.hasOwnProperty.call(waitingLabels, task.status)) {
    return { label: waitingLabels[task.status], tone: "warning", previousBuildFailed };
  }
  if (
    task &&
    ["answering", "planning", "building", "running", "in_progress", "testing"].includes(task.status)
  ) {
    if (!receipt) {
      return { label: "Connecting to current run...", tone: "muted", previousBuildFailed };
    }
    const phase =
      receipt.phase && receipt.phase !== "idle"
        ? receipt.phase
        : task.status === "answering"
          ? "answering"
          : task.status === "planning"
            ? "planning"
            : task.status === "testing"
              ? "testing"
              : "building";
    return {
      label: receipt.activityLabel || getCalmBuilderStatus({ phase }),
      tone: "active",
      previousBuildFailed,
    };
  }
  if (input.requestPending) {
    return { label: "Request in progress...", tone: "active", previousBuildFailed };
  }
  if (task) {
    return { label: "Current run status unavailable", tone: "muted", previousBuildFailed };
  }
  if (input.projectStatus === "failed") {
    return { label: "Last build failed", tone: "error", previousBuildFailed: false };
  }
  if (input.projectStatus === "published") {
    return { label: "Published", tone: "success", previousBuildFailed: false };
  }
  if (input.projectStatus === "building" || input.projectStatus === "testing") {
    return { label: "Checking current run...", tone: "muted", previousBuildFailed: false };
  }
  return {
    label:
      input.projectStatus === "ready" || input.projectStatus === "draft"
        ? getCalmBuilderStatus({ phase: "idle" })
        : input.projectStatus
          ? "Project: " + input.projectStatus.replaceAll("_", " ")
          : "Project status unknown",
    tone: "muted",
    previousBuildFailed: false,
  };
}
