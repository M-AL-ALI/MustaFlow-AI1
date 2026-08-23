import {
  parseWorkspaceReadiness,
  parseZeroTerminalV1,
  presentWorkspaceReadiness,
  unknownWorkspaceReadiness,
  ZERO_TERMINAL_UNKNOWN,
  type WorkspaceReadiness,
  type WorkspaceReadinessContext,
  type WorkspaceReadinessPresentation,
  type WorkspaceReadinessSubject,
  type WorkspaceReadinessSurface,
} from "@workspace/ora-contracts";
import { authFetch } from "@/lib/api-fetch";

export type WorkspaceReadinessReceipt = {
  readiness: WorkspaceReadiness;
  presentation: WorkspaceReadinessPresentation;
};

export function workspaceReadinessSubjectFromTerminal(
  value: unknown,
): WorkspaceReadinessSubject | null {
  const terminal = parseZeroTerminalV1(value);
  if (
    terminal === ZERO_TERMINAL_UNKNOWN ||
    (terminal.outcome !== "mutation_succeeded" && terminal.outcome !== "changed_with_issues")
  ) {
    return null;
  }
  return {
    versionId: terminal.evidence.versionId,
    taskId: terminal.taskId,
    revision: terminal.evidence.diffRef.revision,
  };
}

export function parseWorkspaceReadinessReceipt(
  value: unknown,
  context: WorkspaceReadinessContext,
  surface: WorkspaceReadinessSurface,
): WorkspaceReadinessReceipt {
  const readiness = parseWorkspaceReadiness(value, context);
  return { readiness, presentation: presentWorkspaceReadiness(readiness, surface) };
}

export function unavailableWorkspaceReadinessReceipt(
  context: WorkspaceReadinessContext,
  surface: WorkspaceReadinessSurface,
): WorkspaceReadinessReceipt {
  const readiness = unknownWorkspaceReadiness({
    schema: "workspace-readiness-v1",
    ...context,
    state: "unknown",
    cause: "evidence_unavailable",
    unblock: "recheck",
  });
  return { readiness, presentation: presentWorkspaceReadiness(readiness, surface) };
}

export async function fetchWorkspaceReadinessReceipt(input: {
  projectId: number;
  terminal: unknown;
  env: string;
  surface: WorkspaceReadinessSurface;
}): Promise<WorkspaceReadinessReceipt | null> {
  const subject = workspaceReadinessSubjectFromTerminal(input.terminal);
  if (!subject) return null;
  const query = new URLSearchParams({
    env: input.env,
    versionId: String(subject.versionId),
    taskId: String(subject.taskId),
    revision: String(subject.revision),
  });
  const context = { projectId: input.projectId, subject };
  try {
    const response = await authFetch(
      `/api/projects/${input.projectId}/publish-readiness?${query.toString()}`,
    );
    if (!response.ok) return unavailableWorkspaceReadinessReceipt(context, input.surface);
    const body = (await response.json()) as { workspaceReadiness?: unknown };
    return parseWorkspaceReadinessReceipt(body.workspaceReadiness, context, input.surface);
  } catch {
    return unavailableWorkspaceReadinessReceipt(context, input.surface);
  }
}

export const WORKSPACE_READINESS_UNBLOCK_LABELS = {
  retry_architect: "Run review again",
  resolve_findings: "Open findings",
  fix_validation: "Fix validation",
  rerun_validation: "Run validation again",
  wait_or_retry_preview: "Open preview details",
  apply_or_discard: "Review staged changes",
  run_or_approve_test: "Open test candidate",
  complete_publish_checks: "Open publishing checks",
  open_results: "Open results",
  recheck: "Check again",
} as const;

export function composeTerminalAndReadiness(
  terminalMessage: string,
  receipt: WorkspaceReadinessReceipt,
): { title: string; message: string; canCelebrate: boolean; canPublish: boolean } {
  return {
    title: receipt.presentation.title,
    message: `${terminalMessage} ${receipt.presentation.message}`,
    canCelebrate: receipt.presentation.canCelebrate,
    canPublish: receipt.presentation.canPublish,
  };
}
