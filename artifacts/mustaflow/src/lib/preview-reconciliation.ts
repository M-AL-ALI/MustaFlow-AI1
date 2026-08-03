import type { ProjectFilesChangedPayload } from "./event-types";

export type PreviewPayloadSource =
  | "task-stream"
  | "project-stream"
  | "stream-connect"
  | "stream-reconnect"
  | "task-terminal";

export type ProjectPreviewState = {
  projectId: number;
  revision: number | null;
  versionCreatedAt: string | null;
  reconciliationAllowed: boolean;
  blockedByTaskId: number | null;
  blockedByStatus: "needs_review" | "needs_fix" | null;
  generatedAt: string;
};

export type AuthoritativeProjectFile = {
  path: string;
  content: string;
};

export type PreviewRevisionState = {
  projectId: number;
  appliedRevision: number;
  queuedRevision: number;
  reconcileInFlight: Promise<void> | null;
};

export type PreviewTimingPhase =
  | "browser_receipt"
  | "revision_queued"
  | "revision_ignored"
  | "reconciliation_blocked"
  | "metadata_race"
  | "sync_start"
  | "sync_finish"
  | "webcontainer_ready"
  | "sync_failed";

export type PreviewTimingDetail = {
  phase: PreviewTimingPhase;
  projectId: number;
  revision: number | null;
  source?: PreviewPayloadSource;
  backendEmittedAt?: string;
  browserReceivedAt?: string;
  syncStartedAt?: string;
  syncFinishedAt?: string;
  webContainerReadyAt?: string;
  reason?: string;
};

export type PreviewTimingLogger = (detail: PreviewTimingDetail) => void;

export function logPreviewTiming(detail: PreviewTimingDetail): void {
  // eslint-disable-next-line no-console -- privacy-safe production timing instrumentation
  console.info("[preview-reconciliation]", JSON.stringify(detail));
}

export function createPreviewRevisionState(projectId: number): PreviewRevisionState {
  return {
    projectId,
    appliedRevision: 0,
    queuedRevision: 0,
    reconcileInFlight: null,
  };
}

function isAuthoritativeRevision(revision: number): boolean {
  return Number.isInteger(revision) && revision > 0;
}

export function acceptPreviewPayload(
  state: PreviewRevisionState,
  payload: ProjectFilesChangedPayload,
  source: PreviewPayloadSource,
  log: PreviewTimingLogger = logPreviewTiming,
  receivedAt = new Date().toISOString(),
): boolean {
  log({
    phase: "browser_receipt",
    projectId: state.projectId,
    revision: payload.revision,
    source,
    backendEmittedAt: payload.generatedAt,
    browserReceivedAt: receivedAt,
  });

  const revisionFloor = Math.max(state.appliedRevision, state.queuedRevision);
  if (
    payload.projectId !== state.projectId ||
    !isAuthoritativeRevision(payload.revision) ||
    payload.revision <= revisionFloor
  ) {
    log({
      phase: "revision_ignored",
      projectId: state.projectId,
      revision: payload.revision,
      source,
      reason:
        payload.projectId !== state.projectId
          ? "project_mismatch"
          : !isAuthoritativeRevision(payload.revision)
            ? "missing_revision"
            : "stale_or_duplicate",
    });
    return false;
  }

  state.queuedRevision = payload.revision;
  log({
    phase: "revision_queued",
    projectId: state.projectId,
    revision: payload.revision,
    source,
  });
  return true;
}

export function markPreviewRevisionApplied(state: PreviewRevisionState, revision: number): boolean {
  if (!isAuthoritativeRevision(revision) || revision < state.appliedRevision) return false;
  state.appliedRevision = revision;
  return revision >= state.queuedRevision;
}

export function markPreviewRevisionFailed(state: PreviewRevisionState, revision: number): boolean {
  if (revision !== state.queuedRevision) return false;
  state.queuedRevision = state.appliedRevision;
  return true;
}

