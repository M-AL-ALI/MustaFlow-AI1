import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck, Wrench } from "lucide-react";
import {
  getAdminSupportOperations,
  postSupportOperation,
  type SupportOperationsView,
} from "@/lib/support-operations";
import { ProjectPresence } from "@/pages/projects/components/project-presence";

type Feedback = { kind: "ok" | "error"; text: string } | null;

export function SupportOperationConsole({ ticketId }: { ticketId: number }) {
  const [operations, setOperations] = useState<SupportOperationsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [defectTitle, setDefectTitle] = useState("");
  const [fingerprintKey, setFingerprintKey] = useState("");
  const [externalBlocker, setExternalBlocker] = useState("");
  const [externalGuidance, setExternalGuidance] = useState("");
  const [shippedVersion, setShippedVersion] = useState("");
  const [liveTree, setLiveTree] = useState("");
  const [probeRoute, setProbeRoute] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOperations(await getAdminSupportOperations(ticketId));
    } catch (error) {
      setFeedback({
        kind: "error",
        text: error instanceof Error ? error.message : "Support operations could not be loaded.",
      });
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (key: string, path: string, data?: unknown, success = "Support record updated.") => {
      setBusy(key);
      setFeedback(null);
      try {
        const result = await postSupportOperation<Record<string, unknown>>(path, data);
        const impact = result.platformImpact as
          | { affectedAccountCount?: number; linkedTicketCount?: number }
          | undefined;
        setFeedback({
          kind: "ok",
          text: impact
            ? `${success} ${impact.affectedAccountCount ?? 0} account(s), ${impact.linkedTicketCount ?? 0} linked ticket(s).`
            : success,
        });
        await load();
      } catch (error) {
        setFeedback({
          kind: "error",
          text: error instanceof Error ? error.message : "That support action did not complete.",
        });
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const startApprovedSession = useCallback(
    async (session: NonNullable<SupportOperationsView["sessions"]>[number]) => {
      const instruction = session.proposal?.instruction;
      if (typeof instruction !== "string" || !instruction.trim()) {
        setFeedback({ kind: "error", text: "The approved proposal has no project instruction." });
        return;
      }
      setBusy(`start-${session.id}`);
      setFeedback(null);
      try {
        await postSupportOperation(`/api/projects/${session.projectId}/messages`, {
          content: instruction,
          agentMode: "eco",
          planMode: false,
          background: true,
          agentIntent: "mutate",
          origin: `support-session:${session.id}`,
          idempotencyKey: `support-session:${session.id}`,
          supportSessionId: session.id,
        });
        setFeedback({
          kind: "ok",
          text: "Zero started the exact change the project owner approved.",
        });
        await load();
      } catch (error) {
        setFeedback({
          kind: "error",
          text:
            error instanceof Error ? error.message : "The approved Zero session could not start.",
        });
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const prepareZeroProposal = useCallback(async () => {
    setBusy("proposal");
    setFeedback(null);
    try {
      const created = await postSupportOperation<{
        session: NonNullable<SupportOperationsView["sessions"]>[number];
      }>(`/api/admin/support-tickets/${ticketId}/zero/proposals`);
      const instruction = created.session.proposal?.diagnosisInstruction;
      if (typeof instruction !== "string" || !instruction.trim()) {
        throw new Error("The consented support session did not contain its diagnosis instruction.");
      }
      await postSupportOperation(`/api/projects/${created.session.projectId}/messages`, {
        content: instruction,
        agentMode: "eco",
        planMode: true,
        background: false,
        agentIntent: "plan",
        origin: `support-session:${created.session.id}`,
        idempotencyKey: `support-proposal:${created.session.id}`,
        supportSessionId: created.session.id,
      });
      setFeedback({
        kind: "ok",
        text: "Zero prepared a specific read-only proposal for the project owner to review.",
      });
      await load();
    } catch (error) {
      setFeedback({
        kind: "error",
        text: error instanceof Error ? error.message : "Zero could not prepare that proposal.",
      });
      await load();
    } finally {
      setBusy(null);
    }
  }, [load, ticketId]);

  if (loading && !operations) {
    return (
      <div className="flex items-center gap-2 border-t border-border px-5 py-4 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading resolution controls…
      </div>
    );
  }

  const ticket = operations?.ticket;
  const activeGrant = operations?.grants.find((grant) => grant.status === "active");
  const pendingGrant = operations?.grants.find((grant) => grant.status === "pending");

  return (
    <section className="space-y-4 border-t border-border bg-muted/10 px-5 py-4">
      <div>
        <h3 className="text-sm font-semibold">Resolve the actual problem</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose one honest outcome. A ticket cannot be marked resolved without its proof.
        </p>
      </div>

      {feedback && (
        <div
          className={
            feedback.kind === "ok"
              ? "rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600"
              : "rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600"
          }
        >
          {feedback.text}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-border bg-background p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Wrench className="h-4 w-4" /> Project issue
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Zero can propose a change in this project.
          </p>
          <button
            type="button"
            disabled={busy !== null || !ticket?.projectId}
            onClick={() =>
              void act(
                "project",
                `/api/admin/support-tickets/${ticketId}/triage`,
                { resolutionClass: "project" },
                "Classified as a project issue.",
              )
            }
            className="mt-3 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            Classify as project issue
          </button>
        </div>

        <div className="rounded-lg border border-border bg-background p-3">
          <div className="text-sm font-medium">NabuFlow platform issue</div>
          <input
            value={defectTitle}
            onChange={(event) => setDefectTitle(event.target.value)}
            placeholder="Plain defect title"
            className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          />
          <input
            value={fingerprintKey}
            onChange={(event) => setFingerprintKey(event.target.value)}
            placeholder="Stable affected-path signature"
            className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          />
          <button
            type="button"
            disabled={
              busy !== null || defectTitle.trim().length < 8 || fingerprintKey.trim().length < 3
            }
            onClick={() =>
              void act(
                "platform",
                `/api/admin/support-tickets/${ticketId}/triage`,
                {
                  resolutionClass: "platform",
                  defectTitle: defectTitle.trim(),
                  fingerprintKey: fingerprintKey.trim(),
                },
                "Linked to a platform defect.",
              )
            }
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            Package platform defect
          </button>
        </div>

        <div className="rounded-lg border border-border bg-background p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ExternalLink className="h-4 w-4" /> Outside NabuFlow
          </div>
          <input
            value={externalBlocker}
            onChange={(event) => setExternalBlocker(event.target.value)}
            placeholder="Named third party"
            className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          />
          <textarea
            value={externalGuidance}
            onChange={(event) => setExternalGuidance(event.target.value)}
            placeholder="Exact steps the user should take there"
            className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            rows={2}
          />
          <button
            type="button"
            disabled={
              busy !== null ||
              externalBlocker.trim().length < 2 ||
              externalGuidance.trim().length < 8
            }
            onClick={() =>
              void act(
                "external",
                `/api/admin/support-tickets/${ticketId}/triage`,
                {
                  resolutionClass: "external",
                  blocker: externalBlocker.trim(),
                  guidance: externalGuidance.trim(),
                },
                "Marked blocked on a named third party and the user was notified.",
              )
            }
            className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            Mark blocked on third party
          </button>
        </div>
      </div>

      {ticket?.resolutionClass === "project" && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4" /> Consented Zero proposal
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Support can diagnose under a live project grant. Only the owner can approve a change.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {!activeGrant && !pendingGrant && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void act(
                    "grant",
                    `/api/admin/support-tickets/${ticketId}/access-request`,
                    {
                      reason: "Investigate this ticket and prepare a project-level Zero proposal.",
                    },
                    "Access request sent to the project owner.",
                  )
                }
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                Request project access
              </button>
            )}
            {pendingGrant && (
              <span className="text-xs text-amber-600">Waiting for owner consent.</span>
            )}
            {activeGrant && (
              <>
                <ProjectPresence
                  projectId={activeGrant.projectId}
                  location={`Support ticket #${ticketId}`}
                  canRevokeSupport={false}
                />
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void prepareZeroProposal()}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  Ask Zero for a proposal
                </button>
              </>
            )}
            {operations?.sessions.some((session) => session.status === "applied") && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void act(
                    "verify",
                    `/api/admin/support-tickets/${ticketId}/verify-project-resolution`,
                    undefined,
                    "The verified project fix resolved the ticket and notified the user.",
                  )
                }
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                Verify fix and resolve
              </button>
            )}
          </div>
        </div>
      )}

      {operations && operations.defects.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border bg-background p-3">
          <div className="text-sm font-medium">Linked platform defect</div>
          {operations.defects.map((defect) => (
            <div key={defect.id} className="space-y-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span>#{defect.id}</span>
                <span className="font-medium">{defect.title}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 capitalize">
                  {defect.status}
                </span>
                {defect.status !== "shipped" && defect.status !== "verified" && (
                  <>
                    <input
                      value={shippedVersion}
                      onChange={(event) => setShippedVersion(event.target.value)}
                      placeholder="Shipped version"
                      className="rounded-md border border-border bg-background px-2 py-1"
                    />
                    <input
                      value={liveTree}
                      onChange={(event) => setLiveTree(event.target.value.toLowerCase())}
                      placeholder="Live 40-character tree identity"
                      className="rounded-md border border-border bg-background px-2 py-1"
                    />
                    <input
                      value={probeRoute}
                      onChange={(event) => setProbeRoute(event.target.value)}
                      placeholder="Verified live route"
                      className="rounded-md border border-border bg-background px-2 py-1"
                    />
                    <button
                      type="button"
                      disabled={
                        busy !== null ||
                        shippedVersion.trim().length < 7 ||
                        !/^[0-9a-f]{40}$/u.test(liveTree.trim()) ||
                        !probeRoute.trim()
                      }
                      onClick={() =>
                        void act(
                          `ship-${defect.id}`,
                          `/api/admin/support-defects/${defect.id}/verify`,
                          {
                            shippedVersion: shippedVersion.trim(),
                            liveTree: liveTree.trim(),
                            probe: {
                              route: probeRoute.trim(),
                            },
                          },
                          "The live fix was proven; all linked tickets resolved together and their users were notified.",
                        )
                      }
                      className="rounded-md bg-emerald-600 px-2.5 py-1 text-white disabled:opacity-50"
                    >
                      Verify shipped fix
                    </button>
                  </>
                )}
              </div>
              {(() => {
                const impact = operations.defectImpact?.find((row) => row.defectId === defect.id);
                if (!impact) return null;
                return (
                  <p className="text-muted-foreground" data-testid={`defect-impact-${defect.id}`}>
                    {impact.affectedAccountCount} affected account(s) across{" "}
                    {impact.linkedTicketCount} linked ticket(s):{" "}
                    {impact.affectedAccounts.join(", ") || "none yet"}.
                  </p>
                );
              })()}
            </div>
          ))}
        </div>
      )}

      {operations && operations.sessions.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Zero proposal receipts
          </div>
          {operations.sessions.map((session) => (
            <div
              key={session.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
            >
              <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
              <span>Session #{session.id}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 capitalize">
                {session.status.replace("_", " ")}
              </span>
              {session.appliedVersionId && <span>Version {session.appliedVersionId}</span>}
              {session.status === "approved" && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void startApprovedSession(session)}
                  className="ml-auto rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground disabled:opacity-50"
                >
                  Start approved change
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
