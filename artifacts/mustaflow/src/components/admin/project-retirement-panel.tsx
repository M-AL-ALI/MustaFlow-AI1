import { useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { authFetch } from "@/lib/api-fetch";

export const AUTHORIZED_PROJECT_RETIREMENT_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 52,
  53, 54, 55,
] as const;

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

const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  project_retirement_legacy_runtime_requires_migration:
    "This project uses an older runtime that cannot be retired safely yet.",
  project_retirement_managed_addon_unverified:
    "This project has an add-on whose safe removal cannot be verified yet.",
  project_retirement_remote_build_in_progress:
    "This project has a mobile build in progress. Wait for it to finish before moving the project to Trash.",
  project_retirement_provider_provisioning_in_progress:
    "This project is still setting up its runtime or database. Wait for setup to finish before moving it to Trash.",
  project_retirement_sqlite_recovery_unverified:
    "This project's database cannot be preserved and restored safely yet.",
  project_retirement_receipt_upgrade_in_progress:
    "This project's earlier Trash cleanup is still running and must finish before its safety receipt can be upgraded.",
  project_retirement_reconciliation_required:
    "This project's Trash cleanup did not finish safely. Retry its governed cleanup before continuing.",
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
    (receipt.state === "not_found" ||
      receipt.state === "refused" ||
      receipt.state === "accepted" ||
      receipt.state === "completed")
  );
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
  return receipt.statusUrl ?? `/api/projects/${receipt.projectId}/retirement`;
}

export function ProjectRetirementPanel() {
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RetirementBatchResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const submissionLock = useRef(false);
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
              disabled={!confirmed || submitting}
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

        <div aria-live="polite" className="space-y-3">
          {failure && <p className="text-sm text-destructive">{failure}</p>}
          {result && (
            <div className="space-y-3" data-testid="project-retirement-result">
              <p className="text-sm font-medium">{batchSummary(result)}</p>
              <ul className="grid gap-2 md:grid-cols-2">
                {result.receipts.map((receipt) => {
                  const statusUrl = receiptStatusUrl(receipt);
                  return (
                    <li
                      key={`${receipt.projectId}-${receipt.state}`}
                      className="rounded-lg border border-border bg-background p-3"
                    >
                      <p className="text-sm font-semibold">Project {receipt.projectId}</p>
                      <p className="text-xs text-muted-foreground">{receiptSummary(receipt)}</p>
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
