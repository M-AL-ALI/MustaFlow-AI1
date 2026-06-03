import { authFetch } from "@/lib/api-fetch";
import { useState, useEffect, useCallback } from "react";
import {
  ShieldCheck,
  ChevronLeft,
  RefreshCw,
  UserCheck,
  UserMinus,
  Globe,
  CheckCircle,
  XCircle,
  PlusCircle,
  Trash2,
  Link2,
} from "lucide-react";
import { Link, useRoute } from "wouter";
import { useToast } from "@/hooks/use-toast";

interface AuditEntry {
  id: number;
  workspaceDomainId: number | null;
  userId: string;
  action: string;
  hostname: string | null;
  payload: unknown;
  createdAt: string;
}

interface AuditResponse {
  audit: AuditEntry[];
  limit: number;
  offset: number;
}

const ACTION_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  domain_claimed: {
    label: "Domain claimed",
    icon: <PlusCircle size={14} />,
    color: "text-blue-400",
  },
  domain_released: {
    label: "Domain released",
    icon: <Trash2 size={14} />,
    color: "text-red-400",
  },
  domain_verified: {
    label: "Domain verified",
    icon: <CheckCircle size={14} />,
    color: "text-emerald-400",
  },
  domain_failed: {
    label: "Verification failed",
    icon: <XCircle size={14} />,
    color: "text-amber-400",
  },
  role_granted: {
    label: "Role granted",
    icon: <UserCheck size={14} />,
    color: "text-indigo-400",
  },
  role_revoked: {
    label: "Role revoked",
    icon: <UserMinus size={14} />,
    color: "text-rose-400",
  },
  sub_hostname_claimed: {
    label: "Sub-hostname claimed",
    icon: <Link2 size={14} />,
    color: "text-teal-400",
  },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function maskUserId(uid: string): string {
  if (uid.length <= 8) return uid;
  return `${uid.slice(0, 4)}…${uid.slice(-4)}`;
}

export default function WorkspaceAuditPage() {
  const [, params] = useRoute("/workspaces/:id/audit");
  const workspaceId = params?.id;
  const { toast } = useToast();

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;

  const fetchAudit = useCallback(
    async (o: number) => {
      if (!workspaceId) return;
      setLoading(true);
      try {
        const res = await authFetch(
          `/api/workspaces/${workspaceId}/audit?limit=${LIMIT}&offset=${o}`,
        );
        if (!res.ok) throw new Error(await res.text());
        const data: AuditResponse = await res.json();
        setEntries((prev) => (o === 0 ? data.audit : [...prev, ...data.audit]));
        setOffset(o + data.audit.length);
      } catch (err) {
        toast({
          title: "Failed to load audit log",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, toast],
  );

  useEffect(() => {
    void fetchAudit(0);
  }, [fetchAudit]);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <Link
            href={`/workspaces/${workspaceId}`}
            className="flex items-center gap-1 text-sm text-neutral-400 hover:text-white transition-colors"
          >
            <ChevronLeft size={16} />
            Workspace
          </Link>
          <span className="text-neutral-700">/</span>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ShieldCheck size={20} className="text-emerald-400" />
            Domain Audit Log
          </h1>
          <button
            onClick={() => void fetchAudit(0)}
            disabled={loading}
            className="ml-auto flex items-center gap-1.5 px-3 py-2 text-sm bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        {/* Log entries */}
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-neutral-500">
            <RefreshCw size={20} className="animate-spin mr-2" /> Loading audit log…
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-16 text-neutral-500 text-sm">
            No domain activity recorded yet.
          </div>
        ) : (
          <div className="space-y-1">
            {entries.map((entry) => {
              const meta = ACTION_META[entry.action] ?? {
                label: entry.action.replace(/_/g, " "),
                icon: <Globe size={14} />,
                color: "text-neutral-400",
              };

              return (
                <div
                  key={entry.id}
                  className="flex items-start gap-4 px-4 py-3 rounded-lg hover:bg-neutral-900/60 transition-colors"
                >
                  {/* Icon */}
                  <div className={`mt-0.5 shrink-0 ${meta.color}`}>{meta.icon}</div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-sm font-medium ${meta.color}`}>{meta.label}</span>
                      {entry.hostname && (
                        <span className="text-xs font-mono bg-neutral-800 text-neutral-300 px-1.5 py-0.5 rounded">
                          {entry.hostname}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-neutral-500 mt-0.5 flex items-center gap-2 flex-wrap">
                      <span title={entry.userId}>by {maskUserId(entry.userId)}</span>
                      {entry.payload &&
                      typeof entry.payload === "object" &&
                      entry.payload !== null &&
                      "targetUserId" in entry.payload ? (
                        <span>
                          →{" "}
                          {maskUserId(
                            String((entry.payload as Record<string, unknown>).targetUserId),
                          )}{" "}
                          {"role" in entry.payload ? (
                            <span className="font-semibold">
                              ({String((entry.payload as Record<string, unknown>).role)})
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {/* Timestamp */}
                  <div className="shrink-0 text-xs text-neutral-600">
                    {formatDate(entry.createdAt)}
                  </div>
                </div>
              );
            })}

            {/* Load more */}
            {entries.length >= LIMIT && (
              <div className="pt-4 text-center">
                <button
                  onClick={() => void fetchAudit(offset)}
                  disabled={loading}
                  className="px-4 py-2 text-sm bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded-lg transition-colors disabled:opacity-50"
                >
                  {loading ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
