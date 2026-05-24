/**
 * Task #542 — Integrations marketplace tab.
 *
 * Lists first-party integration blueprints from `GET /api/blueprints`, shows
 * what's already installed on this project, and lets the user one-click
 * install a blueprint via `POST /api/projects/:id/blueprints/install`.
 *
 * No emojis — lucide-react icons only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ShieldCheck,
  CreditCard,
  Database,
  HardDrive,
  Cpu,
  Plug,
  CheckCircle2,
  Loader2,
  ExternalLink,
  Trash2,
  Package,
  Key,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Category = "auth" | "payments" | "database" | "storage" | "ai" | "mcp" | "other";

interface BlueprintListItem {
  id: string;
  name: string;
  category: Category;
  description: string;
  version: string;
  url?: string;
  mobileOnly?: boolean;
  webOnly?: boolean;
  requiredSecrets: string[];
  packageCount: number;
  fileCount: number;
}

interface InstalledRow {
  id: number;
  projectId: number;
  blueprintId: string;
  version: string;
  installedAt: string;
}

const CATEGORY_META: Record<Category, { label: string; icon: typeof ShieldCheck; tint: string }> = {
  auth: { label: "Authentication", icon: ShieldCheck, tint: "text-emerald-400" },
  payments: { label: "Payments", icon: CreditCard, tint: "text-amber-400" },
  database: { label: "Database", icon: Database, tint: "text-sky-400" },
  storage: { label: "Storage", icon: HardDrive, tint: "text-fuchsia-400" },
  ai: { label: "AI", icon: Cpu, tint: "text-violet-400" },
  mcp: { label: "MCP Server", icon: Plug, tint: "text-cyan-400" },
  other: { label: "Other", icon: Plug, tint: "text-muted-foreground" },
};

const CATEGORY_ORDER: Category[] = [
  "auth",
  "payments",
  "database",
  "storage",
  "ai",
  "mcp",
  "other",
];

export default function IntegrationsTab({ projectId }: { projectId: number }) {
  const [catalog, setCatalog] = useState<BlueprintListItem[]>([]);
  const [installed, setInstalled] = useState<InstalledRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<Category | "all">("all");

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [bpRes, instRes] = await Promise.all([
        fetch("/api/blueprints", { credentials: "include" }),
        fetch(`/api/projects/${projectId}/blueprints`, { credentials: "include" }),
      ]);
      if (!bpRes.ok) throw new Error(`catalog: HTTP ${bpRes.status}`);
      if (!instRes.ok) throw new Error(`installed: HTTP ${instRes.status}`);
      setCatalog((await bpRes.json()) as BlueprintListItem[]);
      setInstalled((await instRes.json()) as InstalledRow[]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installedIds = new Set(installed.map((r) => r.blueprintId));

  const handleInstall = useCallback(
    async (bp: BlueprintListItem) => {
      setInstalling(bp.id);
      setError(null);
      setLastResult(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/blueprints/install`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: bp.id }),
        });
        const body = (await res.json()) as {
          installed?: boolean;
          error?: string;
          filesWritten?: string[];
          filesSkipped?: string[];
        };
        if (!res.ok || !body.installed) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const fw = body.filesWritten?.length ?? 0;
        const fs = body.filesSkipped?.length ?? 0;
        setLastResult(
          `Installed ${bp.name} — ${fw} file${fw === 1 ? "" : "s"} written` +
            (fs > 0 ? `, ${fs} skipped (already existed)` : "") +
            (bp.requiredSecrets.length > 0
              ? `. Add required secrets in Tools & Files → Secrets: ${bp.requiredSecrets.join(", ")}.`
              : "."),
        );
        await refresh();
      } catch (err) {
        setError(`Install failed: ${(err as Error).message}`);
      } finally {
        setInstalling(null);
      }
    },
    [projectId, refresh],
  );

  const handleUninstall = useCallback(
    async (bpId: string) => {
      setError(null);
      try {
        const res = await fetch(`/api/projects/${projectId}/blueprints/${bpId}`, {
          method: "DELETE",
          credentials: "include",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await refresh();
      } catch (err) {
        setError(`Uninstall failed: ${(err as Error).message}`);
      }
    },
    [projectId, refresh],
  );

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((bp) => {
      if (filterCategory !== "all" && bp.category !== filterCategory) return false;
      if (!q) return true;
      return (
        bp.name.toLowerCase().includes(q) ||
        bp.description.toLowerCase().includes(q) ||
        bp.id.toLowerCase().includes(q) ||
        bp.requiredSecrets.some((s) => s.toLowerCase().includes(q))
      );
    });
  }, [catalog, search, filterCategory]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading integrations…
      </div>
    );
  }

  const grouped: Record<Category, BlueprintListItem[]> = {
    auth: [],
    payments: [],
    database: [],
    storage: [],
    ai: [],
    mcp: [],
    other: [],
  };
  for (const bp of filteredCatalog) grouped[bp.category]?.push(bp);

  return (
    <div className="flex flex-col gap-6 p-6 overflow-auto h-full">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Plug className="h-4 w-4 text-cyan-400" /> Integrations Marketplace
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          One-click scaffolds for auth, payments, databases, storage, and AI. Each blueprint writes
          the necessary files into your project and lists the secrets you need to add.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search blueprints by name, description, or required secret…"
            className="w-full pl-9 pr-9 py-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-cyan-500"
            aria-label="Search integrations"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setFilterCategory("all")}
            className={cn(
              "px-2.5 py-1 text-xs rounded-md border",
              filterCategory === "all"
                ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-300"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            All
          </button>
          {CATEGORY_ORDER.filter((c) => c !== "other").map((cat) => {
            const meta = CATEGORY_META[cat];
            const Icon = meta.icon;
            const active = filterCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setFilterCategory(cat)}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-md border flex items-center gap-1.5",
                  active
                    ? "border-cyan-500/50 bg-cyan-500/10 text-cyan-300"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className={cn("h-3 w-3", active ? "" : meta.tint)} />
                {meta.label}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 text-red-300 text-xs p-3">
          {error}
        </div>
      )}
      {filteredCatalog.length === 0 && (
        <div className="rounded-md border border-border bg-muted/20 text-xs text-muted-foreground p-4 text-center">
          No blueprints match your search.
        </div>
      )}
      {lastResult && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs p-3 flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{lastResult}</span>
        </div>
      )}

      {CATEGORY_ORDER.map((cat) => {
        const items = grouped[cat];
        if (items.length === 0) return null;
        const meta = CATEGORY_META[cat];
        const Icon = meta.icon;
        return (
          <section key={cat} className="space-y-3">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
              <Icon className={cn("h-3.5 w-3.5", meta.tint)} />
              {meta.label}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {items.map((bp) => {
                const isInstalled = installedIds.has(bp.id);
                const isBusy = installing === bp.id;
                return (
                  <div
                    key={bp.id}
                    className="rounded-lg border border-border bg-card/50 p-4 flex flex-col gap-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm truncate">{bp.name}</span>
                          {isInstalled && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 inline-flex items-center gap-1">
                              <CheckCircle2 className="h-2.5 w-2.5" /> Installed
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-3">
                          {bp.description}
                        </p>
                      </div>
                      {bp.url && (
                        <a
                          href={bp.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-muted-foreground hover:text-foreground shrink-0"
                          title="Documentation"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/50">
                        <Package className="h-2.5 w-2.5" />
                        {bp.fileCount} file{bp.fileCount === 1 ? "" : "s"}
                      </span>
                      {bp.packageCount > 0 && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/50">
                          <Package className="h-2.5 w-2.5" />
                          {bp.packageCount} package{bp.packageCount === 1 ? "" : "s"}
                        </span>
                      )}
                      {bp.requiredSecrets.length > 0 && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted/50">
                          <Key className="h-2.5 w-2.5" />
                          {bp.requiredSecrets.length} secret
                          {bp.requiredSecrets.length === 1 ? "" : "s"}
                        </span>
                      )}
                      <span className="px-1.5 py-0.5 rounded bg-muted/50">v{bp.version}</span>
                    </div>

                    {bp.requiredSecrets.length > 0 && (
                      <div className="text-[10px] text-muted-foreground">
                        <span className="font-medium">Requires:</span>{" "}
                        <code className="text-[10px]">{bp.requiredSecrets.join(", ")}</code>
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-2 pt-1">
                      {isInstalled ? (
                        <>
                          <button
                            onClick={() => handleUninstall(bp.id)}
                            className="text-xs text-muted-foreground hover:text-red-400 inline-flex items-center gap-1 px-2 py-1 rounded border border-border"
                          >
                            <Trash2 className="h-3 w-3" /> Remove
                          </button>
                          <button
                            disabled={isBusy}
                            onClick={() => handleInstall(bp)}
                            className="text-xs text-foreground inline-flex items-center gap-1 px-2.5 py-1 rounded bg-muted hover:bg-muted/70 disabled:opacity-50"
                          >
                            {isBusy ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Package className="h-3 w-3" />
                            )}
                            Reinstall
                          </button>
                        </>
                      ) : (
                        <button
                          disabled={isBusy}
                          onClick={() => handleInstall(bp)}
                          className="text-xs font-medium text-emerald-300 inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 disabled:opacity-50"
                        >
                          {isBusy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Plug className="h-3 w-3" />
                          )}
                          Install
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {catalog.length === 0 && (
        <div className="text-sm text-muted-foreground p-6 text-center">
          No integration blueprints available.
        </div>
      )}
    </div>
  );
}
