import { useState, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  Sparkles,
  Loader2,
  ChevronLeft,
  Copy,
  Check,
  FileText,
  AlertTriangle,
  BookOpen,
} from "lucide-react";
import {
  KnowledgeSuggestionCard,
  type KnowledgeSuggestion,
} from "./knowledge-suggestion-card";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SuggestionsResponse {
  query: string;
  suggestions: KnowledgeSuggestion[];
  noEmbeddingsExist?: boolean;
  embeddingError?: boolean;
  remaining?: number;
}

interface KnowledgeReference {
  entryId: number;
  title: string;
  category: string;
  department: string | null;
  version: number;
  updatedAt: string;
  sourceRef: string;
}

interface GenerateReportResponse {
  report: string;
  knowledgeReferences: KnowledgeReference[];
  entryCount: number;
  skippedCount: number;
  usedEntryIds: number[];
}

type PanelStep = "query" | "select" | "report";

export interface KnowledgeReportPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function KnowledgeReportPanel({ open, onOpenChange }: KnowledgeReportPanelProps) {
  const [step, setStep] = useState<PanelStep>("query");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [suggestions, setSuggestions] = useState<KnowledgeSuggestion[]>([]);
  const [noEmbeddings, setNoEmbeddings] = useState(false);
  const [report, setReport] = useState<GenerateReportResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // ── Reset on close ──────────────────────────────────────────────────────────
  const handleOpenChange = useCallback(
    (val: boolean) => {
      if (!val) {
        setStep("query");
        setQuery("");
        setSelectedIds(new Set());
        setSuggestions([]);
        setNoEmbeddings(false);
        setReport(null);
        setCopied(false);
        setFindError(null);
        setGenerateError(null);
      }
      onOpenChange(val);
    },
    [onOpenChange],
  );

