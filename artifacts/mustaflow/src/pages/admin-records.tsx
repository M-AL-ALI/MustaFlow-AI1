import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";
import {
  ChevronLeft,
  ChevronRight,
  CreditCard,
  FolderKanban,
  Globe,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import { authFetch } from "@/lib/api-fetch";
import { AdminBreadcrumbs } from "@/components/admin/admin-breadcrumbs";

const RECORD_KINDS = ["projects", "published-projects", "credit-accounts", "transactions"] as const;
type RecordKind = (typeof RECORD_KINDS)[number];

type ProjectRecord = {
  recordType: "project";
  id: number;
  name: string;
  ownerLabel: string;
  workspaceId: number;
  status: string;
  kind: string;
  stack: string;
  publishedSnapshotId: number | null;
  publicSlug: string | null;
  updatedAt: string | null;
};

type CreditAccountRecord = {
  recordType: "credit-account";
  accountId: number;
  accountLabel: string;
  balance: number;
  projectCount: number;
  transactionCount: number;
  updatedAt: string | null;
};

type TransactionRecord = {
  recordType: "transaction";
  id: number;
  accountId: number | null;
  accountLabel: string;
  projectId: number | null;
  type: string;
  amount: number;
  description: string | null;
  balanceAfter: number;
  createdAt: string | null;
};

type AdminRecord = ProjectRecord | CreditAccountRecord | TransactionRecord;

type AdminRecordsResponse = {
  kind: RecordKind;
  masking: "account-identities-masked";
  page: { limit: number; offset: number; total: number; hasMore: boolean };
  records: AdminRecord[];
};

const META: Record<RecordKind, { label: string; description: string; icon: typeof FolderKanban }> =
  {
    projects: {
      label: "Project records",
      description: "Filter the platform project estate and open each project record.",
      icon: FolderKanban,
    },
    "published-projects": {
      label: "Published project records",
      description: "See every published project, its serving version, and its public route.",
      icon: Globe,
    },
    "credit-accounts": {
      label: "Accounts with credits",
      description: "Inspect masked account balances and their project and transaction activity.",
      icon: Users,
    },
    transactions: {
      label: "Credit transactions",
      description: "Inspect the bounded credit ledger one transaction at a time.",
      icon: CreditCard,
    },
  };

function isRecordKind(value: string | undefined): value is RecordKind {
  return RECORD_KINDS.includes(value as RecordKind);
}

function isAdminRecordsResponse(value: unknown): value is AdminRecordsResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AdminRecordsResponse>;
  return (
    isRecordKind(candidate.kind) &&
    candidate.masking === "account-identities-masked" &&
    !!candidate.page &&
    Array.isArray(candidate.records)
  );
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Time unavailable" : date.toLocaleString();
}

function readableType(value: string): string {
  return value.replace(/[_-]+/gu, " ");
}

