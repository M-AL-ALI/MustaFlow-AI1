/**
 * WebhooksPanel — manage project webhooks (CRUD + delivery history).
 * Used inside the Publishing tab Domains section.
 */
import { authFetch } from "@/lib/api-fetch";
import { useState, useCallback, useEffect } from "react";
import {
  Webhook,
  Plus,
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  Clock,
  ToggleLeft,
  ToggleRight,
  Send,
  Eye,
  EyeOff,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Webhook {
  id: number;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WebhookDelivery {
  id: number;
  webhookId: number;
  event: string;
  status: "pending" | "success" | "failed";
  statusCode: number | null;
  attempt: number;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

const ALL_EVENTS = [
  "domain.attached",
  "domain.verified",
  "domain.detached",
  "dns.changed",
  "cert.issued",
  "cert.expiring",
  "cert.expired",
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function DeliveryRow({ d }: { d: WebhookDelivery }) {
  const [open, setOpen] = useState(false);
  const icon =
    d.status === "success" ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
    ) : d.status === "failed" ? (
      <XCircle className="h-3.5 w-3.5 text-red-500" />
    ) : (
      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
    );

  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 text-left"
      >
        {icon}
        <span className="text-xs font-mono text-foreground">{d.event}</span>
        {d.statusCode && (
          <span className="text-[11px] text-muted-foreground">HTTP {d.statusCode}</span>
        )}
        {d.durationMs != null && (
          <span className="text-[11px] text-muted-foreground">{d.durationMs}ms</span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {new Date(d.createdAt).toLocaleString()}
        </span>
        {open ? (
          <ChevronUp className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        )}
      </button>
      {open && d.error && (
        <div className="px-3 pb-2">
          <pre className="text-[11px] text-red-400 bg-red-500/5 rounded p-2 overflow-x-auto">
            {d.error}
          </pre>
        </div>
      )}
    </div>
  );
}

function WebhookRow({
  hook,
  projectId,
  onDeleted,
  onToggled,
  onTestSent,
}: {
  hook: Webhook;
  projectId: number;
  onDeleted: (id: number) => void;
  onToggled: (id: number, active: boolean) => void;
  onTestSent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const loadDeliveries = useCallback(async () => {
    setLoadingDeliveries(true);
    try {
      const r = await authFetch(`/api/projects/${projectId}/webhooks/${hook.id}/deliveries`);
      if (r.ok) {
        const data = (await r.json()) as { deliveries: WebhookDelivery[] };
        setDeliveries(data.deliveries ?? []);
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingDeliveries(false);
    }
  }, [projectId, hook.id]);

  useEffect(() => {
    if (open) void loadDeliveries();
  }, [open, loadDeliveries]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const r = await authFetch(`/api/projects/${projectId}/webhooks/${hook.id}`, {
        method: "DELETE",
      });
      if (r.ok) onDeleted(hook.id);
    } catch {
      /* ignore */
    } finally {
      setDeleting(false);
    }
  };

  const handleToggle = async () => {
    setToggling(true);
    try {
      const r = await authFetch(`/api/projects/${projectId}/webhooks/${hook.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !hook.active }),
      });
      if (r.ok) onToggled(hook.id, !hook.active);
    } catch {
      /* ignore */
    } finally {
      setToggling(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      await authFetch(`/api/projects/${projectId}/webhooks/${hook.id}/test`, { method: "POST" });
      onTestSent();
      if (open) await loadDeliveries();
    } catch {
      /* ignore */
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5 bg-muted/20">
        <Webhook className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-mono text-foreground truncate flex-1">{hook.url}</span>
        {hook.description && (
          <span className="text-[11px] text-muted-foreground hidden sm:block truncate max-w-[120px]">
            {hook.description}
          </span>
        )}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => void handleToggle()}
            disabled={toggling}
            title={hook.active ? "Disable webhook" : "Enable webhook"}
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {hook.active ? (
              <ToggleRight className="h-4 w-4 text-green-500" />
            ) : (
              <ToggleLeft className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testing}
            title="Send test event"
            className="p-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setOpen((p) => !p)}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={deleting}
            className="p-1 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
            title="Delete webhook"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {open && (
        <div className="divide-y divide-border/40 bg-background">
          {/* Secret */}
          <div className="px-3 py-2 flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground w-12">Secret</span>
            <code className="text-[11px] font-mono text-foreground flex-1">
              {showSecret ? hook.secret : "••••••••" + hook.secret.slice(-4)}
            </code>
            <button
              type="button"
              onClick={() => setShowSecret((p) => !p)}
              className="p-1 text-muted-foreground hover:text-foreground"
            >
              {showSecret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </button>
            <CopyButton text={hook.secret} />
          </div>

          {/* Events */}
          <div className="px-3 py-2">
            <span className="text-[11px] text-muted-foreground block mb-1.5">Events</span>
            <div className="flex flex-wrap gap-1">
              {hook.events.map((e) => (
                <span
                  key={e}
                  className="text-[10px] font-mono px-1.5 py-0.5 bg-primary/10 text-primary rounded"
                >
                  {e}
                </span>
              ))}
            </div>
          </div>

          {/* Deliveries */}
          <div>
            <div className="px-3 py-2 flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">Recent deliveries</span>
              <button
                type="button"
                onClick={() => void loadDeliveries()}
                disabled={loadingDeliveries}
                className="text-[11px] text-primary hover:underline disabled:opacity-50"
              >
                {loadingDeliveries ? "Loading…" : "Refresh"}
              </button>
            </div>
            {deliveries.length === 0 && !loadingDeliveries ? (
              <div className="px-3 pb-3 text-[11px] text-muted-foreground">No deliveries yet.</div>
            ) : (
              deliveries.slice(0, 15).map((d) => <DeliveryRow key={d.id} d={d} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CreateWebhookForm({
  projectId,
  onCreated,
  onCancel,
}: {
  projectId: number;
  onCreated: (hook: Webhook) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([...ALL_EVENTS]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleEvent = (e: string) => {
    setSelectedEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));
  };

  const handleSubmit = async () => {
    if (!url.trim()) {
      setError("URL is required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch(`/api/projects/${projectId}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          events: selectedEvents,
          description: description.trim() || undefined,
        }),
      });
      const data = (await r.json()) as { webhook?: Webhook; error?: string };
      if (!r.ok) {
        setError(data.error ?? "Failed to create webhook");
        return;
      }
      if (data.webhook) onCreated(data.webhook);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border border-border rounded-lg p-3 space-y-3 bg-muted/10">
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Endpoint URL</label>
        <input
          type="url"
          placeholder="https://your-server.com/webhook"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-full text-xs bg-background border border-border rounded-md px-3 py-2 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Description (optional)</label>
        <input
          type="text"
          placeholder="e.g. CI notifications"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full text-xs bg-background border border-border rounded-md px-3 py-2 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs text-muted-foreground">Events</label>
        <div className="flex flex-wrap gap-1.5">
          {ALL_EVENTS.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => toggleEvent(e)}
              className={cn(
                "text-[10px] font-mono px-2 py-1 rounded border transition-colors",
                selectedEvents.includes(e)
                  ? "bg-primary/10 border-primary/40 text-primary"
                  : "bg-background border-border text-muted-foreground hover:border-border/80",
              )}
            >
              {e}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" onClick={() => void handleSubmit()} disabled={loading}>
          {loading ? "Creating…" : "Create webhook"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function WebhooksPanel({ projectId }: { projectId: number }) {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [testSentId, setTestSentId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch(`/api/projects/${projectId}/webhooks`);
      if (r.ok) {
        const data = (await r.json()) as { webhooks: Webhook[] };
        setHooks(data.webhooks ?? []);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDeleted = (id: number) => setHooks((prev) => prev.filter((h) => h.id !== id));

  const handleToggled = (id: number, active: boolean) =>
    setHooks((prev) => prev.map((h) => (h.id === id ? { ...h, active } : h)));

  const handleCreated = (hook: Webhook) => {
    setHooks((prev) => [...prev, hook]);
    setShowCreate(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Webhook className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Webhooks</span>
          {hooks.length > 0 && (
            <span className="text-xs text-muted-foreground">({hooks.length})</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void load()}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <Button size="sm" variant="outline" onClick={() => setShowCreate((p) => !p)}>
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </div>

      {testSentId !== null && (
        <div className="text-xs text-green-500 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
          Test event sent — check deliveries for the result.
        </div>
      )}

      {showCreate && (
        <CreateWebhookForm
          projectId={projectId}
          onCreated={handleCreated}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {loading && hooks.length === 0 ? (
        <div className="text-xs text-muted-foreground py-2">Loading webhooks…</div>
      ) : hooks.length === 0 && !showCreate ? (
        <div className="text-xs text-muted-foreground py-2">
          No webhooks configured. Add one to receive domain lifecycle notifications.
        </div>
      ) : (
        <div className="space-y-2">
          {hooks.map((h) => (
            <WebhookRow
              key={h.id}
              hook={h}
              projectId={projectId}
              onDeleted={handleDeleted}
              onToggled={handleToggled}
              onTestSent={() => {
                setTestSentId(h.id);
                setTimeout(() => setTestSentId(null), 4000);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
