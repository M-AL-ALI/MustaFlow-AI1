import { authFetch } from "@/lib/api-fetch";
import { useEffect, useState } from "react";
import {
  Plus,
  Smartphone,
  Globe,
  Server,
  Presentation,
  BarChart3,
  X,
  Clapperboard,
  Cog,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

/**
 * Artifact tab strip + "Add artifact" modal (Task #544).
 *
 * Renders above the workspace tab bar. Switching an artifact updates the
 * activeArtifactId in URL (?artifactId=N) and notifies the parent so Files /
 * Preview / Chat can scope their queries.
 *
 * Uses raw fetch() rather than generated hooks — same pattern as
 * canvas-variants since the surface is still stabilising.
 */

export interface ArtifactRow {
  id: number;
  projectId: number;
  kind: string;
  platform: string;
  projectFormat: string;
  stack: string;
  name: string;
  slug: string;
  isPrimary: boolean;
  status: string;
}

const KIND_OPTIONS: Array<{
  value: string;
  label: string;
  description: string;
  Icon: typeof Globe;
}> = [
  {
    value: "web",
    label: "Web app",
    description: "React + Vite + Tailwind",
    Icon: Globe,
  },
  {
    value: "mobile-cross",
    label: "Mobile (iOS + Android)",
    description: "Expo + React Native",
    Icon: Smartphone,
  },
  {
    value: "api",
    label: "API",
    description: "Node.js + Express",
    Icon: Server,
  },
  {
    value: "slides",
    label: "Slides",
    description: "Reveal.js slide deck",
    Icon: Presentation,
  },
  {
    value: "animation",
    label: "Animation",
    description: "Animated explainer / motion graphic",
    Icon: Clapperboard,
  },
  {
    value: "automation",
    label: "Automation",
    description: "Node.js cron / scheduled script",
    Icon: Cog,
  },
  {
    value: "data-app",
    label: "Data app",
    description: "Charts + dashboards",
    Icon: BarChart3,
  },
];

function iconFor(kind: string): typeof Globe {
  if (kind.startsWith("mobile")) return Smartphone;
  if (kind === "api") return Server;
  if (kind === "slides") return Presentation;
  if (kind === "animation") return Clapperboard;
  if (kind === "automation") return Cog;
  if (kind === "data-app") return BarChart3;
  return Globe;
}

export function ArtifactTabs(props: {
  projectId: number;
  activeArtifactId: number | null;
  onSelect: (artifactId: number | null) => void;
}) {
  const { projectId, activeArtifactId, onSelect } = props;
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const refresh = async () => {
    try {
      const r = await authFetch(`/api/projects/${projectId}/artifacts`, {
        credentials: "include",
      });
      if (r.ok) {
        const rows: ArtifactRow[] = await r.json();
        setArtifacts(rows);
        // Default selection to primary if nothing chosen yet.
        if (activeArtifactId === null && rows.length > 0) {
          const primary = rows.find((a) => a.isPrimary) ?? rows[0]!;
          onSelect(primary.id);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (loading) return null;
  // Hide the strip entirely when there's only one artifact AND the user
  // hasn't opened the add modal — keeps the legacy single-artifact UI clean.
  const showStrip = artifacts.length > 1 || modalOpen;

  return (
    <>
      {showStrip && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-card/50">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-2">
            Artifacts
          </span>
          {artifacts.map((a) => {
            const Icon = iconFor(a.kind);
            const active = a.id === activeArtifactId;
            return (
              <button
                key={a.id}
                onClick={() => {
                  onSelect(a.id);
                  const url = new URL(window.location.href);
                  url.searchParams.set("artifactId", String(a.id));
                  window.history.replaceState(null, "", url.toString());
                }}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors",
                  active
                    ? "bg-primary/10 border-primary/30 text-foreground"
                    : "bg-transparent border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                title={`${a.name} (${a.kind})`}
              >
                <Icon className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[120px]">{a.name}</span>
                {a.isPrimary && (
                  <span className="text-[9px] px-1 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20">
                    primary
                  </span>
                )}
              </button>
            );
          })}
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
            title="Add a new artifact (web, mobile, api, slides…)"
          >
            <Plus className="h-3 w-3" /> Add artifact
          </button>
        </div>
      )}

      {/* Compact "+" affordance in the corner when strip is hidden */}
      {!showStrip && (
        <button
          onClick={() => setModalOpen(true)}
          className="hidden md:flex absolute right-3 top-14 z-10 items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium border border-dashed border-border text-muted-foreground bg-card/80 backdrop-blur hover:text-foreground hover:border-primary/40 transition-colors"
          title="Add a mobile app, API, or another artifact to this project"
        >
          <Plus className="h-3 w-3" /> Add artifact
        </button>
      )}

      <AddArtifactModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        projectId={projectId}
        onCreated={async (id) => {
          setModalOpen(false);
          await refresh();
          onSelect(id);
        }}
      />
    </>
  );
}

function AddArtifactModal(props: {
  open: boolean;
  onClose: () => void;
  projectId: number;
  onCreated: (artifactId: number) => void | Promise<void>;
}) {
  const { open, onClose, projectId, onCreated } = props;
  const [kind, setKind] = useState<string>("mobile-cross");
  const [name, setName] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName("");
      setError(null);
      setKind("mobile-cross");
    }
  }, [open]);

  const selected = KIND_OPTIONS.find((o) => o.value === kind);

  const submit = async () => {
    if (!name.trim()) {
      setError("Give the artifact a name");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await authFetch(`/api/projects/${projectId}/artifacts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ kind, name: name.trim() }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `Failed (${r.status})`);
        return;
      }
      const created = (await r.json()) as { id: number };
      await onCreated(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an artifact</DialogTitle>
          <DialogDescription>
            Add another buildable piece to this project. The AI will be aware of all artifacts and
            can reason across them (for example, wire your mobile app to your API).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">
              Artifact type
            </label>
            <div className="grid grid-cols-2 gap-2">
              {KIND_OPTIONS.map((opt) => {
                const Icon = opt.Icon;
                const active = opt.value === kind;
                return (
                  <button
                    key={opt.value}
                    onClick={() => setKind(opt.value)}
                    className={cn(
                      "flex items-start gap-2 p-3 rounded-lg border text-left transition-colors",
                      active
                        ? "border-primary/40 bg-primary/5"
                        : "border-border hover:border-primary/20 hover:bg-muted/50",
                    )}
                  >
                    <Icon className="h-4 w-4 mt-0.5 text-foreground shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">{opt.label}</div>
                      <div className="text-[11px] text-muted-foreground">{opt.description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={selected?.label ?? "My artifact"}
              autoFocus
            />
          </div>

          {error && (
            <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2 flex items-start gap-2">
              <X className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Adding…" : "Add artifact"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
