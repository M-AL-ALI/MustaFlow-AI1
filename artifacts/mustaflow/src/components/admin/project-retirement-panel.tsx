import { useRef, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { authFetch } from "@/lib/api-fetch";

export const AUTHORIZED_PROJECT_RETIREMENT_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 52,
  53, 54, 55,
] as const;

const AUTHORIZED_PROJECT_RETIREMENT_ID_SET = new Set<number>(AUTHORIZED_PROJECT_RETIREMENT_IDS);

export const PROJECT_RETIREMENT_CONFIRMATION = "RETIRE PROJECTS 1-50 AND 52-55";

type RetirementReceipt =
  | { projectId: number; state: "not_found" }
  | { projectId: number; state: "refused"; code: string; error?: string }
  | {
      projectId: number;
      operationId: string;
      state: "accepted";
      cleanupScheduled: boolean;
      cleanupScheduleState: "enqueued" | "already_scheduled" | "unavailable";
      statusUrl?: string;
    }
  | {
      projectId: number;
      operationId: string;
      state: "completed";
      cleanupComplete: true;
      statusUrl: string;
    };

type RetirementBatchResponse = {
  code: string;
  error?: string;
  retryable?: boolean;
  receipts: RetirementReceipt[];
};

type AcceptedRetirementReceipt = Extract<RetirementReceipt, { state: "accepted" }>;

type RetirementRetryResult =
  | { kind: "accepted"; receipt: AcceptedRetirementReceipt }
  | { kind: "refused"; code: string };

type ReceiptStateSummary = {
  total: number;
  states: Readonly<Record<string, number>>;
  stages: Readonly<Record<string, number>>;
};

type ProjectRetirementProgress = {
  route: {
    state: "pending" | "deactivating" | "verified_absent" | "failed" | null;
    legacyHostnameKv: {
      state: "not_configured" | "verified_absent" | "failed" | null;
    } | null;
    hostnames: ReceiptStateSummary;
    runtimeRoutes: ReceiptStateSummary;
    cache: { state: "pending" | "purged" | "failed" | null };
  };
  retainedLegacyRuntimePointers: {
    total: number;
    reasons: Readonly<Record<string, number>>;
  };
  legacyRuntimeResolutions: {
    total: number;
    states: Readonly<Record<string, number>>;
    proofs: Readonly<Record<string, number>>;
    reasons: Readonly<Record<string, number>>;
    retryable: number;
  };
};

type ProjectRetirementStatus = {
  operationId: string;
  projectId: number;
  state: "accepted" | "running" | "failed" | "completed" | "canceled";
  attemptCount: number;
  failureCode: string | null;
  completedAt: string | null;
  reconciliationEligible: boolean;
  progress: ProjectRetirementProgress | null;
};

type SingleProjectRetirementResult =
  | { kind: "status"; status: ProjectRetirementStatus }
  | { kind: "accepted"; receipt: AcceptedRetirementReceipt };

const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  project_retirement_legacy_runtime_requires_migration:
    "This project uses an older runtime that cannot be retired safely yet.",
  project_retirement_managed_addon_unverified:
    "This project has an add-on whose safe removal cannot be verified yet.",
  project_retirement_remote_build_in_progress:
    "This project has a mobile build in progress. Wait for it to finish before moving the project to Trash.",
  project_retirement_provider_provisioning_in_progress:
    "This project is still setting up its runtime or database. Wait for setup to finish before moving it to Trash.",
  project_retirement_provider_configuration_unavailable:
    "This project's public routes cannot be retired safely right now. Please try again after platform configuration is restored.",
  project_retirement_sqlite_recovery_unverified:
    "This project's database cannot be preserved and restored safely yet.",
  project_retirement_receipt_upgrade_in_progress:
    "This project's earlier Trash cleanup is still running and must finish before its safety receipt can be upgraded.",
  project_retirement_reconciliation_required:
    "This project's Trash cleanup did not finish safely. Retry its governed cleanup before continuing.",
};

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  project_retirement_route_deactivation_failed:
    "The published route could not be deactivated safely.",
  project_retirement_route_deactivation_unverified:
    "The published route could not be verified as inactive.",
  project_retirement_domain_release_failed: "A project domain could not be released safely.",
  project_retirement_domain_release_unverified: "A project domain release could not be verified.",
  project_retirement_domain_security_release_failed:
    "A domain security resource could not be released safely.",
  project_retirement_domain_security_release_unverified:
    "A domain security resource release could not be verified.",
  project_retirement_legacy_r2_release_failed:
    "Legacy published files could not be removed safely.",
  project_retirement_legacy_r2_release_unverified:
    "Legacy published-file removal could not be verified.",
  project_retirement_runtime_destroy_failed: "A project runtime could not be removed safely.",
  project_retirement_runtime_destroy_unverified: "A project runtime removal could not be verified.",
  project_retirement_legacy_runtime_provider_unavailable:
    "The earlier project runtime could not be checked right now.",
  project_retirement_legacy_runtime_absence_unverified:
    "The earlier project runtime removal could not be verified.",
  project_retirement_legacy_runtime_retained:
    "An older project runtime was retained because safe removal could not be verified.",
  project_retirement_attempts_exhausted: "Governed cleanup exhausted its automatic attempts.",
  project_retirement_completion_evidence_incomplete:
    "The cleanup completion evidence is incomplete.",
  project_retirement_operation_unavailable: "The cleanup operation was temporarily unavailable.",
};

