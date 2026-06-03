/**
 * Task #542 — Integrations marketplace tab.
 * Task #786 — Webhooks section, MCP config UI, platform notices.
 *
 * Lists first-party integration blueprints from `GET /api/blueprints`, shows
 * what's already installed on this project, and lets the user one-click
 * install a blueprint via `POST /api/projects/:id/blueprints/install`.
 *
 * Also surfaces:
 * - Webhooks: list, create, delete, fire test — wired to /api/projects/:id/webhooks
 * - MCP Servers: admins can add/refresh/disable global MCP servers; non-admins
 *   see an info state explaining the feature
 *
 * No emojis — lucide-react icons only.
 */
import { authFetch } from "@/lib/api-fetch";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Webhook,
  Plus,
  Server,
  AlertCircle,
  Info,
  RefreshCw,
  MessageSquare,
  Zap,
  Lock,
  BadgeCheck,
  Blocks,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useListSecrets } from "@workspace/api-client-react";
import { IntegrationsRegistry } from "./integrations-registry";

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

interface BlueprintSecretSpec {
  name: string;
  category?: string;
  helpUrl?: string;
  reason?: string;
  optional?: boolean;
}

interface ExistingSecretEntry {
  name: string;
  masked: string;
}

interface PostInstallDialogState {
  blueprintName: string;
  blueprintUrl?: string;
  secretSpecs: BlueprintSecretSpec[];
  existingSecrets: ExistingSecretEntry[];
}

interface InstalledRow {
  id: number;
  projectId: number;
  blueprintId: string;
  version: string;
  installedAt: string;
}

interface WebhookRow {
  id: number;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  description?: string;
  createdAt: string;
}

interface WebhookDelivery {
  id: number;
  webhookId: number;
  event: string;
  status: string;
  responseStatus?: number;
  createdAt: string;
}

interface McpServer {
  id: number;
  name: string;
  description?: string;
  endpoint: string;
  enabled: boolean;
  cachedAt?: string;
  cachedTools?: Array<{ name: string; description?: string }> | null;
  createdAt: string;
}

