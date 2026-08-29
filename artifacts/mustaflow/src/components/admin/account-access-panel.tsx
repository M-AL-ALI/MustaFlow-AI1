import { useState } from "react";
import { Loader2, Search, ShieldBan, ShieldCheck } from "lucide-react";
import {
  ApiError,
  getLookupAdminAccountQueryKey,
  useLookupAdminAccount,
  useRestoreAdminAccount,
  useSuspendAdminAccount,
  type AdminAccountAccess,
} from "@workspace/api-client-react";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const data = error.data as { error?: unknown } | null;
    return typeof data?.error === "string" ? data.error : fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

export function AdminAccountAccessPanel({ actorUserId }: { actorUserId: string }) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [account, setAccount] = useState<AdminAccountAccess | null>(null);
  const [busy, setBusy] = useState<"lookup" | "change" | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const lookupQuery = useLookupAdminAccount(
    { email: email.trim() },
    {
      query: {
        queryKey: getLookupAdminAccountQueryKey({ email: email.trim() }),
        enabled: false,
        retry: false,
      },
    },
  );
  const suspendMutation = useSuspendAdminAccount();
  const restoreMutation = useRestoreAdminAccount();

  async function lookup() {
    setBusy("lookup");
    setFeedback(null);
    setAccount(null);
    try {
      const result = await lookupQuery.refetch({ throwOnError: true });
      if (!result.data?.account) throw new Error("Account access is temporarily unavailable.");
      setAccount(result.data.account);
    } catch (error) {
      setFeedback({
        kind: "error",
        text: errorMessage(error, "Account access is temporarily unavailable."),
      });
    } finally {
      setBusy(null);
    }
  }

  async function changeAccess(banned: boolean) {
    if (!account) return;
    const verb = banned ? "Suspend" : "Restore";
    if (!window.confirm(`${verb} NabuFlow access for ${account.email ?? account.userId}?`)) return;
    setBusy("change");
    setFeedback(null);
    try {
      const body = await (banned ? suspendMutation : restoreMutation).mutateAsync({
        userId: account.userId,
        data: { reason: reason.trim() },
      });
      setAccount(body.account);
      setReason("");
      setFeedback({
        kind: "ok",
        text: banned
          ? "Account access is suspended and existing sessions are no longer trusted."
          : "Account access is restored.",
      });
    } catch (error) {
      setFeedback({
        kind: "error",
        text: errorMessage(error, "Account access could not be changed."),
      });
    } finally {
      setBusy(null);
    }
  }

  const cannotSuspend = account?.userId === actorUserId || account?.staffRole === "owner";

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border bg-muted/40 px-4 py-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <ShieldBan className="h-3.5 w-3.5" /> Account access
        </h3>
      </div>
      <div className="space-y-4 p-4">
        <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          <p>
            <strong className="text-foreground">Purpose:</strong> Stop a violating account from
            signing in without deleting its data.
          </p>
          <p>
            <strong className="text-foreground">Operator action:</strong> Find one account, record a
            reason, then suspend or restore it.
          </p>
          <p>
            <strong className="text-foreground">Freshness:</strong> Every lookup reads Clerk, the
            shared identity authority, directly.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <input
            type="email"
            aria-label="Account email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Account email"
            className="min-w-64 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void lookup()}
            disabled={busy !== null || !email.trim()}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy === "lookup" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            Find account
          </button>
        </div>

        {account && (
          <div
            className="space-y-3 rounded-lg border border-border bg-background p-3"
            data-testid="admin-account-access-result"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">{account.displayName ?? "Unnamed account"}</p>
                <p className="text-xs text-muted-foreground">{account.email ?? "No email"}</p>
                <code className="text-[11px] text-muted-foreground">{account.userId}</code>
              </div>
              <span
                className={
                  account.banned
                    ? "rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-600"
                    : "rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600"
                }
              >
                {account.banned ? "Suspended" : account.locked ? "Temporarily locked" : "Active"}
              </span>
            </div>
            {account.staffRole && (
              <p className="text-xs text-amber-700">
                Staff role: {account.staffRole}. Staff access is a separate grant; revoke that role
                in the Staff allowlist when access should not return after restoration.
              </p>
            )}
            <textarea
              aria-label="Account access reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Required audit reason (8–500 characters)"
              rows={2}
              maxLength={500}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              {account.banned ? (
                <button
                  type="button"
                  onClick={() => void changeAccess(false)}
                  disabled={busy !== null || reason.trim().length < 8}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  <ShieldCheck className="h-4 w-4" /> Restore access
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void changeAccess(true)}
                  disabled={busy !== null || reason.trim().length < 8 || cannotSuspend}
                  className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-50"
                >
                  <ShieldBan className="h-4 w-4" /> Suspend access
                </button>
              )}
              {cannotSuspend && !account.banned && (
                <p className="self-center text-xs text-muted-foreground">
                  {account.userId === actorUserId
                    ? "You cannot suspend your own account."
                    : "Owner accounts must transfer or remove the Owner role first."}
                </p>
              )}
            </div>
          </div>
        )}

        {feedback && (
          <p
            className={
              feedback.kind === "ok" ? "text-sm text-emerald-600" : "text-sm text-destructive"
            }
          >
            {feedback.text}
          </p>
        )}
      </div>
    </section>
  );
}