  // ── Find suggestions mutation ───────────────────────────────────────────────
  const findMutation = useMutation<SuggestionsResponse, Error, string>({
    mutationFn: async (q: string) => {
      const res = await fetch("/api/vault/knowledge-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ query: q, limit: 8 }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Failed to find knowledge suggestions");
      }
      return res.json() as Promise<SuggestionsResponse>;
    },
    onSuccess: (data) => {
      setSuggestions(data.suggestions);
      setNoEmbeddings(data.noEmbeddingsExist ?? false);
      setSelectedIds(new Set());
      setStep("select");
      setFindError(null);
    },
    onError: (err) => {
      setFindError(err.message);
    },
  });

  // ── Generate report mutation ────────────────────────────────────────────────
  const generateMutation = useMutation<GenerateReportResponse, Error, number[]>({
    mutationFn: async (ids: number[]) => {
      const res = await fetch("/api/vault/generate-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          query,
          selectedEntryIds: ids,
          title: query.slice(0, 100),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Report generation failed");
      }
      return res.json() as Promise<GenerateReportResponse>;
    },
    onSuccess: (data) => {
      setReport(data);
      setStep("report");
      setGenerateError(null);
    },
    onError: (err) => {
      setGenerateError(err.message);
    },
  });

  const handleToggle = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCopy = useCallback(async () => {
    if (!report?.report) return;
    await navigator.clipboard.writeText(report.report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [report]);

  const handleFindRelated = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    setFindError(null);
    findMutation.mutate(q);
  }, [query, findMutation]);

  const handleGenerate = useCallback(
    (ids: number[]) => {
      setGenerateError(null);
      generateMutation.mutate(ids);
    },
    [generateMutation],
  );

  const isFinding = findMutation.isPending;
  const isGenerating = generateMutation.isPending;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="w-full sm:w-[520px] sm:max-w-none flex flex-col p-0">
        {/* Header */}
        <SheetHeader className="px-5 pt-5 pb-4 border-b border-border/60 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <SheetTitle className="text-sm font-semibold text-foreground leading-tight">
                Generate Knowledge Report
              </SheetTitle>
              <SheetDescription className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                {step === "query" && "Describe the report you need"}
                {step === "select" && "Select which knowledge entries to include"}
                {step === "report" && "Your AI-generated report"}
              </SheetDescription>
            </div>
          </div>

          {/* Step breadcrumb */}
          <div className="flex items-center gap-1.5 mt-3">
            {(["query", "select", "report"] as PanelStep[]).map((s, i) => (
              <div key={s} className="flex items-center gap-1.5">
                <div
                  className={cn(
                    "w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold",
                    step === s
                      ? "bg-primary text-primary-foreground"
                      : ["select", "report"].includes(step) &&
                          ["query", ...(step === "report" ? ["select"] : [])].includes(s)
                        ? "bg-primary/30 text-primary"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {i + 1}
                </div>
                <span
                  className={cn(
                    "text-[10px] font-medium",
                    step === s ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {s === "query" ? "Query" : s === "select" ? "Select" : "Report"}
                </span>
                {i < 2 && <span className="text-muted-foreground/40 text-[10px]">/</span>}
              </div>
            ))}
          </div>
        </SheetHeader>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* ── Step 1: Query ── */}
          {step === "query" && (
            <div className="px-5 py-5 space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">
                  What report do you need?
                </label>
                <Textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleFindRelated();
                  }}
                  placeholder="e.g. Operations review for Q2 downtime incidents, WBI corrective actions summary, best practices for seal maintenance…"
                  className="min-h-[120px] resize-none text-sm"
                  autoFocus
                />
                <p className="text-[11px] text-muted-foreground">
                  Press <kbd className="px-1 py-0.5 rounded bg-muted border text-[10px]">⌘ Enter</kbd> or
                  click below to find relevant knowledge.
                </p>
              </div>

              {findError && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3">
                  <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  <p className="text-xs text-destructive">{findError}</p>
                </div>
              )}

              <Button
                onClick={handleFindRelated}
                disabled={!query.trim() || isFinding}
                className="w-full"
                size="sm"
              >
                {isFinding ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Finding related knowledge…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" />
                    Find related knowledge
                  </>
                )}
              </Button>
            </div>
          )}

          {/* ── Step 2: Select ── */}
          {step === "select" && (
            <div className="px-5 py-5 space-y-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep("query")}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <div className="flex-1" />
                {selectedIds.size > 0 && (
                  <span className="text-[11px] text-primary font-medium">
                    {selectedIds.size} selected
                  </span>
                )}
              </div>

              <div className="rounded-md bg-muted/30 border border-border/50 px-3 py-2">
                <p className="text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">Query: </span>
                  {query}
                </p>
              </div>

              {noEmbeddings ? (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <BookOpen className="h-10 w-10 text-muted-foreground/40" />
                  <div>
                    <p className="text-sm font-medium text-foreground">No indexed knowledge</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Go to the Knowledge Vault and reindex your entries to enable semantic search.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleGenerate([])}
                      disabled={isGenerating}
                    >
                      {isGenerating ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Generate without knowledge"
                      )}
                    </Button>
                  </div>
                </div>
              ) : suggestions.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <Sparkles className="h-10 w-10 text-muted-foreground/40" />
                  <div>
                    <p className="text-sm font-medium text-foreground">No matches found</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      No vault entries matched this query. You can still generate the report.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleGenerate([])}
                    disabled={isGenerating}
                  >
                    {isGenerating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "Generate without knowledge"
                    )}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-foreground">
                        Relevant knowledge found
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedIds(
                            selectedIds.size === suggestions.length
                              ? new Set()
                              : new Set(suggestions.map((s) => s.entryId)),
                          )
                        }
                        className="text-[11px] text-primary hover:text-primary/80 transition-colors"
                      >
                        {selectedIds.size === suggestions.length ? "Deselect all" : "Select all"}
                      </button>
                    </div>
                    <div className="space-y-2">
                      {suggestions.map((s) => (
                        <KnowledgeSuggestionCard
                          key={s.entryId}
                          suggestion={s}
                          selected={selectedIds.has(s.entryId)}
                          onToggle={() => handleToggle(s.entryId)}
                        />
                      ))}
                    </div>
                  </div>

                  {generateError && (
                    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3">
                      <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                      <p className="text-xs text-destructive">{generateError}</p>
                    </div>
                  )}

                  <div className="flex gap-2 pt-1">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleGenerate([])}
                      disabled={isGenerating}
                    >
                      {isGenerating && selectedIds.size === 0 ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Without knowledge"
                      )}
                    </Button>
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => handleGenerate(Array.from(selectedIds))}
                      disabled={isGenerating || selectedIds.size === 0}
                    >
                      {isGenerating && selectedIds.size > 0 ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Generating…
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                          Generate with {selectedIds.size} {selectedIds.size === 1 ? "entry" : "entries"}
                        </>
                      )}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Step 3: Report ── */}
          {step === "report" && report && (
            <div className="px-5 py-5 space-y-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep("select")}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs px-2.5"
                  onClick={handleCopy}
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5 mr-1.5 text-green-400" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5 mr-1.5" />
                      Copy
                    </>
                  )}
                </Button>
              </div>

              {report.entryCount > 0 && (
                <div className="flex items-center gap-1.5 rounded-md bg-primary/8 border border-primary/20 px-3 py-2">
                  <BookOpen className="h-3.5 w-3.5 text-primary shrink-0" />
                  <p className="text-[11px] text-primary">
                    Generated using {report.entryCount} Knowledge Vault{" "}
                    {report.entryCount === 1 ? "entry" : "entries"}
                    {report.skippedCount > 0 && ` (${report.skippedCount} skipped)`}
                  </p>
                </div>
              )}

              {/* Report text */}
              <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-muted/20">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                    Report
                  </span>
                </div>
                <div className="p-4">
                  <ReportText text={report.report} />
                </div>
              </div>

              {/* References */}
              {report.knowledgeReferences.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Knowledge Vault References Used
                  </p>
                  <div className="space-y-1.5">
                    {report.knowledgeReferences.map((ref) => (
                      <div
                        key={ref.entryId}
                        className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 space-y-0.5"
                      >
                        <p className="text-xs font-medium text-foreground">{ref.title}</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[10px] text-muted-foreground">
                            {ref.category}
                          </span>
                          {ref.department && (
                            <span className="text-[10px] text-muted-foreground/70">
                              {ref.department}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground/50">
                            v{ref.version}
                          </span>
                          <span className="text-[10px] text-muted-foreground/40 font-mono">
                            {ref.sourceRef}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => {
                  setStep("query");
                  setReport(null);
                  setQuery("");
                  setSelectedIds(new Set());
                  setSuggestions([]);
                  setFindError(null);
                  setGenerateError(null);
                }}
              >
                Generate another report
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── ReportText: render markdown-ish report as structured HTML ─────────────────

function ReportText({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line) {
      elements.push(<div key={i} className="h-3" />);
    } else if (line.startsWith("## ")) {
      elements.push(
        <h2 key={i} className="text-sm font-semibold text-foreground mt-3 mb-1">
          {line.slice(3)}
        </h2>,
      );
    } else if (line.startsWith("# ")) {
      elements.push(
        <h1 key={i} className="text-base font-bold text-foreground mt-1 mb-2">
          {line.slice(2)}
        </h1>,
      );
    } else if (line.startsWith("### ")) {
      elements.push(
        <h3 key={i} className="text-xs font-semibold text-foreground mt-2 mb-0.5">
          {line.slice(4)}
        </h3>,
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(
        <div key={i} className="flex gap-2 text-xs text-foreground/90 leading-relaxed pl-1">
          <span className="text-muted-foreground mt-0.5 shrink-0">•</span>
          <span>{renderInline(line.slice(2))}</span>
        </div>,
      );
    } else if (/^\d+\. /.test(line)) {
      const match = line.match(/^(\d+)\. (.*)$/);
      if (match) {
        elements.push(
          <div key={i} className="flex gap-2 text-xs text-foreground/90 leading-relaxed pl-1">
            <span className="text-muted-foreground mt-0.5 shrink-0 tabular-nums">
              {match[1]}.
            </span>
            <span>{renderInline(match[2])}</span>
          </div>,
        );
      }
    } else if (line.startsWith("---") || line.startsWith("═══")) {
      elements.push(<hr key={i} className="border-border/40 my-2" />);
    } else {
      elements.push(
        <p key={i} className="text-xs text-foreground/90 leading-relaxed">
          {renderInline(line)}
        </p>,
      );
    }
  }

  return <div className="space-y-0.5">{elements}</div>;
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
}