export default function AdminRecordsPage() {
  const [, params] = useRoute<{ kind: string }>("/admin/records/:kind");
  const kind = isRecordKind(params?.kind) ? params.kind : null;
  const [response, setResponse] = useState<AdminRecordsResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const meta = kind ? META[kind] : null;
  const supportsSearch = kind === "projects" || kind === "published-projects";

  const load = useCallback(async () => {
    if (!kind) {
      setLoading(false);
      setError("That Admin record view does not exist.");
      return;
    }
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({ limit: "25", offset: String(offset) });
    if (supportsSearch && search) query.set("q", search);
    try {
      const result = await authFetch(`/api/admin/records/${kind}?${query.toString()}`);
      const body = (await result.json().catch(() => null)) as unknown;
      if (!result.ok || !isAdminRecordsResponse(body)) {
        const visible =
          body && typeof body === "object" && "error" in body
            ? String((body as { error: unknown }).error)
            : "Those Admin records could not be loaded.";
        throw new Error(visible);
      }
      setResponse(body);
    } catch (caught) {
      setResponse(null);
      setError(
        caught instanceof Error ? caught.message : "Those Admin records could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [kind, offset, search, supportsSearch]);

  useEffect(() => {
    void load();
  }, [load]);

  const shownRange = useMemo(() => {
    if (!response || response.records.length === 0) return "No records";
    return `Showing ${response.page.offset + 1}–${response.page.offset + response.records.length} of ${response.page.total}`;
  }, [response]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setOffset(0);
    setSearch(searchDraft.replace(/\s+/gu, " ").trim());
  }

  if (!kind || !meta) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-5">
        <AdminBreadcrumbs
          items={[
            { label: "Projects", href: "/projects" },
            { label: "Admin Page", href: "/admin" },
            { label: "Unknown record view" },
          ]}
        />
        <div className="border border-destructive/40 bg-destructive/5 rounded-xl p-5">
          <h1 className="font-semibold">That Admin record view does not exist.</h1>
          <a href="/admin" className="mt-3 inline-flex text-sm text-primary hover:underline">
            Back to Admin Page
          </a>
        </div>
      </div>
    );
  }

  const Icon = meta.icon;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <AdminBreadcrumbs
        items={[
          { label: "Projects", href: "/projects" },
          { label: "Admin Page", href: "/admin" },
          { label: meta.label },
        ]}
      />

      <header className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Icon className="h-6 w-6 mt-0.5 text-primary" aria-hidden="true" />
          <div>
            <h1 className="text-2xl font-bold">{meta.label}</h1>
            <p className="text-sm text-muted-foreground mt-1">{meta.description}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </header>

      <div className="border border-border rounded-lg bg-muted/30 px-4 py-3 flex gap-2.5 text-sm">
        <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-primary" aria-hidden="true" />
        <p>
          Account masking is active. This view uses stable account labels and never exposes raw
          identity IDs. Unmasking is not available in this phase.
        </p>
      </div>

      {supportsSearch && (
        <form onSubmit={submitSearch} className="flex gap-2" role="search">
          <label className="sr-only" htmlFor="admin-project-search">
            Filter projects by name or project number
          </label>
          <input
            id="admin-project-search"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            maxLength={120}
            placeholder="Filter by project name or number"
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            Filter
          </button>
        </form>
      )}

      {error && (
        <div className="border border-destructive/40 bg-destructive/5 rounded-lg px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!error && loading && !response && (
        <div className="border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          Loading records…
        </div>
      )}

      {response && (
        <>
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{shownRange}</span>
            {search && <span>Filtered by “{search}”</span>}
          </div>
          <div className="space-y-3" data-testid="admin-record-list">
            {response.records.map((record) => (
              <RecordCard
                key={`${record.recordType}-${record.recordType === "credit-account" ? record.accountId : record.id}`}
                record={record}
              />
            ))}
            {response.records.length === 0 && (
              <div className="border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
                No matching records.
              </div>
            )}
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              disabled={response.page.offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, response.page.offset - response.page.limit))}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Previous
            </button>
            <button
              type="button"
              disabled={!response.page.hasMore || loading}
              onClick={() => setOffset(response.page.offset + response.page.limit)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function RecordCard({ record }: { record: AdminRecord }) {
  if (record.recordType === "project") {
    return (
      <details className="group border border-border rounded-xl bg-card">
        <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="font-medium truncate">{record.name}</div>
            <div className="text-xs text-muted-foreground">
              Project {record.id} · {record.status} · {record.ownerLabel}
            </div>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" />
        </summary>
        <div className="border-t border-border px-4 py-4 grid gap-3 text-sm sm:grid-cols-2">
          <Fact label="Workspace" value={String(record.workspaceId)} />
          <Fact label="Stack" value={`${record.kind} · ${record.stack}`} />
          <Fact
            label="Serving version"
            value={
              record.publishedSnapshotId ? `Version ${record.publishedSnapshotId}` : "Not published"
            }
          />
          <Fact label="Last updated" value={formatTimestamp(record.updatedAt)} />
          <div className="sm:col-span-2 flex flex-wrap gap-3 pt-1">
            <a href={`/projects/${record.id}`} className="text-primary font-medium hover:underline">
              Open project
            </a>
            {record.publicSlug && (
              <a
                href={`/api/p/${encodeURIComponent(record.publicSlug)}/`}
                className="text-primary font-medium hover:underline"
              >
                Open public route
              </a>
            )}
          </div>
          <p className="sm:col-span-2 text-xs text-muted-foreground">
            Project workspace access remains consent-gated. Opening this record never grants access.
          </p>
        </div>
      </details>
    );
  }

  if (record.recordType === "credit-account") {
    return (
      <details className="group border border-border rounded-xl bg-card">
        <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between gap-4">
          <div>
            <div className="font-medium">{record.accountLabel}</div>
            <div className="text-xs text-muted-foreground">{record.balance} credits available</div>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" />
        </summary>
        <div className="border-t border-border px-4 py-4 grid gap-3 text-sm sm:grid-cols-2">
          <Fact label="Account record" value={String(record.accountId)} />
          <Fact label="Current balance" value={String(record.balance)} />
          <Fact label="Active projects" value={String(record.projectCount)} />
          <Fact label="Transactions" value={String(record.transactionCount)} />
          <Fact label="Balance updated" value={formatTimestamp(record.updatedAt)} />
        </div>
      </details>
    );
  }

  return (
    <details className="group border border-border rounded-xl bg-card">
      <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between gap-4">
        <div>
          <div className="font-medium">
            Transaction {record.id} · {record.amount > 0 ? "+" : ""}
            {record.amount} credits
          </div>
          <div className="text-xs text-muted-foreground">
            {record.accountLabel} · {readableType(record.type)}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-border px-4 py-4 grid gap-3 text-sm sm:grid-cols-2">
        <Fact label="Type" value={readableType(record.type)} />
        <Fact label="Balance after" value={String(record.balanceAfter)} />
        <Fact label="Recorded" value={formatTimestamp(record.createdAt)} />
        <Fact
          label="Account record"
          value={record.accountId ? String(record.accountId) : "Unavailable"}
        />
        <Fact label="Description" value={record.description || "No description recorded"} />
        <div>
          <div className="text-xs text-muted-foreground">Project</div>
          {record.projectId ? (
            <a
              href={`/projects/${record.projectId}`}
              className="font-medium text-primary hover:underline"
            >
              Open project {record.projectId}
            </a>
          ) : (
            <div className="font-medium">No project linked</div>
          )}
        </div>
      </div>
    </details>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium break-words">{value}</div>
    </div>
  );
}
