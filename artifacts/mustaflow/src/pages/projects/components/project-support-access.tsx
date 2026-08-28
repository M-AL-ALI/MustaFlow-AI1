import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock3, ShieldCheck, X } from "lucide-react";
import { authFetch } from "@/lib/api-fetch";

type Grant = {
  id: number;
  staffUserId: string;
  reason: string;
  status: string;
  requestedAt: string;
  expiresAt?: string | null;
};

type AccessHistory = {
  grants: Grant[];
  events: Array<{
    id: number;
    grantId: number;
    actorDisplayName?: string | null;
    event: string;
    createdAt: string;
  }>;
  staffProfiles: Record<
    string,
    { displayName?: string | null; imageUrl?: string | null } | undefined
  >;
};

async function readJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  const response = await authFetch(url, {
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (response.status === 404) return null;
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? "Support access could not be loaded.");
  return body;
}

export function ProjectSupportAccess({ projectId }: { projectId: number }) {
  const [history, setHistory] = useState<AccessHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setHistory(
        await readJson<AccessHistory>(`/api/support/projects/${projectId}/access-history`),
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Support access could not be loaded.");
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const pending = history?.grants.find((grant) => grant.status === "pending");
  const active = history?.grants.find((grant) => grant.status === "active");
  const recent = useMemo(() => history?.events.slice(0, 3) ?? [], [history]);
  if (!history && !error) return null;
  if (!pending && !active && recent.length === 0 && !error) return null;

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      await readJson(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That support decision did not complete.");
    } finally {
      setBusy(false);
    }
  };

  const grant = pending ?? active;
  const profile = grant ? history?.staffProfiles[grant.staffUserId] : undefined;

  return (
    <section
      className="shrink-0 border-b border-primary/20 bg-primary/5 px-4 py-2.5"
      aria-label="Support access"
    >
      <div className="flex flex-wrap items-center gap-3">
        {profile?.imageUrl ? (
          <img
            src={profile.imageUrl}
            alt=""
            className="h-8 w-8 rounded-full border border-primary/30"
          />
        ) : (
          <ShieldCheck className="h-5 w-5 text-primary" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">
            {pending
              ? `${profile?.displayName ?? "NabuFlow Support"} is requesting temporary access`
              : active
                ? `${profile?.displayName ?? "NabuFlow Support"} has temporary access`
                : "Recent support access"}
          </p>
          {grant && <p className="truncate text-xs text-muted-foreground">{grant.reason}</p>}
          {grant?.expiresAt && (
            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              <Clock3 className="h-3 w-3" />
              {pending ? "Request expires" : "Access ends"}{" "}
              {new Date(grant.expiresAt).toLocaleString()}
            </p>
          )}
        </div>
        {pending && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act(`/api/support/access-requests/${pending.id}/decision`, {
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
              disabled={busy}
              onClick={() =>
                void act(`/api/support/access-requests/${pending.id}/decision`, {
                  decision: "decline",
                })
              }
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              Refuse
            </button>
          </div>
        )}
        {active && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(`/api/support/access-grants/${active.id}/revoke`)}
            className="inline-flex items-center gap-1 rounded-md border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-600 disabled:opacity-50"
          >
            <X className="h-3 w-3" /> Revoke now
          </button>
        )}
      </div>
      {!grant && recent.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {recent[0]!.actorDisplayName ?? "Account owner"} · {recent[0]!.event.replaceAll("_", " ")}{" "}
          · {new Date(recent[0]!.createdAt).toLocaleString()}
        </p>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </section>
  );
}
