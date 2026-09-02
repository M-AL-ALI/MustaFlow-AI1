import { useCallback, useEffect, useRef, useState } from "react";
import { isReverificationCancelledError } from "@clerk/react/errors";
import { useReverification } from "@clerk/react";
import { AlertTriangle, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { authFetch } from "@/lib/api-fetch";

const MAX_IMPACT_ITEMS = 32;
const MAX_IMPACT_ITEM_LENGTH = 160;
const MAX_POLL_ATTEMPTS = 120;
const POLL_INTERVAL_MS = 1_500;

const ACTIVE_PURGE_STATES = new Set(["accepted", "running"]);

export type PurgeableTrashedProject = {
  id: number;
  name: string;
  serverNow?: string | null;
  purgeDueAt?: string | null;
  restoreAllowed?: boolean;
  retirementState?: string | null;
  purgeState?: string | null;
  purgeOperationId?: string | null;
  purgeTrigger?: string | null;
  purgeStage?: string | null;
  purgeAttemptCount?: number;
  purgeFailureCode?: string | null;
  purgeFailureRetryable?: boolean | null;
  purgeRetryAllowed?: boolean;
  purgeNextAttemptAt?: string | null;
};

type PermanentDeletionImpact = {
  projectId: number;
  name: string;
  deletedAt: string;
  purgeDueAt: string;
  restoreAllowed: boolean;
  retirementState: string;
  purgeState: string | null;
  willDelete: string[];
  willDetach: string[];
  requiresReverification: true;
};

type PurgeOperation = {
  id: string;
  projectId: number;
  state: "scheduled" | "accepted" | "running" | "failed" | "completed" | "canceled";
  stage: string;
  trigger: string;
  dueAt: string | null;
  attemptCount: number;
  failureCode: string | null;
  failureRetryable: boolean | null;
  retryAllowed: boolean;
  nextAttemptAt: string | null;
  terminalEvidence: Record<string, unknown> | null;
};

type AcceptedDeletion = {
  code: "project_purge_accepted";
  operationId: string;
  state: string;
  statusUrl: string;
};

type DeleteResponse = Record<string, unknown> & { __clientHttpStatus: number };

type ProjectPermanentDeletionControlProps = {
  project: PurgeableTrashedProject;
  onPurgeActivityChange: (projectId: number, active: boolean) => void;
  onStateRefresh: () => void | Promise<void>;
};

export function describePurgeDueAt(purgeDueAt: string | null | undefined, nowMs: number): string {
  if (!purgeDueAt) return "Automatic deletion date is unavailable.";
  const dueAt = new Date(purgeDueAt);
  const dueMs = dueAt.getTime();
  if (!Number.isFinite(dueMs)) return "Automatic deletion date is unavailable.";
  const formattedDate = dueAt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  if (!Number.isFinite(nowMs)) {
    return `Automatic deletion is scheduled for ${formattedDate}; countdown unavailable.`;
  }
  const remainingMs = dueMs - nowMs;
  if (remainingMs <= 0) return `Automatic deletion is due now (${formattedDate}).`;
  const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1_000));
  return `Automatic deletion in ${remainingDays} day${remainingDays === 1 ? "" : "s"} (${formattedDate}).`;
}

export function isPurgeInProgress(state: string | null | undefined): boolean {
  return typeof state === "string" && ACTIVE_PURGE_STATES.has(state);
}