function shortPlainSentence(value: string | undefined): string | null {
  if (!value) return null;
  const sentence = value.trim();
  if (sentence.length < 8 || sentence.length > 180) return null;
  if (!/^[A-Z][A-Za-z0-9 ,.'’()-]+[.!?]$/u.test(sentence)) return null;
  if (
    /\b(?:sqlstate|exception|stack trace|errno|constraint failure|database error|internal server error)\b/iu.test(
      sentence,
    )
  ) {
    return null;
  }
  return sentence;
}

function isRetirementReceipt(value: unknown): value is RetirementReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return (
    typeof receipt.projectId === "number" &&
    AUTHORIZED_PROJECT_RETIREMENT_ID_SET.has(receipt.projectId) &&
    (receipt.state === "not_found" ||
      receipt.state === "refused" ||
      receipt.state === "accepted" ||
      receipt.state === "completed")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function closedValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function parseCountMap(
  value: unknown,
  allowedKeys: readonly string[],
): Readonly<Record<string, number>> {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const key of allowedKeys) {
    const count = safeCount(value[key]);
    if (count !== null) result[key] = count;
  }
  return result;
}

function parseReceiptStateSummary(
  value: unknown,
  allowedStates: readonly string[],
  allowedStages: readonly string[] = [],
): ReceiptStateSummary | null {
  if (!isRecord(value)) return null;
  const total = safeCount(value.total);
  if (total === null) return null;
  return {
    total,
    states: parseCountMap(value.states, allowedStates),
    stages: parseCountMap(value.stages, allowedStages),
  };
}

function parseProjectRetirementProgress(value: unknown): ProjectRetirementProgress | null {
  if (value === undefined) return null;
  if (!isRecord(value) || !isRecord(value.route)) return null;
  const route = value.route;
  const hostnames = parseReceiptStateSummary(
    route.hostnames,
    ["absent", "present", "unavailable"],
    ["delete", "read"],
  );
  const runtimeRoutes = parseReceiptStateSummary(route.runtimeRoutes, [
    "releasing",
    "verified_absent",
    "present",
    "unavailable",
  ]);
  const cache = isRecord(route.cache) ? route.cache : null;
  const retained = isRecord(value.retainedLegacyRuntimePointers)
    ? value.retainedLegacyRuntimePointers
    : null;
  const legacyResolutions = isRecord(value.legacyRuntimeResolutions)
    ? value.legacyRuntimeResolutions
    : null;
  const retainedTotal = retained ? safeCount(retained.total) : null;
  const legacyResolutionTotal = legacyResolutions ? safeCount(legacyResolutions.total) : 0;
  const legacyResolutionRetryable = legacyResolutions ? safeCount(legacyResolutions.retryable) : 0;
  if (
    !hostnames ||
    !runtimeRoutes ||
    !cache ||
    !retained ||
    retainedTotal === null ||
    legacyResolutionTotal === null ||
    legacyResolutionRetryable === null
  ) {
    return null;
  }
  const legacyHostnameKv = isRecord(route.legacyHostnameKv) ? route.legacyHostnameKv : null;
  return {
    route: {
      state: closedValue(route.state, ["pending", "deactivating", "verified_absent", "failed"]),
      legacyHostnameKv: legacyHostnameKv
        ? {
            state: closedValue(legacyHostnameKv.state, [
              "not_configured",
              "verified_absent",
              "failed",
            ]),
          }
        : null,
      hostnames,
      runtimeRoutes,
      cache: { state: closedValue(cache.state, ["pending", "purged", "failed"]) },
    },
    retainedLegacyRuntimePointers: {
      total: retainedTotal,
      reasons: parseCountMap(retained.reasons, [
        "runtime_identity_malformed",
        "runtime_namespace_mismatch",
        "runtime_project_mismatch",
        "runtime_role_slot_mismatch",
        "legacy_runtime_provider",
      ]),
    },
    legacyRuntimeResolutions: {
      total: legacyResolutionTotal,
      states: parseCountMap(legacyResolutions?.states, ["verified_absent", "retained"]),
      proofs: parseCountMap(legacyResolutions?.proofs, ["initial_get_404", "delete_then_get_404"]),
      reasons: parseCountMap(legacyResolutions?.reasons, [
        "legacy_pointer_malformed",
        "provider_observation_unavailable",
        "provider_response_invalid",
        "machine_identity_mismatch",
        "project_identity_mismatch",
        "contradictory_identity_marker",
        "storage_ownership_ambiguous",
        "provider_delete_unavailable",
        "absence_unverified",
      ]),
      retryable: legacyResolutionRetryable,
    },
  };
}

function parseRetirementBatchResponse(value: unknown): RetirementBatchResponse | null {
  if (!value || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  if (typeof response.code !== "string" && typeof response.error !== "string") return null;
  return {
    code: typeof response.code === "string" ? response.code : "project_retirement_request_failed",
    ...(typeof response.error === "string" ? { error: response.error } : {}),
    ...(typeof response.retryable === "boolean" ? { retryable: response.retryable } : {}),
    receipts: Array.isArray(response.receipts) ? response.receipts.filter(isRetirementReceipt) : [],
  };
}

function parseRetirementRetryResult(
  value: unknown,
  expectedProjectId: number,
  httpStatus: number,
): RetirementRetryResult | null {
  if (!value || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  const expectedStatusUrl = `/api/projects/${expectedProjectId}/retirement`;
  if (
    httpStatus === 202 &&
    response.code === "project_retirement_reconciliation_accepted" &&
    response.projectId === expectedProjectId &&
    response.state === "accepted" &&
    typeof response.operationId === "string" &&
    response.operationId.length > 0 &&
    response.cleanupScheduled === true &&
    (response.cleanupScheduleState === "enqueued" ||
      response.cleanupScheduleState === "already_scheduled") &&
    response.statusUrl === expectedStatusUrl
  ) {
    return {
      kind: "accepted",
      receipt: {
        projectId: expectedProjectId,
        operationId: response.operationId,
        state: "accepted",
        cleanupScheduled: true,
        cleanupScheduleState: response.cleanupScheduleState,
        statusUrl: expectedStatusUrl,
      },
    };
  }
  if (
    httpStatus === 503 &&
    response.code === "project_retirement_cleanup_pending" &&
    response.projectId === expectedProjectId &&
    response.state === "accepted" &&
    typeof response.operationId === "string" &&
    response.operationId.length > 0 &&
    response.cleanupScheduled === false &&
    response.cleanupScheduleState === "unavailable" &&
    response.retryable === true &&
    response.statusUrl === undefined
  ) {
    return {
      kind: "accepted",
      receipt: {
        projectId: expectedProjectId,
        operationId: response.operationId,
        state: "accepted",
        cleanupScheduled: false,
        cleanupScheduleState: "unavailable",
      },
    };
  }
  if (httpStatus === 202 || httpStatus === 503) return null;
  return typeof response.code === "string" ? { kind: "refused", code: response.code } : null;
}

function parseProjectRetirementStatus(
  value: unknown,
  expectedProjectId: number,
): ProjectRetirementStatus | null {
  if (!value || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  const state = response.state;
  const completedAt = response.completedAt;
  if (
    typeof response.operationId !== "string" ||
    response.projectId !== expectedProjectId ||
    (state !== "accepted" &&
      state !== "running" &&
      state !== "failed" &&
      state !== "completed" &&
      state !== "canceled") ||
    typeof response.attemptCount !== "number" ||
    !Number.isSafeInteger(response.attemptCount) ||
    response.attemptCount < 0 ||
    (response.failureCode !== null && typeof response.failureCode !== "string") ||
    typeof response.reconciliationEligible !== "boolean" ||
    (completedAt !== null &&
      (typeof completedAt !== "string" || !Number.isFinite(Date.parse(completedAt))))
  ) {
    return null;
  }
  return {
    operationId: response.operationId,
    projectId: expectedProjectId,
    state,
    attemptCount: response.attemptCount,
    failureCode: response.failureCode,
    completedAt,
    reconciliationEligible: response.reconciliationEligible,
    progress: parseProjectRetirementProgress(response.progress),
  };
}

function retryFailureSummary(code: string): string {
  switch (code) {
    case "project_retirement_worker_unavailable":
    case "project_retirement_cleanup_pending":
      return "Governed cleanup cannot be retried right now. Try again shortly.";
    case "project_retirement_not_found":
      return "No retirement receipt is available for governed cleanup.";
    case "project_retirement_not_terminal":
    case "project_retirement_retry_not_allowed":
    case "project_retirement_reconciliation_limit_reached":
      return "This retirement receipt is not eligible for another governed cleanup.";
    case "project_retirement_provider_configuration_unavailable":
      return "This project's public routes cannot be retired safely right now. Try again after platform configuration is restored.";
    default:
      return "Governed cleanup could not be retried. Try again shortly.";
  }
}

function statusSummary(status: ProjectRetirementStatus): string {
  switch (status.state) {
    case "accepted":
      return "Cleanup was accepted and is waiting to start.";
    case "running":
      return "Cleanup is running.";
    case "completed":
      return "Cleanup completed successfully.";
    case "canceled":
      return "Cleanup was canceled.";
    case "failed":
      return status.completedAt
        ? "Cleanup ended with a terminal failure."
        : "Cleanup attempt failed and remains eligible for automatic retry.";
  }
}

function failureEvidenceSummary(failureCode: string | null): string {
  if (!failureCode) return "Failure evidence was recorded without a specific safe explanation.";
  return FAILURE_MESSAGES[failureCode] ?? "Failure evidence is recorded for this cleanup.";
}

function retirementProgressEvidence(status: ProjectRetirementStatus): string[] {
  const progress = status.progress;
  if (!progress) return [];
  const evidence: string[] = [];
  const route = progress.route;
  if (route.cache.state === "failed") {
    evidence.push("Cache clearing could not be verified.");
  }
  if ((route.hostnames.states.present ?? 0) > 0) {
    evidence.push("At least one legacy route still appeared in the route registry.");
  }
  if ((route.hostnames.states.unavailable ?? 0) > 0) {
    evidence.push(
      (route.hostnames.stages.delete ?? 0) > 0
        ? "At least one legacy route could not be removed."
        : "At least one legacy route could not be checked after removal.",
    );
  }
  if ((route.runtimeRoutes.states.present ?? 0) > 0) {
    evidence.push("At least one production route still appeared in the runtime inventory.");
  }
  if ((route.runtimeRoutes.states.unavailable ?? 0) > 0) {
    evidence.push("The production route inventory could not be verified.");
  }
  if (route.legacyHostnameKv?.state === "failed") {
    evidence.push("The legacy route registry could not be verified.");
  }
  if (progress.retainedLegacyRuntimePointers.total > 0) {
    evidence.push(
      (progress.retainedLegacyRuntimePointers.reasons.legacy_runtime_provider ?? 0) > 0
        ? "A historical runtime from the previous provider is retained for separate governed cleanup."
        : "A historical runtime reference is retained because its ownership could not be verified.",
    );
  }
  if ((progress.legacyRuntimeResolutions.proofs.delete_then_get_404 ?? 0) > 0) {
    evidence.push("A historical runtime was removed and verified absent.");
  }
  if ((progress.legacyRuntimeResolutions.proofs.initial_get_404 ?? 0) > 0) {
    evidence.push("A historical runtime was already absent when checked.");
  }
  return [...new Set(evidence)];
}

function batchSummary(response: RetirementBatchResponse): string {
  switch (response.code) {
    case "project_retirement_batch_accepted":
      return "The authorized retirement batch was accepted.";
    case "project_retirement_batch_partially_accepted":
      return "The batch was partially accepted. Review the refused projects below.";
    case "project_retirement_cleanup_pending":
      return "Projects are in Trash, but some cleanup scheduling is still pending.";
    case "project_retirement_batch_refused":
      return "No project was accepted. Review the refusal receipts below.";
    case "project_retirement_batch_not_found":
      return "No matching projects were found.";
    case "project_retirement_worker_unavailable":
      return "Projects cannot be moved to Trash right now. Try again shortly.";
    case "project_retirement_batch_invalid":
      return "The retirement manifest was rejected. Reload this page before trying again.";
    default:
      return "The retirement request returned an unrecognized result.";
  }
}

function receiptSummary(receipt: RetirementReceipt): string {
  switch (receipt.state) {
    case "not_found":
      return "Project was not found.";
    case "refused": {
      const reason =
        shortPlainSentence(receipt.error) ??
        REFUSAL_MESSAGES[receipt.code] ??
        "This project could not be retired safely.";
      return `Not retired — ${reason}`;
    }
    case "completed":
      return "Cleanup is complete; the existing receipt was replayed.";
    case "accepted":
      if (!receipt.cleanupScheduled || receipt.cleanupScheduleState === "unavailable") {
        return "Moved to Trash; cleanup scheduling is pending.";
      }
      return receipt.cleanupScheduleState === "already_scheduled"
        ? "Cleanup was already scheduled; the existing receipt was reused."
        : "Cleanup was accepted and queued.";
  }
}

function receiptStatusUrl(receipt: RetirementReceipt): string | null {
  if (receipt.state !== "accepted" && receipt.state !== "completed") return null;
  return `/api/projects/${receipt.projectId}/retirement`;
}

export function ProjectRetirementPanel() {
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RetirementBatchResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [retryingProjectIds, setRetryingProjectIds] = useState<ReadonlySet<number>>(new Set());
  const [retryFailures, setRetryFailures] = useState<Readonly<Record<number, string>>>({});
  const [lookupProjectId, setLookupProjectId] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupFailure, setLookupFailure] = useState<string | null>(null);
  const [singleProjectResult, setSingleProjectResult] =
    useState<SingleProjectRetirementResult | null>(null);
  const submissionLock = useRef(false);
  const retryLocks = useRef(new Set<number>());
  const lookupLock = useRef(false);
  const confirmed = confirmation === PROJECT_RETIREMENT_CONFIRMATION;

  async function retireAuthorizedProjects() {
    if (!confirmed || submissionLock.current) return;
    submissionLock.current = true;
    setSubmitting(true);
    setFailure(null);
    setResult(null);

    try {
      const response = await authFetch("/api/admin/projects/retirement/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectIds: [...AUTHORIZED_PROJECT_RETIREMENT_IDS] }),
      });
      const parsed = parseRetirementBatchResponse(await response.json());
      if (!parsed) throw new Error("The retirement service returned an unreadable response.");
      setResult(parsed);
      setConfirmation("");
    } catch {
      setFailure("The retirement request could not be completed. Try again shortly.");
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
  }

  async function retryGovernedCleanup(projectId: number) {
    if (!AUTHORIZED_PROJECT_RETIREMENT_ID_SET.has(projectId)) return;
    if (retryLocks.current.has(projectId)) return;
    retryLocks.current.add(projectId);
    setRetryingProjectIds((current) => new Set(current).add(projectId));
    setRetryFailures((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });

    try {
      const response = await authFetch(`/api/projects/${projectId}/retirement/retry`, {
        method: "POST",
      });
      const retry = parseRetirementRetryResult(await response.json(), projectId, response.status);
      if (!retry) {
        setRetryFailures((current) => ({
          ...current,
          [projectId]: "Governed cleanup could not be retried. Try again shortly.",
        }));
        return;
      }
      if (retry.kind === "refused") {
        setRetryFailures((current) => ({
          ...current,
          [projectId]: retryFailureSummary(retry.code),
        }));
        return;
      }
      setResult((current) =>
        current
          ? {
              ...current,
              receipts: current.receipts.map((receipt) =>
                receipt.projectId === projectId ? retry.receipt : receipt,
              ),
            }
          : current,
      );
      setSingleProjectResult((current) => {
        if (!current) return current;
        const currentProjectId =
          current.kind === "status" ? current.status.projectId : current.receipt.projectId;
        return currentProjectId === projectId
          ? { kind: "accepted", receipt: retry.receipt }
          : current;
      });
    } catch {
      setRetryFailures((current) => ({
        ...current,
        [projectId]: "Governed cleanup could not be retried. Try again shortly.",
      }));
    } finally {
      retryLocks.current.delete(projectId);
      setRetryingProjectIds((current) => {
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
    }
  }

  async function lookupRetirementStatus() {
    setLookupFailure(null);
    setSingleProjectResult(null);
    const candidate = lookupProjectId.trim();
    const projectId = Number(candidate);
    if (!/^[1-9]\d*$/u.test(candidate) || !Number.isSafeInteger(projectId)) {
      setLookupFailure("Enter a positive whole-number project ID.");
      return;
    }
    if (!AUTHORIZED_PROJECT_RETIREMENT_ID_SET.has(projectId)) {
      setLookupFailure(
        projectId === 51
          ? "Project 51 is excluded from the authorized retirement manifest."
          : "This project is not in the authorized retirement manifest.",
      );
      return;
    }
    if (lookupLock.current) return;
    lookupLock.current = true;
    setLookupBusy(true);
    setRetryFailures((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });

    try {
      const response = await authFetch(`/api/projects/${projectId}/retirement`, {
        method: "GET",
      });
      const body = await response.json();
      const status = response.status === 200 ? parseProjectRetirementStatus(body, projectId) : null;
      if (!status) {
        setLookupFailure(
          "Retirement status could not be loaded. Check the project ID and try again.",
        );
        return;
      }
      setSingleProjectResult({ kind: "status", status });
    } catch {
      setLookupFailure(
        "Retirement status could not be loaded. Check the project ID and try again.",
      );
    } finally {
      lookupLock.current = false;
      setLookupBusy(false);
    }
  }

  function governedRetryControl(projectId: number) {
    const retrying = retryingProjectIds.has(projectId);
    return (
      <div className="mt-2 space-y-2">
        <button
          type="button"
          aria-label={`Retry governed cleanup for Project ${projectId}`}
          onClick={() => void retryGovernedCleanup(projectId)}
          disabled={retrying || submitting || lookupBusy}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {retrying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {retrying ? "Retrying governed cleanup…" : "Retry governed cleanup"}
        </button>
        {retryFailures[projectId] && (
          <p className="text-xs text-destructive" role="alert">
            {retryFailures[projectId]}
          </p>
        )}
      </div>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border bg-muted/40 px-4 py-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Trash2 className="h-3.5 w-3.5" /> Retire rollout test projects
        </h3>
      </div>

      <div className="space-y-4 p-4">
        <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          <p>
            <strong className="text-foreground">Purpose:</strong> Move the authorized rollout test
            projects to Trash and start governed cleanup.
          </p>
          <p>
            <strong className="text-foreground">Operator action:</strong> Verify the exact manifest,
            type the confirmation, then submit once.
          </p>
          <p>
            <strong className="text-foreground">Freshness:</strong> Each result is the typed receipt
            returned by the retirement service.
          </p>
        </div>

        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <p className="font-medium text-foreground">
            Exact rollout manifest: Projects 1–50 and 52–55 (54 projects).
          </p>
          <p className="font-semibold text-amber-700">
            Project 51 is excluded and will not be sent.
          </p>
          <p className="text-xs text-muted-foreground">
            Replaying this exact batch is safe: accepted, scheduled, and completed operations reuse
            their existing retirement receipts.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="project-retirement-confirmation" className="block text-sm font-medium">
            Type{" "}
            <code className="rounded bg-muted px-1 py-0.5">{PROJECT_RETIREMENT_CONFIRMATION}</code>{" "}
            to confirm
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="project-retirement-confirmation"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={submitting}
              className="min-w-72 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void retireAuthorizedProjects()}
              disabled={!confirmed || submitting || retryingProjectIds.size > 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {submitting ? "Submitting exact batch…" : "Retire 54 authorized test projects"}
            </button>
          </div>
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <div>
            <h4 className="text-sm font-semibold">Reconcile one retired project</h4>
            <p className="text-xs text-muted-foreground">
              Load its current retirement receipt first. This does not rerun the 54-project batch.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              id="project-retirement-lookup-id"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              aria-label="Retired project ID"
              value={lookupProjectId}
              onChange={(event) => {
                const previousProjectId = Number(lookupProjectId);
                setLookupProjectId(event.target.value);
                setSingleProjectResult(null);
                setLookupFailure(null);
                if (Number.isSafeInteger(previousProjectId)) {
                  setRetryFailures((current) => {
                    const next = { ...current };
                    delete next[previousProjectId];
                    return next;
                  });
                }
              }}
              disabled={lookupBusy}
              placeholder="Project ID"
              className="w-40 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void lookupRetirementStatus()}
              disabled={lookupBusy || submitting || retryingProjectIds.size > 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {lookupBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {lookupBusy ? "Loading retirement status…" : "Check retirement status"}
            </button>
          </div>

          <div aria-live="polite">
            {lookupFailure && <p className="text-sm text-destructive">{lookupFailure}</p>}
            {singleProjectResult?.kind === "status" && (
              <div
                className="rounded-lg border border-border bg-background p-3"
                data-testid="single-project-retirement-status"
              >
                <p className="text-sm font-semibold">
                  Project {singleProjectResult.status.projectId}
                </p>
                <p className="text-sm">{statusSummary(singleProjectResult.status)}</p>
                <p className="text-xs text-muted-foreground">
                  Attempt count: {singleProjectResult.status.attemptCount}.
                </p>
                {singleProjectResult.status.state === "failed" && (
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <p>{failureEvidenceSummary(singleProjectResult.status.failureCode)}</p>
                    {retirementProgressEvidence(singleProjectResult.status).map((evidence) => (
                      <p key={evidence}>{evidence}</p>
                    ))}
                  </div>
                )}
                {singleProjectResult.status.state === "completed" &&
                  retirementProgressEvidence(singleProjectResult.status).map((evidence) => (
                    <p key={evidence} className="text-xs text-muted-foreground">
                      {evidence}
                    </p>
                  ))}
                {singleProjectResult.status.reconciliationEligible &&
                  governedRetryControl(singleProjectResult.status.projectId)}
              </div>
            )}
            {singleProjectResult?.kind === "accepted" && (
              <div
                className="rounded-lg border border-border bg-background p-3"
                data-testid="single-project-retirement-status"
              >
                <p className="text-sm font-semibold">
                  Project {singleProjectResult.receipt.projectId}
                </p>
                <p className="text-sm">{receiptSummary(singleProjectResult.receipt)}</p>
                <p className="mt-2 break-all text-xs">
                  Status:{" "}
                  <a
                    className="text-primary underline"
                    href={receiptStatusUrl(singleProjectResult.receipt) ?? undefined}
                  >
                    {receiptStatusUrl(singleProjectResult.receipt)}
                  </a>
                </p>
              </div>
            )}
          </div>
        </div>

        <div aria-live="polite" className="space-y-3">
          {failure && <p className="text-sm text-destructive">{failure}</p>}
          {result && (
            <div className="space-y-3" data-testid="project-retirement-result">
              <p className="text-sm font-medium">{batchSummary(result)}</p>
              <ul className="grid gap-2 md:grid-cols-2">
                {result.receipts.map((receipt) => {
                  const statusUrl = receiptStatusUrl(receipt);
                  const canRetryGovernedCleanup =
                    receipt.state === "refused" &&
                    receipt.code === "project_retirement_reconciliation_required";
                  return (
                    <li
                      key={`${receipt.projectId}-${receipt.state}`}
                      className="rounded-lg border border-border bg-background p-3"
                    >
                      <p className="text-sm font-semibold">Project {receipt.projectId}</p>
                      <p className="text-xs text-muted-foreground">{receiptSummary(receipt)}</p>
                      {canRetryGovernedCleanup && governedRetryControl(receipt.projectId)}
                      {statusUrl && (
                        <p className="mt-2 break-all text-xs">
                          Status:{" "}
                          <a className="text-primary underline" href={statusUrl}>
                            {statusUrl}
                          </a>
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
