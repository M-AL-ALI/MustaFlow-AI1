import { useState, useCallback } from "react";
import {
  Lock,
  Plus,
  Copy,
  Trash2,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  Loader2,
  Edit2,
  X,
  ChevronDown,
  FileJson,
  FileText,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSecrets,
  useCreateSecret,
  useDeleteSecret,
  getListSecretsQueryKey,
} from "@workspace/api-client-react";
import type { SecretEntry } from "@workspace/api-client-react";

interface SecretsPanelProps {
  projectId: number;
}

type TabId = "project" | "account";

function SecretRow({
  secret,
  projectId,
  onDeleted,
  onUpdated,
}: {
  secret: SecretEntry;
  projectId: number;
  onDeleted: () => void;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  const deleteSecret = useDeleteSecret();

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(secret.name).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [secret.name]);

  const handleDelete = useCallback(() => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    deleteSecret.mutate({ id: projectId, secretId: secret.id }, { onSuccess: onDeleted });
  }, [confirmDelete, deleteSecret, projectId, secret.id, onDeleted]);

  const handleEdit = useCallback(() => {
    setEditValue("");
    setEditing(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editValue.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/secrets/${secret.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: editValue.trim() }),
        credentials: "include",
      });
      if (res.ok) {
        setEditing(false);
        setEditValue("");
        onUpdated();
      }
    } finally {
      setSaving(false);
    }
  }, [editValue, projectId, secret.id, onUpdated]);

  return (
    <div
      className={cn(
        "border border-border rounded-md overflow-hidden bg-card transition-colors",
        confirmDelete && "border-red-500/30 bg-red-500/5",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex items-center justify-center h-6 w-6 rounded bg-primary/10 shrink-0">
          <Lock className="h-3 w-3 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-xs font-medium text-foreground truncate">
            {secret.name}
          </div>
          <div className="font-mono text-[10px] text-muted-foreground">
            {revealed ? (
              <span className="text-yellow-400/80">edit value below to update</span>
            ) : (
              secret.masked
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => setRevealed((v) => !v)}
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={revealed ? "Hide" : "Show masked value"}
          >
            {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </button>
          <button
            onClick={handleCopy}
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Copy name"
          >
            {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
          </button>
          <button
            onClick={handleEdit}
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Edit value"
          >
            <Edit2 className="h-3 w-3" />
          </button>
          <button
            onClick={handleDelete}
            onBlur={() => setTimeout(() => setConfirmDelete(false), 200)}
            className={cn(
              "h-6 w-6 flex items-center justify-center rounded transition-colors",
              confirmDelete
                ? "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                : "text-muted-foreground hover:text-red-400 hover:bg-muted",
            )}
            title={confirmDelete ? "Click again to confirm deletion" : "Delete secret"}
          >
            {deleteSecret.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>

      {editing && (
        <div className="border-t border-border px-3 py-2 space-y-2 bg-muted/20">
          <div className="text-[10px] text-muted-foreground">New value for {secret.name}</div>
          <div className="flex gap-1.5">
            <input
              type="password"
              autoFocus
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSave();
                if (e.key === "Escape") setEditing(false);
              }}
              placeholder="Enter new value…"
              className="flex-1 bg-background border border-border rounded px-2 py-1 text-xs font-mono outline-none focus:border-primary/50"
            />
            <button
              onClick={() => void handleSave()}
              disabled={!editValue.trim() || saving}
              className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded disabled:opacity-40 hover:bg-primary/90 transition-colors"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddSecretForm({
  projectId,
  onAdded,
  onCancel,
}: {
  projectId: number;
  onAdded: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const createSecret = useCreateSecret();

  const handleSave = useCallback(() => {
    if (!name.trim() || !value.trim()) return;
    createSecret.mutate(
      {
        id: projectId,
        data: {
          name: name.trim().toUpperCase().replace(/\s/g, "_"),
          value: value.trim(),
          environment: "development",
        },
      },
      { onSuccess: onAdded },
    );
  }, [name, value, createSecret, projectId, onAdded]);

  return (
    <div className="border border-primary/30 rounded-md bg-primary/5 p-3 space-y-2">
      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
        New Secret
      </div>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
        placeholder="SECRET_NAME"
        className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono outline-none focus:border-primary/50"
      />
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleSave();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Secret value…"
        className="w-full bg-background border border-border rounded px-2 py-1.5 text-xs font-mono outline-none focus:border-primary/50"
      />
      <div className="flex gap-1.5">
        <button
          onClick={handleSave}
          disabled={!name.trim() || !value.trim() || createSecret.isPending}
          className="flex-1 py-1.5 text-xs bg-primary text-primary-foreground rounded disabled:opacity-40 hover:bg-primary/90 transition-colors font-medium"
        >
          {createSecret.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin mx-auto" />
          ) : (
            "Add Secret"
          )}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded hover:bg-muted transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function BulkEditModal({
  projectId,
  onClose,
  onSaved,
}: {
  projectId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<"json" | "env">("env");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      const pairs: Array<{ name: string; value: string }> = [];
      if (mode === "env") {
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const idx = trimmed.indexOf("=");
          if (idx < 1) continue;
          const k = trimmed.slice(0, idx).trim();
          const v = trimmed
            .slice(idx + 1)
            .trim()
            .replace(/^["']|["']$/g, "");
          if (k) pairs.push({ name: k, value: v });
        }
      } else {
        const parsed = JSON.parse(text) as Record<string, string>;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof k === "string" && typeof v === "string") {
            pairs.push({ name: k, value: v });
          }
        }
      }
      if (pairs.length === 0) {
        setError("No valid secrets found in the input.");
        setSaving(false);
        return;
      }
      for (const pair of pairs) {
        await fetch(`/api/projects/${projectId}/secrets`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...pair, environment: "development" }),
          credentials: "include",
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse secrets.");
    } finally {
      setSaving(false);
    }
  }, [text, mode, projectId, onSaved, onClose]);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="text-sm font-semibold">Bulk Import Secrets</div>
          <button
            onClick={onClose}
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex gap-1.5">
            <button
              onClick={() => setMode("env")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors",
                mode === "env"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              <FileText className="h-3 w-3" /> .env format
            </button>
            <button
              onClick={() => setMode("json")}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors",
                mode === "json"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              <FileJson className="h-3 w-3" /> JSON format
            </button>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              mode === "env"
                ? "DATABASE_URL=postgres://...\nAPI_KEY=sk-..."
                : '{\n  "DATABASE_URL": "postgres://...",\n  "API_KEY": "sk-..."\n}'
            }
            rows={8}
            className="w-full bg-background border border-border rounded px-3 py-2 text-xs font-mono outline-none focus:border-primary/50 resize-none"
          />
          {error && (
            <div className="flex items-start gap-1.5 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              {error}
            </div>
          )}
          <div className="flex gap-1.5">
            <button
              onClick={() => void handleSave()}
              disabled={!text.trim() || saving}
              className="flex-1 py-2 text-sm bg-primary text-primary-foreground rounded font-medium disabled:opacity-40 hover:bg-primary/90 transition-colors"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin mx-auto" /> : "Import Secrets"}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted-foreground border border-border rounded hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SecretsPanel({ projectId }: SecretsPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("project");
  const [showAdd, setShowAdd] = useState(false);
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const queryClient = useQueryClient();

  const { data: secrets = [], isLoading } = useListSecrets(projectId, {
    query: { queryKey: getListSecretsQueryKey(projectId) },
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getListSecretsQueryKey(projectId) });
  }, [queryClient, projectId]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {showBulkEdit && (
        <BulkEditModal
          projectId={projectId}
          onClose={() => setShowBulkEdit(false)}
          onSaved={invalidate}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Secrets
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowBulkEdit(true)}
            className="h-5 px-1.5 flex items-center gap-1 rounded text-[9px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Bulk import secrets"
          >
            <ChevronDown className="h-2.5 w-2.5" />
            Import
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Add secret"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border shrink-0">
        {(["project", "account"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "flex-1 py-1.5 text-[11px] font-medium capitalize transition-colors border-b-2",
              activeTab === tab
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-2 space-y-2">
        {activeTab === "project" ? (
          <>
            {showAdd && (
              <AddSecretForm
                projectId={projectId}
                onAdded={() => {
                  setShowAdd(false);
                  invalidate();
                }}
                onCancel={() => setShowAdd(false)}
              />
            )}

            {/* Banner: secrets that are not marked preview-safe are excluded from the container */}
            {!isLoading &&
              !showAdd &&
              (() => {
                const notSafe = (secrets as SecretEntry[]).filter(
                  (s) =>
                    (s.environment === "development" || s.environment === "testing") &&
                    !s.isPreviewSafe,
                );
                if (notSafe.length === 0) return null;
                return (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-400">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>
                      <span className="font-medium">
                        {notSafe.length} secret{notSafe.length !== 1 ? "s" : ""} not injected into
                        container
                      </span>{" "}
                      — the agent cannot access them. Enable &ldquo;Preview safe&rdquo; on each
                      secret from the secret settings to allow injection.
                    </span>
                  </div>
                );
              })()}

            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (secrets as SecretEntry[]).length === 0 && !showAdd ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
                <div className="w-10 h-10 rounded-xl bg-muted/50 border border-border flex items-center justify-center">
                  <Lock className="h-5 w-5 text-muted-foreground/40" />
                </div>
                <div>
                  <div className="text-xs font-medium text-foreground mb-0.5">No secrets yet</div>
                  <div className="text-[11px] text-muted-foreground max-w-[160px] leading-relaxed">
                    Add secrets to use as environment variables in your project.
                  </div>
                </div>
                <button
                  onClick={() => setShowAdd(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded font-medium hover:bg-primary/90 transition-colors"
                >
                  <Plus className="h-3 w-3" /> Add your first secret
                </button>
              </div>
            ) : (
              (secrets as SecretEntry[]).map((s) => (
                <SecretRow
                  key={s.id}
                  secret={s}
                  projectId={projectId}
                  onDeleted={invalidate}
                  onUpdated={invalidate}
                />
              ))
            )}
          </>
        ) : (
          <div className="space-y-3">
            <div className="border border-border rounded-lg p-3 bg-card">
              <div className="flex items-start gap-2.5">
                <Shield className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-medium text-foreground mb-1">Account Secrets</div>
                  <div className="text-[11px] text-muted-foreground leading-relaxed">
                    Account secrets are available across all your projects. Manage them from the
                    platform Settings page.
                  </div>
                </div>
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground px-1">
              Access via <code className="bg-muted px-1 rounded">process.env.SECRET_NAME</code> in
              your code — same as project secrets.
            </div>
          </div>
        )}
      </div>

      {activeTab === "project" && (secrets as SecretEntry[]).length > 0 && !showAdd && (
        <div className="px-3 py-2 border-t border-border shrink-0">
          <button
            onClick={() => setShowAdd(true)}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground border border-dashed border-border rounded hover:border-primary/30 transition-colors"
          >
            <Plus className="h-3 w-3" /> Add secret
          </button>
        </div>
      )}
    </div>
  );
}