const CATEGORY_META: Record<Category, { label: string; icon: typeof ShieldCheck; tint: string }> = {
  auth: { label: "Authentication", icon: ShieldCheck, tint: "text-emerald-400" },
  payments: { label: "Payments", icon: CreditCard, tint: "text-amber-400" },
  database: { label: "Database", icon: Database, tint: "text-sky-400" },
  storage: { label: "Storage", icon: HardDrive, tint: "text-fuchsia-400" },
  ai: { label: "AI", icon: Cpu, tint: "text-violet-400" },
  mcp: { label: "MCP Server", icon: Plug, tint: "text-cyan-400" },
  other: { label: "Integrations", icon: Zap, tint: "text-orange-400" },
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

/**
 * Blueprint IDs that have platform-managed credentials automatically injected.
 * The card renders a persistent notice so users know before installing.
 */
const PLATFORM_NOTICES: Record<string, { label: string; detail: string }> = {
  "ai-openai": {
    label: "Platform proxy available",
    detail:
      "A proxied OpenAI key is injected automatically when you install — rate-limited to 100 req/day. Add your own OPENAI_API_KEY to remove the limit.",
  },
  "ai-providers": {
    label: "Platform proxy available",
    detail:
      "A proxied OpenAI key is injected automatically when you install — rate-limited to 100 req/day. Add your own OPENAI_API_KEY to remove the limit.",
  },
  "payments-stripe": {
    label: "Test keys available",
    detail:
      "A Stripe test-mode publishable key is injected automatically when you install. Replace STRIPE_PUBLISHABLE_KEY with your live key before going to production.",
  },
};

type TabId = "blueprints" | "connectors" | "webhooks" | "mcp";

export default function IntegrationsTab({ projectId }: { projectId: number }) {
  const [activeTab, setActiveTab] = useState<TabId>("blueprints");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-0 border-b border-border px-4 pt-2 shrink-0">
        {(
          [
            { id: "blueprints", label: "Marketplace", icon: Package },
            { id: "connectors", label: "Connectors", icon: Blocks },
            { id: "webhooks", label: "Webhooks", icon: Webhook },
            { id: "mcp", label: "MCP Servers", icon: Server },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
              activeTab === id
                ? "border-cyan-500 text-cyan-300"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {activeTab === "blueprints" && <BlueprintsPanel projectId={projectId} />}
        {activeTab === "connectors" && <ConnectorsPanel projectId={projectId} />}
        {activeTab === "webhooks" && <WebhooksPanel projectId={projectId} />}
        {activeTab === "mcp" && <McpPanel />}
      </div>
    </div>
  );
}

// ─── Connectors panel ─────────────────────────────────────────────────────────

function ConnectorsPanel({ projectId }: { projectId: number }) {
  const { data: secrets = [], isLoading } = useListSecrets(projectId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading connectors…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6 h-full">
      <div>
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Blocks className="h-4 w-4 text-cyan-400" /> Connectors
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Connect third-party services by adding their API keys as project secrets. Connected
          integrations are automatically available to the AI builder.
        </p>
      </div>
      <IntegrationsRegistry projectId={projectId} secrets={secrets} />
    </div>
  );
}

// ─── Blueprints panel ─────────────────────────────────────────────────────────

function BlueprintsPanel({ projectId }: { projectId: number }) {
  const { toast } = useToast();
  const [catalog, setCatalog] = useState<BlueprintListItem[]>([]);
  const [installed, setInstalled] = useState<InstalledRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [lastNotices, setLastNotices] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState<Category | "all">("all");
  const [postInstallDialog, setPostInstallDialog] = useState<PostInstallDialogState | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [bpRes, instRes] = await Promise.all([
        authFetch("/api/blueprints", { credentials: "include" }),
        authFetch(`/api/projects/${projectId}/blueprints`, { credentials: "include" }),
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
      setLastNotices([]);
      try {
        const res = await authFetch(`/api/projects/${projectId}/blueprints/install`, {
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
          platformNotices?: string[];
          packagesInstalling?: boolean;
          reason?: string;
        };
        if (!res.ok || !body.installed) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const fw = body.filesWritten?.length ?? 0;
        const fs = body.filesSkipped?.length ?? 0;

        if (body.platformNotices?.length) {
          setLastNotices(body.platformNotices);
        }

        // If the blueprint requires secrets, fetch full spec + existing secrets in parallel
        // so we can show the post-install dialog instead of asking users to switch tabs.
        if (bp.requiredSecrets.length > 0) {
          const [bpDetailRes, secretsRes] = await Promise.all([
            authFetch(`/api/blueprints/${bp.id}`, { credentials: "include" }),
            authFetch(`/api/projects/${projectId}/secrets`, { credentials: "include" }),
          ]);
          const bpDetail = bpDetailRes.ok
            ? ((await bpDetailRes.json()) as {
                requiredSecrets?: BlueprintSecretSpec[];
                url?: string;
              })
            : null;
          const secretsList = secretsRes.ok
            ? ((await secretsRes.json()) as ExistingSecretEntry[])
            : [];

          const specs: BlueprintSecretSpec[] = bpDetail?.requiredSecrets?.length
            ? bpDetail.requiredSecrets
            : bp.requiredSecrets.map((name) => ({ name }));

          setPostInstallDialog({
            blueprintName: bp.name,
            blueprintUrl: bpDetail?.url ?? bp.url,
            secretSpecs: specs,
            existingSecrets: secretsList,
          });

          setLastResult(
            `Installed ${bp.name} — ${fw} file${fw === 1 ? "" : "s"} written` +
              (fs > 0 ? `, ${fs} skipped (already existed)` : "") +
              ".",
          );
        } else {
          setLastResult(
            `Installed ${bp.name} — ${fw} file${fw === 1 ? "" : "s"} written` +
              (fs > 0 ? `, ${fs} skipped (already existed)` : "") +
              ".",
          );
        }

        if (body.packagesInstalling) {
          toast({
            title: "Blueprint installed",
            description: "Packages are being installed in the background.",
          });
        } else if (body.reason === "container_not_ready") {
          toast({
            title: "Blueprint installed",
            description: "Packages will be available after your next build.",
          });
        }

        await refresh();
      } catch (err) {
        setError(`Install failed: ${(err as Error).message}`);
      } finally {
        setInstalling(null);
      }
    },
    [projectId, refresh, toast],
  );

  const handleUninstall = useCallback(
    async (bpId: string) => {
      setError(null);
      try {
        const res = await authFetch(`/api/projects/${projectId}/blueprints/${bpId}`, {
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
    <>
      {postInstallDialog && (
        <PostInstallSecretsDialog
          projectId={projectId}
          dialog={postInstallDialog}
          onClose={() => setPostInstallDialog(null)}
        />
      )}
      <div className="flex flex-col gap-6 p-6">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Plug className="h-4 w-4 text-cyan-400" /> Integrations Marketplace
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            One-click scaffolds for auth, payments, databases, storage, and AI. Each blueprint
            writes the necessary files into your project and lists the secrets you need to add.
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
            <div className="flex flex-col gap-1">
              <span>{lastResult}</span>
              {lastNotices.map((notice, i) => (
                <span key={i} className="text-amber-300 flex items-center gap-1">
                  <Info className="h-3 w-3 shrink-0" />
                  {notice}
                </span>
              ))}
            </div>
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
                  const platformNotice = PLATFORM_NOTICES[bp.id];
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

                      {/* Platform-managed credential notice — always visible on eligible cards */}
                      {platformNotice && (
                        <div className="rounded bg-amber-500/10 border border-amber-500/25 px-2.5 py-1.5 text-[10px] text-amber-300 flex items-start gap-1.5">
                          <Info className="h-3 w-3 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-semibold">{platformNotice.label} — </span>
                            {platformNotice.detail}
                          </div>
                        </div>
                      )}

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
    </>
  );
}

// ─── Post-install secrets dialog ──────────────────────────────────────────────

function PostInstallSecretsDialog({
  projectId,
  dialog,
  onClose,
}: {
  projectId: number;
  dialog: PostInstallDialogState;
  onClose: () => void;
}) {
  const existingMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of dialog.existingSecrets) m.set(s.name, s.masked);
    return m;
  }, [dialog.existingSecrets]);

  // One input value per secret spec
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const spec of dialog.secretSpecs) init[spec.name] = "";
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on backdrop click
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === overlayRef.current) onClose();
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const toSave = dialog.secretSpecs.filter(
      (spec) => !existingMap.has(spec.name) && values[spec.name]?.trim(),
    );
    try {
      for (const spec of toSave) {
        const res = await authFetch(`/api/projects/${projectId}/secrets`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: spec.name, value: values[spec.name]!.trim() }),
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          throw new Error(body.error ?? `Failed to save ${spec.name} (HTTP ${res.status})`);
        }
      }
      setSaved(true);
      setTimeout(onClose, 900);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const hasAnyInput = dialog.secretSpecs.some(
    (spec) => !existingMap.has(spec.name) && values[spec.name]?.trim(),
  );
  const allAlreadySet = dialog.secretSpecs.every((spec) => existingMap.has(spec.name));

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card shadow-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Key className="h-4 w-4 text-cyan-400 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">Configure secrets</p>
              <p className="text-[11px] text-muted-foreground truncate">
                {dialog.blueprintName} requires the following environment variables
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground shrink-0"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {dialog.secretSpecs.map((spec) => {
            const maskedValue = existingMap.get(spec.name);
            const alreadySet = maskedValue !== undefined;
            return (
              <div key={spec.name} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="text-xs font-medium font-mono">{spec.name}</label>
                  {spec.optional && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground">
                      optional
                    </span>
                  )}
                  {alreadySet && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 inline-flex items-center gap-1">
                      <BadgeCheck className="h-2.5 w-2.5" /> Already set
                    </span>
                  )}
                  {spec.helpUrl && (
                    <a
                      href={spec.helpUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-[10px] text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-0.5 ml-auto"
                    >
                      Where to find this <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>
                {spec.reason && <p className="text-[11px] text-muted-foreground">{spec.reason}</p>}
                {alreadySet ? (
                  <div className="px-3 py-2 rounded-md border border-border bg-muted/20 text-xs font-mono text-muted-foreground select-none">
                    {maskedValue}
                  </div>
                ) : (
                  <input
                    type="password"
                    autoComplete="off"
                    value={values[spec.name] ?? ""}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [spec.name]: e.target.value }))
                    }
                    placeholder={`Enter ${spec.name}…`}
                    className="px-3 py-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-cyan-500 font-mono"
                  />
                )}
              </div>
            );
          })}

          {saveError && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 text-red-300 text-xs p-3 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              {saveError}
            </div>
          )}

          {saved && (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs p-3 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> Secrets saved successfully.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded border border-border"
          >
            {allAlreadySet ? "Close" : "Skip for now"}
          </button>
          {!allAlreadySet && (
            <button
              type="button"
              disabled={saving || !hasAnyInput || saved}
              onClick={() => void handleSave()}
              className="text-xs font-medium text-emerald-300 inline-flex items-center gap-1.5 px-4 py-1.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Key className="h-3 w-3" />}
              Save secrets
            </button>
          )}
          {dialog.blueprintUrl && !allAlreadySet && (
            <a
              href={dialog.blueprintUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            >
              Docs <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Webhooks panel ───────────────────────────────────────────────────────────

function WebhooksPanel({ projectId }: { projectId: number }) {
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  const [availableEvents, setAvailableEvents] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [testingId, setTestingId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [expandedHook, setExpandedHook] = useState<number | null>(null);
  const [deliveries, setDeliveries] = useState<Record<number, WebhookDelivery[]>>({});
  const [loadingDeliveries, setLoadingDeliveries] = useState<number | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const loadWebhooks = useCallback(async () => {
    try {
      const res = await authFetch(`/api/projects/${projectId}/webhooks`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { webhooks: WebhookRow[]; availableEvents: string[] };
      setWebhooks(body.webhooks);
      setAvailableEvents(body.availableEvents);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadWebhooks();
  }, [loadWebhooks]);

  const handleCreate = async () => {
    if (!newUrl.trim()) return;
    setCreating(true);
    setError(null);
    setNewSecret(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/webhooks`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: newUrl.trim(), description: newDesc.trim() || undefined }),
      });
      const body = (await res.json()) as {
        webhook?: WebhookRow & { secret: string };
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.webhook?.secret && !body.webhook.secret.startsWith("••")) {
        setNewSecret(body.webhook.secret);
      }
      setNewUrl("");
      setNewDesc("");
      setShowNewForm(false);
      await loadWebhooks();
    } catch (err) {
      setError(`Create failed: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (hookId: number) => {
    setError(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/webhooks/${hookId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadWebhooks();
    } catch (err) {
      setError(`Delete failed: ${(err as Error).message}`);
    }
  };

  const handleTest = async (hookId: number) => {
    setTestingId(hookId);
    setTestResult(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/webhooks/${hookId}/test`, {
        method: "POST",
        credentials: "include",
      });
      const body = (await res.json()) as { message?: string; error?: string };
      setTestResult(body.message ?? body.error ?? "Test fired");
    } catch (err) {
      setTestResult(`Error: ${(err as Error).message}`);
    } finally {
      setTestingId(null);
    }
  };

  const handleLoadDeliveries = async (hookId: number) => {
    if (expandedHook === hookId) {
      setExpandedHook(null);
      return;
    }
    setExpandedHook(hookId);
    setLoadingDeliveries(hookId);
    try {
      const res = await authFetch(`/api/projects/${projectId}/webhooks/${hookId}/deliveries`, {
        credentials: "include",
      });
      const body = (await res.json()) as { deliveries: WebhookDelivery[] };
      setDeliveries((prev) => ({ ...prev, [hookId]: body.deliveries }));
    } catch {
      setDeliveries((prev) => ({ ...prev, [hookId]: [] }));
    } finally {
      setLoadingDeliveries(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading webhooks…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Webhook className="h-4 w-4 text-cyan-400" /> Webhooks
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Receive HTTP POST notifications when project events occur. Payloads are signed with
            HMAC-SHA256 using the webhook secret.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowNewForm((v) => !v)}
          className="text-xs font-medium text-emerald-300 inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 shrink-0"
        >
          <Plus className="h-3.5 w-3.5" /> New webhook
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 text-red-300 text-xs p-3 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {newSecret && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-300 text-xs p-3 flex flex-col gap-1">
          <span className="font-medium flex items-center gap-1">
            <Key className="h-3.5 w-3.5" /> Webhook secret — copy now, it won't be shown again
          </span>
          <code className="bg-black/30 rounded px-2 py-1 text-amber-200 break-all">
            {newSecret}
          </code>
          <p className="text-amber-400/70">
            Verify webhook payloads by checking the <code>X-Signature-256</code> header using
            HMAC-SHA256 with this secret.
          </p>
          <button
            type="button"
            onClick={() => setNewSecret(null)}
            className="self-end text-amber-400 hover:text-amber-200 text-[10px] underline"
          >
            I've saved it
          </button>
        </div>
      )}

      {testResult && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs p-3 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {testResult}
        </div>
      )}

      {showNewForm && (
        <div className="rounded-lg border border-border bg-card/50 p-4 flex flex-col gap-3">
          <p className="text-xs font-medium">New webhook endpoint</p>
          <input
            type="url"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://your-server.com/webhooks/mustaflow"
            className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
          <input
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-cyan-500"
          />
          {availableEvents.length > 0 && (
            <div className="text-[10px] text-muted-foreground">
              <span className="font-medium">Receives events:</span>{" "}
              {availableEvents.slice(0, 6).join(", ")}
              {availableEvents.length > 6 ? ` +${availableEvents.length - 6} more` : ""}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowNewForm(false)}
              className="text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded border border-border"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={creating || !newUrl.trim()}
              onClick={handleCreate}
              className="text-xs font-medium text-emerald-300 inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 disabled:opacity-50"
            >
              {creating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              Create
            </button>
          </div>
        </div>
      )}

      {webhooks.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/10 text-muted-foreground text-xs p-6 text-center">
          No webhooks configured. Create one to start receiving event notifications.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {webhooks.map((hook) => (
            <div
              key={hook.id}
              className="rounded-lg border border-border bg-card/50 overflow-hidden"
            >
              <div className="p-4 flex items-start gap-3">
                <div
                  className={cn(
                    "mt-1 h-2 w-2 rounded-full shrink-0",
                    hook.active ? "bg-emerald-400" : "bg-muted-foreground",
                  )}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{hook.url}</p>
                      {hook.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{hook.description}</p>
                      )}
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {hook.events.slice(0, 4).map((ev) => (
                          <span
                            key={ev}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground"
                          >
                            {ev}
                          </span>
                        ))}
                        {hook.events.length > 4 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground">
                            +{hook.events.length - 4}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleLoadDeliveries(hook.id)}
                        className="text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border inline-flex items-center gap-1"
                      >
                        <MessageSquare className="h-3 w-3" />
                        Deliveries
                      </button>
                      <button
                        type="button"
                        disabled={testingId === hook.id}
                        onClick={() => handleTest(hook.id)}
                        className="text-[11px] text-cyan-300 hover:text-cyan-200 px-2 py-1 rounded border border-cyan-500/30 bg-cyan-500/10 inline-flex items-center gap-1 disabled:opacity-50"
                      >
                        {testingId === hook.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Zap className="h-3 w-3" />
                        )}
                        Test
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(hook.id)}
                        className="text-[11px] text-muted-foreground hover:text-red-400 p-1 rounded"
                        title="Delete webhook"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Key className="h-2.5 w-2.5" /> Secret: <code>{hook.secret}</code>
                    </span>
                    <span>{hook.active ? "Active" : "Inactive"}</span>
                  </div>
                </div>
              </div>

              {expandedHook === hook.id && (
                <div className="border-t border-border p-4 bg-muted/10">
                  <p className="text-xs font-medium mb-2 text-muted-foreground">
                    Recent deliveries
                  </p>
                  {loadingDeliveries === hook.id ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                    </div>
                  ) : (deliveries[hook.id] ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No deliveries yet.</p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {(deliveries[hook.id] ?? []).map((d) => (
                        <div
                          key={d.id}
                          className="flex items-center gap-3 text-[11px] rounded bg-muted/30 px-2 py-1.5"
                        >
                          <span
                            className={cn(
                              "px-1.5 py-0.5 rounded font-mono",
                              d.status === "success"
                                ? "bg-emerald-500/15 text-emerald-300"
                                : "bg-red-500/15 text-red-300",
                            )}
                          >
                            {d.responseStatus ?? d.status}
                          </span>
                          <span className="text-muted-foreground">{d.event}</span>
                          <span className="ml-auto text-muted-foreground/60">
                            {new Date(d.createdAt).toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border border-border bg-muted/10 p-4 text-xs text-muted-foreground">
        <p className="font-medium text-foreground mb-1">Signature verification</p>
        <p>
          Each delivery includes an <code className="text-[11px]">X-Signature-256</code> header.
          Verify it server-side with HMAC-SHA256:
        </p>
        <pre className="mt-2 bg-black/30 rounded p-2 text-[10px] overflow-x-auto text-emerald-300">
          {`const sig = req.headers['x-signature-256'];
const expected = 'sha256=' +
  crypto.createHmac('sha256', WEBHOOK_SECRET)
        .update(rawBody).digest('hex');
const ok = sig === expected;`}
        </pre>
      </div>
    </div>
  );
}

// ─── MCP panel ────────────────────────────────────────────────────────────────

interface McpCreateState {
  name: string;
  endpoint: string;
  authHeader: string;
  description: string;
}

function McpPanel() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [form, setForm] = useState<McpCreateState>({
    name: "",
    endpoint: "",
    authHeader: "",
    description: "",
  });

  const loadServers = useCallback(async () => {
    try {
      const res = await authFetch("/api/admin/mcp-servers", { credentials: "include" });
      if (res.status === 403 || res.status === 401) {
        setIsAdmin(false);
        setServers([]);
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setIsAdmin(true);
      setServers((await res.json()) as McpServer[]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const handleRefresh = async (id: number) => {
    setRefreshingId(id);
    try {
      await authFetch(`/api/admin/mcp-servers/${id}/refresh-tools`, {
        method: "POST",
        credentials: "include",
      });
      await loadServers();
    } catch {
      /* refresh fails silently — stale tools remain displayed */
    } finally {
      setRefreshingId(null);
    }
  };

  const handleCreate = async () => {
    if (!form.name.trim() || !form.endpoint.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await authFetch("/api/admin/mcp-servers", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          endpoint: form.endpoint.trim(),
          authHeader: form.authHeader.trim() || undefined,
          description: form.description.trim() || undefined,
          enabled: true,
        }),
      });
      const body = (await res.json()) as { id?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setForm({ name: "", endpoint: "", authHeader: "", description: "" });
      setShowCreateForm(false);
      await loadServers();
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await authFetch(`/api/admin/mcp-servers/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      await loadServers();
    } catch {
      /* ignore */
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading MCP servers…
      </div>
    );
  }

  /* Non-admin view */
  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-6 p-6">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Server className="h-4 w-4 text-cyan-400" /> MCP Servers
          </h2>
        </div>
        <div className="rounded-md border border-border bg-muted/10 text-muted-foreground text-xs p-6 text-center flex flex-col items-center gap-2">
          <Lock className="h-8 w-8 opacity-30" />
          <p className="font-medium text-foreground">Platform-level feature</p>
          <p>
            MCP servers are registered once at the platform level and are automatically available
            inside the AI builder for every project. Registering and managing servers requires
            platform admin access.
          </p>
          <p className="mt-2 text-muted-foreground/60">
            If you need a new MCP server added, contact a platform administrator. Once registered,
            the AI builder will automatically discover and use its tools.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Server className="h-4 w-4 text-cyan-400" /> MCP Servers
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Model Context Protocol servers registered on this platform. Enabled servers have their
            tools injected into the AI builder's context during every build.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowCreateForm((v) => !v);
            setCreateError(null);
          }}
          className="text-xs font-medium text-emerald-300 inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 shrink-0"
        >
          <Plus className="h-3.5 w-3.5" /> Add server
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 text-red-300 text-xs p-3 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {showCreateForm && (
        <div className="rounded-lg border border-border bg-card/50 p-4 flex flex-col gap-3">
          <p className="text-xs font-medium">Register new MCP server</p>
          {createError && (
            <div className="rounded border border-red-500/30 bg-red-500/10 text-red-300 text-[11px] px-3 py-2">
              {createError}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-muted-foreground font-medium">
                Name <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="My MCP Server"
                className="px-3 py-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-muted-foreground font-medium">
                Endpoint URL <span className="text-red-400">*</span>
              </label>
              <input
                type="url"
                value={form.endpoint}
                onChange={(e) => setForm((f) => ({ ...f, endpoint: e.target.value }))}
                placeholder="https://mcp.example.com/v1"
                className="px-3 py-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-muted-foreground font-medium">
                Auth header{" "}
                <span className="text-muted-foreground/50">(optional — e.g. Bearer sk-…)</span>
              </label>
              <input
                type="password"
                value={form.authHeader}
                onChange={(e) => setForm((f) => ({ ...f, authHeader: e.target.value }))}
                placeholder="Bearer sk-…"
                className="px-3 py-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-muted-foreground font-medium">Description</label>
              <input
                type="text"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What tools does this server provide?"
                className="px-3 py-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowCreateForm(false)}
              className="text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded border border-border"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={creating || !form.name.trim() || !form.endpoint.trim()}
              onClick={handleCreate}
              className="text-xs font-medium text-emerald-300 inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 disabled:opacity-50"
            >
              {creating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              Register
            </button>
          </div>
        </div>
      )}

      {servers.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/10 text-muted-foreground text-xs p-6 text-center">
          <Server className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p>No MCP servers registered yet.</p>
          <p className="mt-1 text-muted-foreground/60">
            Click "Add server" to register the first MCP server. Once enabled, its tools will be
            available to the AI builder in every project.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {servers.map((server) => (
            <div
              key={server.id}
              className="rounded-lg border border-border bg-card/50 p-4 flex flex-col gap-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{server.name}</span>
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-1",
                        server.enabled
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                          : "bg-muted/30 text-muted-foreground border-border",
                      )}
                    >
                      {server.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  {server.description && (
                    <p className="text-xs text-muted-foreground mt-1">{server.description}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground/60 mt-1 font-mono break-all">
                    {server.endpoint}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={refreshingId === server.id}
                    onClick={() => handleRefresh(server.id)}
                    title="Refresh tool catalog"
                    className="p-1.5 rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    <RefreshCw
                      className={cn("h-3.5 w-3.5", refreshingId === server.id && "animate-spin")}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(server.id)}
                    title="Remove server"
                    className="p-1.5 rounded border border-border text-muted-foreground hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {server.cachedTools && server.cachedTools.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground mb-1.5">
                    Available tools ({server.cachedTools.length})
                    {server.cachedAt && (
                      <span className="ml-1 text-muted-foreground/50">
                        — refreshed {new Date(server.cachedAt).toLocaleString()}
                      </span>
                    )}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {server.cachedTools.slice(0, 12).map((t) => (
                      <span
                        key={t.name}
                        title={t.description}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-300 border border-violet-500/20"
                      >
                        {t.name}
                      </span>
                    ))}
                    {server.cachedTools.length > 12 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground">
                        +{server.cachedTools.length - 12} more
                      </span>
                    )}
                  </div>
                </div>
              )}

              {(!server.cachedTools || server.cachedTools.length === 0) && (
                <p className="text-[11px] text-muted-foreground/60">
                  Tool catalog not yet loaded. Click the refresh button to discover available tools.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border border-border bg-muted/10 p-4 text-xs text-muted-foreground">
        <p className="font-medium text-foreground mb-1">How MCP servers work</p>
        <p>
          The AI builder calls registered MCP servers using JSON-RPC 2.0 over HTTPS. Each server
          exposes a set of named tools (e.g. <code>search_codebase</code>,{" "}
          <code>get_jira_ticket</code>) that the AI can invoke during a build. Tool schemas are
          fetched once and cached — click Refresh to pick up new tools after a server update.
        </p>
      </div>
    </div>
  );
}