export async function fetchProjectPreviewState(projectId: number): Promise<ProjectPreviewState> {
  const response = await fetch(`/api/projects/${projectId}/preview-state`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Preview metadata request failed (${response.status})`);
  return (await response.json()) as ProjectPreviewState;
}

export async function fetchAuthoritativeProjectFiles(
  projectId: number,
  revision: number,
): Promise<AuthoritativeProjectFile[]> {
  const response = await fetch(`/api/projects/${projectId}/versions/${revision}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Preview files request failed (${response.status})`);
  const version = (await response.json()) as {
    id?: number;
    projectId?: number;
    filesSnapshot?: AuthoritativeProjectFile[];
  };
  if (version.id !== revision || version.projectId !== projectId) {
    throw new Error("Preview version response did not match the requested revision");
  }
  return version.filesSnapshot ?? [];
}

type ReconcilePreviewRevisionOptions = {
  state: PreviewRevisionState;
  source: Extract<PreviewPayloadSource, "stream-connect" | "stream-reconnect" | "task-terminal">;
  fetchMetadata?: (projectId: number) => Promise<ProjectPreviewState>;
  fetchFiles?: (projectId: number, revision: number) => Promise<AuthoritativeProjectFile[]>;
  enqueue: (payload: ProjectFilesChangedPayload, source: PreviewPayloadSource) => void;
  onPendingChange?: (pending: boolean) => void;
  log?: PreviewTimingLogger;
};

async function runReconciliation({
  state,
  source,
  fetchMetadata = fetchProjectPreviewState,
  fetchFiles = fetchAuthoritativeProjectFiles,
  enqueue,
  onPendingChange,
  log = logPreviewTiming,
}: ReconcilePreviewRevisionOptions): Promise<void> {
  const first = await fetchMetadata(state.projectId);
  if (!first.reconciliationAllowed) {
    log({
      phase: "reconciliation_blocked",
      projectId: state.projectId,
      revision: first.revision,
      source,
      reason: first.blockedByStatus ?? "staged_review",
    });
    return;
  }

  const revisionFloor = Math.max(state.appliedRevision, state.queuedRevision);
  if (!first.revision || first.revision <= revisionFloor) return;

  const files = await fetchFiles(state.projectId, first.revision);
  // Close the metadata/files race. A newly staged task must block the enqueue,
  // and a newer revision must be fetched rather than applying mixed snapshots.
  const confirmed = await fetchMetadata(state.projectId);
  if (
    !confirmed.reconciliationAllowed ||
    confirmed.revision !== first.revision ||
    !confirmed.revision
  ) {
    log({
      phase: confirmed.reconciliationAllowed ? "metadata_race" : "reconciliation_blocked",
      projectId: state.projectId,
      revision: confirmed.revision,
      source,
      reason: confirmed.reconciliationAllowed
        ? "revision_changed_during_fetch"
        : (confirmed.blockedByStatus ?? "staged_review"),
    });
    return;
  }

  const payload: ProjectFilesChangedPayload = {
    projectId: state.projectId,
    revision: confirmed.revision,
    operationType: "reconcile",
    changedPaths: files.map((file) => file.path),
    removedPaths: [],
    files: Object.fromEntries(files.map((file) => [file.path, file.content])),
    requiresInstall: false,
    requiresRestart: false,
    generatedAt: confirmed.generatedAt,
    authoritative: true,
  };

  if (!acceptPreviewPayload(state, payload, source, log)) return;
  onPendingChange?.(true);
  enqueue(payload, source);
}

export function reconcilePreviewRevision(options: ReconcilePreviewRevisionOptions): Promise<void> {
  if (options.state.reconcileInFlight) return options.state.reconcileInFlight;
  const running = runReconciliation(options).finally(() => {
    if (options.state.reconcileInFlight === running) {
      options.state.reconcileInFlight = null;
    }
  });
  options.state.reconcileInFlight = running;
  return running;
}