function formatWhen(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function describePurgeState(
  project: PurgeableTrashedProject,
): { message: string; tone: "muted" | "warning" | "danger" } | null {
  switch (project.purgeState) {
    case "scheduled":
      return { message: "Automatic permanent deletion is scheduled.", tone: "muted" };
    case "accepted":
    case "running":
      return {
        message: "Permanent deletion is in progress. Restoration is locked.",
        tone: "warning",
      };
    case "failed": {
      if (project.purgeRetryAllowed) {
        const retryAt = formatWhen(project.purgeNextAttemptAt);
        return {
          message: retryAt
            ? `Permanent deletion paused safely and will retry automatically around ${retryAt}.`
            : "Permanent deletion paused safely. Open progress to retry it now.",
          tone: "warning",
        };
      }
      return {
        message:
          "Permanent deletion stopped safely. Nothing is reported deleted. Contact support for help.",
        tone: "danger",
      };
    }
    case "completed":
      return {
        message: "Permanent deletion completed and final removal is being reconciled.",
        tone: "muted",
      };
    case "canceled":
      return { message: "Permanent deletion was canceled.", tone: "muted" };
    default:
      return null;
  }
}

function createIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `purge-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength = 200): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

function isOpaqueId(value: unknown): value is string {
  return isBoundedString(value, 200) && /^[a-z0-9_-]+$/iu.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isValidTerminalEvidence(
  value: unknown,
  state: PurgeOperation["state"],
  stage: string,
  failureCode: unknown,
  failureRetryable: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value) || value.schema !== "project-purge-terminal-v1") return false;
  if (state === "completed") {
    return (
      hasOnlyKeys(value, [
        "schema",
        "outcome",
        "inventoryDigestSha256",
        "absenceDigestSha256",
        "removedResourceCount",
        "detachedResourceCount",
      ]) &&
      value.outcome === "completed" &&
      isSha256(value.inventoryDigestSha256) &&
      isSha256(value.absenceDigestSha256) &&
      Number.isSafeInteger(value.removedResourceCount) &&
      Number(value.removedResourceCount) >= 0 &&
      Number.isSafeInteger(value.detachedResourceCount) &&
      Number(value.detachedResourceCount) >= 0
    );
  }
  if (state === "failed") {
    return (
      hasOnlyKeys(value, ["schema", "outcome", "stage", "failureCode", "retryable"]) &&
      value.outcome === "failed" &&
      value.stage === stage &&
      value.failureCode === failureCode &&
      value.retryable === failureRetryable
    );
  }
  if (state === "canceled") {
    return (
      hasOnlyKeys(value, ["schema", "outcome", "reason"]) &&
      value.outcome === "canceled" &&
      (value.reason === "project_restored" || value.reason === "owner_canceled_before_start")
    );
  }
  return false;
}

function parseImpact(
  value: unknown,
  project: PurgeableTrashedProject,
): PermanentDeletionImpact | null {
  if (!isRecord(value)) return null;
  if (value.projectId !== project.id || value.name !== project.name) return null;
  if (!isBoundedString(value.deletedAt) || !isBoundedString(value.purgeDueAt)) return null;
  if (typeof value.restoreAllowed !== "boolean") return null;
  if (!isBoundedString(value.retirementState, 80)) return null;
  if (value.purgeState !== null && !isBoundedString(value.purgeState, 80)) return null;
  if (value.requiresReverification !== true) return null;
  if (!Array.isArray(value.willDelete) || !Array.isArray(value.willDetach)) return null;
  if (
    value.willDelete.length === 0 ||
    value.willDelete.length > MAX_IMPACT_ITEMS ||
    value.willDetach.length > MAX_IMPACT_ITEMS
  ) {
    return null;
  }
  if (
    !value.willDelete.every((item) => isBoundedString(item, MAX_IMPACT_ITEM_LENGTH)) ||
    !value.willDetach.every((item) => isBoundedString(item, MAX_IMPACT_ITEM_LENGTH))
  ) {
    return null;
  }
  return value as PermanentDeletionImpact;
}

function parseAcceptedDeletion(value: unknown): AcceptedDeletion | null {
  if (!isRecord(value) || value.__clientHttpStatus !== 202) return null;
  if (value.code !== "project_purge_accepted") return null;
  if (!isOpaqueId(value.operationId) || value.state !== "accepted") return null;
  if (value.statusUrl !== `/api/project-purge-operations/${value.operationId}`) return null;
  return {
    code: "project_purge_accepted",
    operationId: value.operationId,
    state: value.state,
    statusUrl: value.statusUrl,
  };
}

function parseOperation(
  value: unknown,
  operationId: string,
  projectId: number,
): PurgeOperation | null {
  if (!isRecord(value) || value.id !== operationId || value.projectId !== projectId) return null;
  if (
    value.state !== "scheduled" &&
    value.state !== "accepted" &&
    value.state !== "running" &&
    value.state !== "failed" &&
    value.state !== "completed" &&
    value.state !== "canceled"
  ) {
    return null;
  }
  if (!isBoundedString(value.stage, 100) || !isBoundedString(value.trigger, 100)) return null;
  if (value.dueAt !== null && !isBoundedString(value.dueAt)) return null;
  if (!Number.isInteger(value.attemptCount) || Number(value.attemptCount) < 0) return null;
  if (value.failureCode !== null && !isBoundedString(value.failureCode, 120)) return null;
  if (value.failureRetryable !== null && typeof value.failureRetryable !== "boolean") return null;
  if (typeof value.retryAllowed !== "boolean") return null;
  if (value.nextAttemptAt !== null && !isBoundedString(value.nextAttemptAt)) return null;
  if (
    (value.state === "failed" && typeof value.failureRetryable !== "boolean") ||
    (value.state !== "failed" && value.failureRetryable !== null) ||
    (value.retryAllowed && (value.state !== "failed" || value.failureRetryable !== true))
  ) {
    return null;
  }
  if (value.state === "completed" || value.state === "failed" || value.state === "canceled") {
    if (
      !isValidTerminalEvidence(
        value.terminalEvidence,
        value.state,
        value.stage,
        value.failureCode,
        value.failureRetryable,
      )
    ) {
      return null;
    }
  } else if (value.terminalEvidence !== null) {
    return null;
  }
  return value as PurgeOperation;
}

function failureMessage(code: unknown): string {
  switch (code) {
    case "project_purge_name_mismatch":
      return "The project name does not match. Nothing was deleted.";
    case "project_purge_reverification_required":
    case "project_purge_reverification_expired":
      return "Please verify your sign-in again before permanently deleting this project.";
    case "project_purge_retirement_incomplete":
      return "Project cleanup must finish before permanent deletion can begin.";
    case "project_purge_project_active":
      return "Move this project to Trash before permanently deleting it.";
    case "project_purge_operation_conflict":
      return "Permanent deletion is already in progress for this project.";
    case "project_purge_retry_unavailable":
      return "Permanent deletion stopped safely. Contact support before trying again.";
    case "project_purge_retry_key_reused":
      return "Confirm the project name again to start a fresh verified retry.";
    case "project_purge_owner_required":
      return "This project is not available for permanent deletion.";
    case "project_purge_inventory_unavailable":
    case "project_purge_asset_release_failed":
    case "project_purge_snapshot_release_failed":
    case "project_purge_database_release_failed":
    case "project_purge_addon_release_failed":
    case "project_purge_runtime_release_failed":
    case "project_purge_relational_delete_failed":
    case "project_purge_absence_unverified":
    case "project_purge_operation_unavailable":
      return "Permanent deletion paused safely. The project is not reported deleted. Try again.";
    case "project_purge_attempts_exhausted":
      return "Permanent deletion stopped after its retry limit. Contact support for help.";
    default:
      return "We could not confirm whether permanent deletion started. Try again to check the same request safely.";
  }
}

function progressMessage(operation: PurgeOperation): string {
  if (operation.state === "failed") {
    if (operation.retryAllowed) {
      const retryAt = formatWhen(operation.nextAttemptAt);
      return retryAt
        ? `Permanent deletion paused safely and will retry automatically around ${retryAt}.`
        : "Permanent deletion paused safely. You can retry it now.";
    }
    return operation.failureCode === "project_purge_attempts_exhausted"
      ? "Permanent deletion stopped after its retry limit. Contact support for help."
      : "Permanent deletion stopped safely. Nothing is reported deleted. Contact support for help.";
  }
  if (operation.state === "completed") {
    return operation.terminalEvidence
      ? "Project permanently deleted. Its NabuFlow-owned data and resources were verified absent."
      : "Deletion finished, but final absence evidence is still being verified.";
  }
  if (operation.state === "canceled") {
    return "Permanent deletion was canceled. The project was not permanently deleted.";
  }
  switch (operation.stage) {
    case "verify":
      return operation.state === "scheduled"
        ? "Permanent deletion is scheduled for the end of the recovery period."
        : "Confirming that this project can be deleted safely.";
    case "inventory":
      return "Checking every project-owned resource before deletion.";
    case "assets":
      return "Removing files that only this project uses.";
    case "snapshots":
      return "Removing saved runtime copies owned by this project.";
    case "database":
      return "Removing databases owned by this project.";
    case "addons":
      return "Removing add-ons owned by this project.";
    case "runtime":
      return "Removing previews, published services, and routes.";
    case "relational":
      return "Removing the project's remaining NabuFlow records.";
    case "absence":
      return "Verifying that project data and owned resources are gone.";
    default:
      return "Permanent deletion is in progress.";
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function operationSummaryFromProject(project: PurgeableTrashedProject): PurgeOperation | null {
  if (
    !isOpaqueId(project.purgeOperationId) ||
    (project.purgeState !== "accepted" &&
      project.purgeState !== "running" &&
      project.purgeState !== "failed" &&
      project.purgeState !== "completed") ||
    !isBoundedString(project.purgeStage, 100) ||
    (project.purgeTrigger !== "manual" && project.purgeTrigger !== "expiry") ||
    !Number.isInteger(project.purgeAttemptCount) ||
    Number(project.purgeAttemptCount) < 0
  ) {
    return null;
  }
  const failed = project.purgeState === "failed";
  return {
    id: project.purgeOperationId,
    projectId: project.id,
    state: project.purgeState,
    stage: project.purgeStage,
    trigger: project.purgeTrigger,
    dueAt: project.purgeDueAt ?? null,
    attemptCount: Number(project.purgeAttemptCount),
    failureCode: failed ? (project.purgeFailureCode ?? null) : null,
    failureRetryable: failed ? (project.purgeFailureRetryable ?? false) : null,
    retryAllowed: failed && project.purgeRetryAllowed === true,
    nextAttemptAt: failed ? (project.purgeNextAttemptAt ?? null) : null,
    // The list is a recovery locator, not terminal proof. The owner-facing
    // status route must still supply and validate the terminal evidence.
    terminalEvidence: null,
  };
}

export function ProjectPermanentDeletionControl({
  project,
  onPurgeActivityChange,
  onStateRefresh,
}: ProjectPermanentDeletionControlProps) {
  const [open, setOpen] = useState(false);
  const [impact, setImpact] = useState<PermanentDeletionImpact | null>(null);
  const [impactBusy, setImpactBusy] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [operation, setOperation] = useState<PurgeOperation | null>(null);
  const [pollAttempts, setPollAttempts] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const requestLock = useRef(false);
  const confirmationInputRef = useRef<HTMLInputElement>(null);
  const initialPurgeInProgress = isPurgeInProgress(project.purgeState);

  const requestPermanentDeletion = useReverification(
    async (projectName: string, key: string): Promise<DeleteResponse> => {
      const response = await authFetch(`/api/projects/${project.id}/permanent`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({ projectName }),
      });
      const body = await readJson(response);
      return {
        ...(isRecord(body) ? body : {}),
        __clientHttpStatus: response.status,
      };
    },
  );

  async function loadImpact() {
    setImpactBusy(true);
    setFailure(null);
    try {
      const response = await authFetch(`/api/projects/${project.id}/permanent-deletion-impact`, {
        method: "GET",
      });
      const parsed =
        response.status === 200 ? parseImpact(await readJson(response), project) : null;
      if (!parsed) {
        setFailure("The deletion impact could not be loaded. Nothing was deleted.");
        return;
      }
      setImpact(parsed);
    } catch {
      setFailure("The deletion impact could not be loaded. Nothing was deleted.");
    } finally {
      setImpactBusy(false);
    }
  }

  const refreshThenReleaseLocalLock = useCallback(() => {
    void Promise.resolve(onStateRefresh())
      .catch(() => undefined)
      .finally(() => onPurgeActivityChange(project.id, false));
  }, [onPurgeActivityChange, onStateRefresh, project.id]);

  function openDialog() {
    const recoveredOperation = operation ?? operationSummaryFromProject(project);
    setOpen(true);
    setImpact(null);
    setConfirmation("");
    setFailure(null);
    setPollAttempts(0);
    setOperation(recoveredOperation);
    if (recoveredOperation && isPurgeInProgress(recoveredOperation.state)) {
      onPurgeActivityChange(project.id, true);
    }
    if (!idempotencyKey) setIdempotencyKey(createIdempotencyKey());
    void loadImpact();
  }

  function handleDialogOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen && operation) refreshThenReleaseLocalLock();
  }

  useEffect(() => {
    if (
      open &&
      impact &&
      (!operation || (operation.state === "failed" && operation.retryAllowed))
    ) {
      confirmationInputRef.current?.focus();
    }
  }, [impact, open, operation]);

  async function startPermanentDeletion() {
    if (requestLock.current || !impact || confirmation !== project.name || !idempotencyKey) {
      return;
    }
    requestLock.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const body = await requestPermanentDeletion(project.name, idempotencyKey);
      const accepted = parseAcceptedDeletion(body);
      if (!accepted) {
        setFailure(failureMessage(body.code));
        return;
      }
      const pending: PurgeOperation = {
        id: accepted.operationId,
        projectId: project.id,
        state: "accepted",
        stage: "verify",
        trigger: "manual",
        dueAt: null,
        attemptCount: 0,
        failureCode: null,
        failureRetryable: null,
        retryAllowed: false,
        nextAttemptAt: null,
        terminalEvidence: null,
      };
      setOperation(pending);
      setPollAttempts(0);
      onPurgeActivityChange(project.id, true);
    } catch (error) {
      setFailure(
        isReverificationCancelledError(error)
          ? "Verification was cancelled. Nothing was deleted."
          : "We could not confirm whether permanent deletion started. Try again to check the same request safely.",
      );
    } finally {
      requestLock.current = false;
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (!operation) return;
    const terminalWithEvidence =
      (operation.state === "failed" ||
        operation.state === "canceled" ||
        operation.state === "completed") &&
      operation.terminalEvidence !== null;
    if (terminalWithEvidence || pollAttempts >= MAX_POLL_ATTEMPTS) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const response = await authFetch(
          `/api/project-purge-operations/${encodeURIComponent(operation.id)}`,
          { method: "GET" },
        );
        const next =
          response.status === 200
            ? parseOperation(await readJson(response), operation.id, project.id)
            : null;
        if (cancelled) return;
        if (!next) {
          setFailure("Deletion progress could not be checked. The operation was not restarted.");
          setPollAttempts((current) => current + 1);
          return;
        }
        setFailure(null);
        setOperation(next);
        setPollAttempts((current) => current + 1);
        if (next.state === "failed" && next.terminalEvidence) {
          setIdempotencyKey(createIdempotencyKey());
          setConfirmation("");
        }
        if ((next.state === "failed" || next.state === "canceled") && next.terminalEvidence) {
          refreshThenReleaseLocalLock();
        }
      } catch {
        if (!cancelled) {
          setFailure("Deletion progress could not be checked. The operation was not restarted.");
          setPollAttempts((current) => current + 1);
        }
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [operation, pollAttempts, project.id, refreshThenReleaseLocalLock]);

  const operationCompleted =
    operation?.state === "completed" && operation.terminalEvidence !== null;
  const operationFailed = operation?.state === "failed";
  const operationCanceled = operation?.state === "canceled";
  const recoverableOperation = operationSummaryFromProject(project);
  const hasRecoverableOperation = Boolean(recoverableOperation);
  const canStart =
    project.retirementState === "completed" &&
    !initialPurgeInProgress &&
    project.purgeState !== "completed";
  const impactAllowsStart =
    impact?.retirementState === "completed" &&
    !isPurgeInProgress(impact.purgeState) &&
    impact.purgeState !== "completed";
  const operationHasTerminalEvidence = Boolean(
    operation &&
    (operation.state === "failed" ||
      operation.state === "canceled" ||
      operation.state === "completed") &&
    operation.terminalEvidence,
  );
  const timedOut = Boolean(
    operation && pollAttempts >= MAX_POLL_ATTEMPTS && !operationHasTerminalEvidence,
  );

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={openDialog}
        disabled={!canStart && !hasRecoverableOperation}
        className="inline-flex items-center justify-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={
          hasRecoverableOperation
            ? `View permanent deletion progress for project "${project.name}"`
            : `Delete project "${project.name}" permanently`
        }
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        {hasRecoverableOperation ? "View deletion progress" : "Delete permanently"}
      </button>
      {project.retirementState !== "completed" && (
        <p className="max-w-52 text-xs text-muted-foreground">
          Cleanup must finish before permanent deletion.
        </p>
      )}
      {initialPurgeInProgress && !hasRecoverableOperation && (
        <p className="max-w-52 text-xs text-muted-foreground">
          Permanent deletion is in progress, but its progress receipt is unavailable. Refresh Trash
          before trying again.
        </p>
      )}

      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="max-h-[90vh] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="[overflow-wrap:anywhere]">
              Delete “{project.name}” permanently?
            </DialogTitle>
            <DialogDescription>
              This cannot be undone. Your sign-in will be verified again before deletion starts.
            </DialogDescription>
          </DialogHeader>

          {impactBusy && (
            <div
              className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading the deletion impact…
            </div>
          )}

          {impact && !operationCompleted && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                  <h3 className="text-sm font-semibold text-destructive">Permanently removed</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                    {impact.willDelete.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
                <section className="rounded-lg border border-border bg-muted/30 p-3">
                  <h3 className="text-sm font-semibold">Preserved and detached</h3>
                  {impact.willDetach.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                      {impact.willDetach.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">
                      No externally owned resources are attached.
                    </p>
                  )}
                </section>
              </div>

              {!impactAllowsStart && (
                <p className="text-sm text-muted-foreground" role="status">
                  {isPurgeInProgress(impact.purgeState)
                    ? "Permanent deletion is already in progress."
                    : "Project cleanup must finish before permanent deletion can begin."}
                </p>
              )}

              {!operation || (operationFailed && operation?.retryAllowed) ? (
                <div className="space-y-2">
                  <label
                    htmlFor={`purge-confirm-${project.id}`}
                    className="block text-sm font-medium"
                  >
                    Type <span className="font-mono [overflow-wrap:anywhere]">{project.name}</span>{" "}
                    to confirm
                  </label>
                  <input
                    ref={confirmationInputRef}
                    id={`purge-confirm-${project.id}`}
                    type="text"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={submitting}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm [overflow-wrap:anywhere] focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                  />
                </div>
              ) : null}
            </div>
          )}

          {operation && (
            <div
              className="rounded-lg border border-border bg-muted/30 p-4"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-start gap-3">
                {operationCompleted ? (
                  <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-600" aria-hidden="true" />
                ) : operationFailed || operationCanceled ? (
                  <AlertTriangle className="mt-0.5 h-5 w-5 text-destructive" aria-hidden="true" />
                ) : (
                  <Loader2 className="mt-0.5 h-5 w-5 animate-spin" aria-hidden="true" />
                )}
                <div>
                  <p className="text-sm font-medium">{progressMessage(operation)}</p>
                  {!operationCompleted && !operationFailed && !operationCanceled && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Keep this page open to see final verified completion.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {timedOut && (
            <div className="space-y-2" role="status">
              <p className="text-sm text-muted-foreground">
                Progress checking paused. The deletion operation was not restarted.
              </p>
              <button
                type="button"
                onClick={() => setPollAttempts(0)}
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                Check progress again
              </button>
            </div>
          )}

          {failure && (
            <p className="text-sm text-destructive" role="alert">
              {failure}
            </p>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            {operationCompleted ? (
              <button
                type="button"
                onClick={() => handleDialogOpenChange(false)}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Done
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => handleDialogOpenChange(false)}
                  className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  {operation ? "Close" : "Cancel"}
                </button>
                {(!operation || (operationFailed && operation?.retryAllowed)) &&
                  !operationCanceled && (
                    <button
                      type="button"
                      onClick={() => void startPermanentDeletion()}
                      disabled={
                        !impact ||
                        !impactAllowsStart ||
                        confirmation !== project.name ||
                        submitting ||
                        Boolean(operationFailed && !operation?.retryAllowed)
                      }
                      className="inline-flex items-center justify-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {submitting && (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      )}
                      {submitting
                        ? "Verifying and starting…"
                        : operationFailed
                          ? "Verify and retry permanent deletion"
                          : "Verify and delete permanently"}
                    </button>
                  )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
