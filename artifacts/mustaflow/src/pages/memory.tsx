import { authFetch } from "@/lib/api-fetch";
import { useState, useCallback, useEffect } from "react";
import { useListKnowledge, getListKnowledgeQueryKey } from "@workspace/api-client-react";
import type { KnowledgeEntry } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/app-layout";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BrainCircuit,
  Sparkles,
  RefreshCw,
  Loader2,
  ThumbsUp,
  ThumbsDown,
  Archive,
  ChevronDown,
  ChevronRight,
  Palette,
  Code2,
  LayoutTemplate,
  Type,
  Layers,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function getStyleIcon(category: string) {
  switch (category.toLowerCase()) {
    case "style":
    case "colour":
    case "color":
      return Palette;
    case "code":
    case "coding":
      return Code2;
    case "layout":
    case "ui":
      return LayoutTemplate;
    case "typography":
    case "font":
    case "text":
      return Type;
    default:
      return Layers;
  }
}

function StyleMemoryCard({ entry, onRated }: { entry: KnowledgeEntry; onRated: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const { toast } = useToast();

  const StyleIcon = getStyleIcon(entry.category);

  const handleRate = async (direction: "up" | "down") => {
    if (rating === direction) return;
    try {
      await authFetch(`/api/knowledge/${entry.id}/rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: direction }),
      });
      setRating(direction);
      onRated();
    } catch {
      toast({ title: "Failed to rate lesson", variant: "destructive" });
    }
  };

  return (
    <div
      className={cn(
        "border rounded-lg p-4 bg-card transition-all",
        entry.archivedAt ? "opacity-40 border-border/40" : "border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 mt-0.5">
          <StyleIcon className="h-4 w-4 text-primary" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <h3 className="text-sm font-medium text-foreground leading-snug">{entry.title}</h3>
              <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium border border-primary/30 bg-primary/10 text-primary">
                  {entry.category}
                </span>
                <span className="text-[10px] text-muted-foreground/50">
                  {new Date(entry.createdAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => void handleRate("up")}
                className={cn(
                  "flex items-center gap-1 px-1.5 py-1 rounded text-[10px] transition-colors",
                  rating === "up"
                    ? "bg-green-500/15 text-green-400 border border-green-500/30"
                    : "text-muted-foreground hover:text-green-400 hover:bg-green-500/10 border border-transparent",
                )}
                title="Helpful"
              >
                <ThumbsUp className="h-3 w-3" />
                <span>{(entry.thumbsUp ?? 0) + (rating === "up" ? 1 : 0)}</span>
              </button>
              <button
                onClick={() => void handleRate("down")}
                className={cn(
                  "flex items-center gap-1 px-1.5 py-1 rounded text-[10px] transition-colors",
                  rating === "down"
                    ? "bg-red-500/15 text-red-400 border border-red-500/30"
                    : "text-muted-foreground hover:text-red-400 hover:bg-red-500/10 border border-transparent",
                )}
                title="Not helpful"
              >
                <ThumbsDown className="h-3 w-3" />
                <span>{(entry.thumbsDown ?? 0) + (rating === "down" ? 1 : 0)}</span>
              </button>
              <button
                onClick={() => setExpanded((v) => !v)}
                className="w-6 h-6 flex items-center justify-center text-muted-foreground hover:text-foreground"
              >
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>

          {expanded && (
            <p className="mt-2.5 text-xs text-muted-foreground leading-relaxed border-t border-border/50 pt-2.5">
              {entry.content}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

type BrandProfile = {
  primaryColor: string;
  accentColor: string;
  fontPairing: string;
  tone: string;
};

const EMPTY_BRAND: BrandProfile = {
  primaryColor: "",
  accentColor: "",
  fontPairing: "",
  tone: "",
};

const TONE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "No preference" },
  { value: "formal and professional", label: "Formal" },
  { value: "friendly and casual", label: "Casual" },
  { value: "playful and energetic", label: "Playful" },
  { value: "minimal and direct", label: "Minimal" },
];

function BrandProfileSection() {
  const { toast } = useToast();
  const [profile, setProfile] = useState<BrandProfile>(EMPTY_BRAND);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/knowledge/brand-profile");
        if (!res.ok) {
          if (!cancelled) setLoaded(true);
          return;
        }
        const data = (await res.json()) as { profile: (BrandProfile & { id: number }) | null };
        if (cancelled) return;
        if (data.profile) {
          setProfile({
            primaryColor: data.profile.primaryColor ?? "",
            accentColor: data.profile.accentColor ?? "",
            fontPairing: data.profile.fontPairing ?? "",
            tone: data.profile.tone ?? "",
          });
          setHasSaved(true);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const isEmpty =
    !profile.primaryColor && !profile.accentColor && !profile.fontPairing && !profile.tone;

  const handleSave = async () => {
    if (isEmpty) {
      toast({ title: "Fill in at least one field", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch("/api/knowledge/brand-profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      if (!res.ok) throw new Error("save failed");
      setHasSaved(true);
      toast({
        title: "Brand profile saved",
        description: "Every new build will follow your colours, fonts, and tone.",
      });
    } catch {
      toast({ title: "Failed to save brand profile", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSaving(true);
    try {
      await authFetch("/api/knowledge/brand-profile", { method: "DELETE" });
      setProfile(EMPTY_BRAND);
      setHasSaved(false);
      toast({ title: "Brand profile cleared" });
    } catch {
      toast({ title: "Failed to clear brand profile", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        <Palette className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Brand Profile</h2>
        {hasSaved && (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium border border-green-500/30 bg-green-500/10 text-green-400">
            Active
          </span>
        )}
      </div>

      <div className="border border-border rounded-xl p-5 bg-card">
        <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
          Teach MustaFlow your brand. Every new build will start with these colours, fonts, and tone
          — no need to repeat yourself in every prompt.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] font-medium text-foreground mb-1.5">
              Primary colour
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={profile.primaryColor || "#3b82f6"}
                onChange={(e) => setProfile((p) => ({ ...p, primaryColor: e.target.value }))}
                className="h-9 w-12 rounded border border-border bg-background cursor-pointer"
                disabled={!loaded}
                aria-label="Primary colour picker"
              />
              <input
                type="text"
                placeholder="#3b82f6"
                value={profile.primaryColor}
                onChange={(e) => setProfile((p) => ({ ...p, primaryColor: e.target.value }))}
                className="flex-1 h-9 px-3 rounded-md border border-border bg-background text-xs font-mono"
                disabled={!loaded}
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-foreground mb-1.5">
              Accent colour
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={profile.accentColor || "#8b5cf6"}
                onChange={(e) => setProfile((p) => ({ ...p, accentColor: e.target.value }))}
                className="h-9 w-12 rounded border border-border bg-background cursor-pointer"
                disabled={!loaded}
                aria-label="Accent colour picker"
              />
              <input
                type="text"
                placeholder="#8b5cf6"
                value={profile.accentColor}
                onChange={(e) => setProfile((p) => ({ ...p, accentColor: e.target.value }))}
                className="flex-1 h-9 px-3 rounded-md border border-border bg-background text-xs font-mono"
                disabled={!loaded}
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-foreground mb-1.5">
              Font pairing
            </label>
            <input
              type="text"
              placeholder="e.g. Inter for body, Space Grotesk for headings"
              value={profile.fontPairing}
              onChange={(e) => setProfile((p) => ({ ...p, fontPairing: e.target.value }))}
              className="w-full h-9 px-3 rounded-md border border-border bg-background text-xs"
              disabled={!loaded}
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-foreground mb-1.5">
              Writing tone
            </label>
            <select
              value={profile.tone}
              onChange={(e) => setProfile((p) => ({ ...p, tone: e.target.value }))}
              className="w-full h-9 px-3 rounded-md border border-border bg-background text-xs"
              disabled={!loaded}
            >
              {TONE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-5">
          <Button
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || !loaded || isEmpty}
            className="gap-2"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Palette className="h-3.5 w-3.5" />
            )}
            {hasSaved ? "Update brand profile" : "Save brand profile"}
          </Button>
          {hasSaved && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleClear()}
              disabled={saving}
            >
              Clear
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

export default function MemoryPage() {
  const [inferring, setInferring] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const params = {
    scope: "user" as const,
    archived: false,
    limit: 100,
  };

  const {
    data: entries = [],
    isLoading,
    refetch,
  } = useListKnowledge(params, {
    query: {
      queryKey: getListKnowledgeQueryKey(params),
    },
  });

  const styleEntries = entries.filter((e) => e.type === "style_memory");
  const otherUserEntries = entries.filter((e) => e.type !== "style_memory");

  const handleInferStyle = useCallback(async () => {
    setInferring(true);
    try {
      const res = await authFetch("/api/knowledge/infer-style", { method: "POST" });
      const data = (await res.json()) as { inferred: number; message: string };
      toast({
        title: data.inferred > 0 ? "Style preferences updated" : "No new preferences found",
        description: data.message,
      });
      void refetch();
      void queryClient.invalidateQueries({ queryKey: getListKnowledgeQueryKey(params) });
    } catch {
      toast({ title: "Inference failed", variant: "destructive" });
    } finally {
      setInferring(false);
    }
  }, [refetch, queryClient, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AppLayout>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <BrainCircuit className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-foreground">Style Memory</h1>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Your personal AI preferences, inferred from your builds
                </p>
              </div>
            </div>
            <Button
              onClick={() => void handleInferStyle()}
              disabled={inferring}
              size="sm"
              className="gap-2"
            >
              {inferring ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {inferring ? "Analysing…" : "Re-analyse style"}
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* User-declared brand profile */}
              <BrandProfileSection />

              {/* Style preferences */}
              <section className="mb-8">
                <div className="flex items-center gap-2 mb-4">
                  <Palette className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">Inferred Preferences</h2>
                  <span className="text-[10px] text-muted-foreground/60 ml-1">
                    ({styleEntries.length})
                  </span>
                </div>

                {styleEntries.length === 0 ? (
                  <div className="border border-dashed border-border rounded-xl p-8 text-center">
                    <BrainCircuit className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground mb-1">No style preferences yet</p>
                    <p className="text-xs text-muted-foreground/60 max-w-sm mx-auto leading-relaxed mb-4">
                      Build a few projects first. Then click "Re-analyse style" and the AI will
                      infer your preferences from your build history.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleInferStyle()}
                      disabled={inferring}
                      className="gap-2"
                    >
                      {inferring ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      Analyse now
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {styleEntries.map((entry) => (
                      <StyleMemoryCard
                        key={entry.id}
                        entry={entry}
                        onRated={() => void refetch()}
                      />
                    ))}
                  </div>
                )}
              </section>

              {/* Other user-scoped entries */}
              {otherUserEntries.length > 0 && (
                <section>
                  <div className="flex items-center gap-2 mb-4">
                    <Archive className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold text-foreground">Personal Notes</h2>
                    <span className="text-[10px] text-muted-foreground/60 ml-1">
                      ({otherUserEntries.length})
                    </span>
                  </div>
                  <div className="space-y-2">
                    {otherUserEntries.map((entry) => (
                      <StyleMemoryCard
                        key={entry.id}
                        entry={entry}
                        onRated={() => void refetch()}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}

          {/* How it works */}
          <div className="mt-10 border border-border/50 rounded-xl p-5 bg-muted/20">
            <div className="flex items-center gap-2 mb-3">
              <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                How style memory works
              </span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              After every build, MustaFlow analyses your history and infers your style preferences —
              things like colour palettes, component patterns, and code conventions. These
              preferences are automatically injected into your next AI build, making every project
              feel more "you" without manual configuration.
            </p>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
