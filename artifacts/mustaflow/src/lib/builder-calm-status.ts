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
}: {
  phase: CalmBuilderPhase;
  fileCount?: number;
}): string {
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
