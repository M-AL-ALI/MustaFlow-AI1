import { useCallback, useEffect, useState } from "react";
import { Clock3, Loader2, MailCheck, ShieldCheck } from "lucide-react";
import {
  getOwnerSupportOperations,
  postSupportOperation,
  presentSupportEmailStatus,
  type SupportGrantEventView,
  type SupportOperationsView,
} from "@/lib/support-operations";

function receiptDetailLines(event: SupportGrantEventView): string[] {
  const detail = event.detail;
  const lines: string[] = [];
  if (typeof detail.reason === "string" && detail.reason.trim()) {
    lines.push(`Reason: ${detail.reason.trim()}`);
  }
  if (typeof detail.expiresAt === "string" && !Number.isNaN(Date.parse(detail.expiresAt))) {
    lines.push(`Access ends: ${new Date(detail.expiresAt).toLocaleString()}`);
  }
  for (const [field, label] of [
    ["supportSessionId", "Support session"],
    ["taskId", "Zero task"],
    ["versionId", "Project version"],
  ] as const) {
    const value = detail[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
      lines.push(`${label} #${value}`);
    }
  }
  return lines;
}

export function SupportOwnerActions({
  ticketId,
  onMutated,
}: {
  ticketId: number;
  onMutated: () => void | Promise<unknown>;
}) {
  const [operations, setOperations] = useState<SupportOperationsView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOperations(await getOwnerSupportOperations(ticketId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Support details could not be loaded.");
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (key: string, path: string, data?: unknown) => {
      setBusy(key);
      setMessage(null);
      try {
        await postSupportOperation(path, data);
        await load();
        await onMutated();
        setMessage("Your decision was recorded.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "That decision did not complete.");
      } finally {
        setBusy(null);
      }
    },
    [load, onMutated],
  );

  if (!operations) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading consent and resolution details…
      </div>
    );
  }

  const pendingGrants = operations.grants.filter((grant) => grant.status === "pending");
  const activeGrants = operations.grants.filter((grant) => grant.status === "active");
  const proposals = operations.sessions.filter((session) => session.status === "proposal_ready");
  const evidence = operations.ticket.resolutionEvidence ?? {};
  const guidance = typeof evidence.guidance === "string" ? evidence.guidance : null;

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Consent and resolution</h3>
      </div>

      {operations.ticket.resolutionClass && (
        <p className="text-sm">
          This is classified as a <strong>{operations.ticket.resolutionClass} issue</strong>.
          {operations.ticket.thirdPartyBlocker
            ? ` It is waiting on ${operations.ticket.thirdPartyBlocker}.`
            : ""}
        </p>
      )}
      {guidance && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{guidance}</p>}

      {operations.deliveries.length > 0 && (
        <details className="rounded-md border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            How support contacted you
          </summary>
          <ol className="mt-2 space-y-2">
            {operations.deliveries.map((delivery) => (
              <li
                key={delivery.id}
                className="flex items-start gap-2 text-xs text-muted-foreground"
              >
                <MailCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  In-product notification recorded ·{" "}
                  {presentSupportEmailStatus(delivery.emailStatus)}
                  {delivery.emailFailureReason ? ` — ${delivery.emailFailureReason}` : ""} ·{" "}
                  {new Date(delivery.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {pendingGrants.map((grant) => (
        <div key={grant.id} className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="text-sm font-medium">NabuFlow Support is requesting project access</div>
          <p className="mt-1 text-xs text-muted-foreground">{grant.reason}</p>
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Clock3 className="h-3 w-3" /> You can grant one hour and revoke it instantly.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void act("grant", `/api/support/access-requests/${grant.id}/decision`, {
                  decision: "grant",
                  durationMinutes: 60,
                })
              }
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              Grant one hour
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void act("decline-grant", `/api/support/access-requests/${grant.id}/decision`, {
                  decision: "decline",
                })
              }
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        </div>
      ))}

      {activeGrants.map((grant) => (
        <div
          key={grant.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3"
        >
          <div>
            <div className="text-sm font-medium">Support access is active</div>
            <p className="text-xs text-muted-foreground">
              Ends {grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : "soon"}
            </p>
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void act("revoke", `/api/support/access-grants/${grant.id}/revoke`)}
            className="rounded-md border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50"
          >
            Revoke access now
          </button>
        </div>
      ))}

      {operations.grants.map((grant) => {
        const events = operations.grantEvents.filter((event) => event.grantId === grant.id);
        if (events.length === 0) return null;
        return (
          <details key={`receipt-${grant.id}`} className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Full support access receipt #{grant.id}
            </summary>
            <ol className="mt-2 space-y-2">
              {events.map((event) => {
                const details = receiptDetailLines(event);
                return (
                  <li key={event.id} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {event.actorDisplayName || "Account owner"}
                    </span>{" "}
                    · {event.event.replaceAll("_", " ")} ·{" "}
                    {new Date(event.createdAt).toLocaleString()}
                    {details.length > 0 && <div className="mt-1">{details.join(" · ")}</div>}
                  </li>
                );
              })}
            </ol>
          </details>
        );
      })}

      {proposals.map((session) => {
        const summary =
          typeof session.proposal.summary === "string"
            ? session.proposal.summary
            : "Zero prepared a project change for your review.";
        return (
          <div key={session.id} className="rounded-md border border-primary/30 bg-primary/5 p-3">
            <div className="text-sm font-medium">Your approval is required</div>
            <p className="mt-1 text-sm text-muted-foreground">{summary}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing changes until you approve. Declining records your choice and will not retry.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void act("approve", `/api/support/zero-sessions/${session.id}/decision`, {
                    decision: "approve",
                  })
                }
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                Approve proposed change
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void act("decline", `/api/support/zero-sessions/${session.id}/decision`, {
                    decision: "decline",
                  })
                }
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                Decline change
              </button>
            </div>
          </div>
        );
      })}

      {operations.ticket.resolutionClass === "external" &&
        operations.ticket.status === "blocked_on_third_party" && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void act(
                "external-resolved",
                `/api/support/tickets/${ticketId}/confirm-external-resolved`,
              )
            }
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            I fixed it with the third party
          </button>
        )}

      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </section>
  );
}
