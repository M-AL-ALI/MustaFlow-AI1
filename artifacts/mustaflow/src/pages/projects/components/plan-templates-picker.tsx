import { authFetch } from "@/lib/api-fetch";
import { useState, useEffect, useMemo } from "react";
import {
  X,
  Search,
  LayoutDashboard,
  ShoppingBag,
  FileText,
  Globe,
  Wrench,
  ListChecks,
  CalendarDays,
  User,
  Brain,
  Users,
  ChevronRight,
  Sparkles,
  ArrowLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { StructuredPlan } from "./plan-card";

type PlanTemplate = {
  id: number;
  slug: string;
  category: string;
  name: string;
  description: string;
  platform: string;
  plan: StructuredPlan;
  sortOrder: number;
};

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  SaaS: LayoutDashboard,
  Marketing: Globe,
  "E-commerce": ShoppingBag,
  Content: FileText,
  "Internal Tools": Wrench,
  Productivity: ListChecks,
  Services: CalendarDays,
  Personal: User,
  AI: Brain,
  Social: Users,
};

function getCategoryIcon(category: string): React.ElementType {
  return CATEGORY_ICONS[category] ?? Globe;
}

interface PlanTemplatesPickerProps {
  projectId: number;
  onSelect: (plan: StructuredPlan, name: string) => void;
  onClose: () => void;
}

export function PlanTemplatesPicker({
  projectId: _projectId,
  onSelect,
  onClose,
}: PlanTemplatesPickerProps) {
  const [templates, setTemplates] = useState<PlanTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<PlanTemplate | null>(null);

  useEffect(() => {
    setLoading(true);
    authFetch("/api/plan-templates", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error("Failed to load templates");
        const data = (await r.json()) as PlanTemplate[];
        setTemplates(data);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const categories = useMemo(
    () => Array.from(new Set(templates.map((t) => t.category))),
    [templates],
  );

  const filtered = useMemo(() => {
    let list = templates;
    if (selectedCategory) list = list.filter((t) => t.category === selectedCategory);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q),
      );
    }
    return list;
  }, [templates, selectedCategory, search]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
      <div
        className="bg-background border border-border rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl"
        role="dialog"
        aria-label="Plan Templates"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          {previewTemplate ? (
            <button
              onClick={() => setPreviewTemplate(null)}
              className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              aria-label="Back to templates"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : (
            <Sparkles className="h-4 w-4 text-primary shrink-0" />
          )}
          <span className="font-semibold text-sm flex-1">
            {previewTemplate ? previewTemplate.name : "Start from a template"}
          </span>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Preview mode */}
        {previewTemplate ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <p className="text-sm text-muted-foreground">{previewTemplate.description}</p>

            {previewTemplate.plan.goal && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                  Goal
                </div>
                <p className="text-sm text-foreground">{previewTemplate.plan.goal}</p>
              </div>
            )}

            {previewTemplate.plan.sitemap && previewTemplate.plan.sitemap.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                  Pages ({previewTemplate.plan.sitemap.length})
                </div>
                <div className="space-y-1">
                  {previewTemplate.plan.sitemap.map((page, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className="font-mono text-muted-foreground shrink-0 text-[10px] mt-0.5 w-16 truncate">
                        {page.route}
                      </span>
                      <div>
                        <span className="font-medium text-foreground">{page.name}</span>
                        {page.purpose && (
                          <span className="text-muted-foreground ml-1">— {page.purpose}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {previewTemplate.plan.integrations && previewTemplate.plan.integrations.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                  Integrations
                </div>
                <div className="flex flex-wrap gap-1">
                  {previewTemplate.plan.integrations.map((i, idx) => (
                    <span
                      key={idx}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground"
                    >
                      {i}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              {previewTemplate.plan.complexityScore && (
                <span>Complexity: {previewTemplate.plan.complexityScore}/10</span>
              )}
              {previewTemplate.plan.recommendedMode && (
                <span>Recommended mode: {previewTemplate.plan.recommendedMode}</span>
              )}
              {previewTemplate.plan.estimatedBuildSeconds && (
                <span>~{previewTemplate.plan.estimatedBuildSeconds}s to build</span>
              )}
            </div>

            <button
              onClick={() => {
                onSelect(previewTemplate.plan, previewTemplate.name);
                onClose();
              }}
              className="w-full h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors flex items-center justify-center gap-1.5"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Use this template
            </button>
          </div>
        ) : (
          <>
            {/* Search + Category filter */}
            <div className="px-3 py-2 border-b border-border shrink-0 space-y-2">
              <div className="flex items-center gap-2 bg-muted rounded-lg px-2 py-1.5">
                <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search templates…"
                  className="flex-1 bg-transparent text-sm focus:outline-none text-foreground placeholder:text-muted-foreground/60"
                  autoFocus
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <div className="flex gap-1 flex-wrap">
                <button
                  onClick={() => setSelectedCategory(null)}
                  className={cn(
                    "text-[10px] px-2 py-0.5 rounded-md border transition-colors",
                    selectedCategory === null
                      ? "bg-primary/10 text-primary border-primary/30"
                      : "text-muted-foreground border-border hover:text-foreground",
                  )}
                >
                  All
                </button>
                {categories.map((cat) => {
                  const Icon = getCategoryIcon(cat);
                  return (
                    <button
                      key={cat}
                      onClick={() => setSelectedCategory(cat === selectedCategory ? null : cat)}
                      className={cn(
                        "flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md border transition-colors",
                        selectedCategory === cat
                          ? "bg-primary/10 text-primary border-primary/30"
                          : "text-muted-foreground border-border hover:text-foreground",
                      )}
                    >
                      <Icon className="h-2.5 w-2.5" />
                      {cat}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Template grid */}
            <div className="flex-1 overflow-y-auto p-3">
              {loading ? (
                <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                  Loading templates…
                </div>
              ) : error ? (
                <div className="flex items-center justify-center h-32 text-sm text-destructive">
                  {error}
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
                  No templates match your search.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {filtered.map((tpl) => {
                    const Icon = getCategoryIcon(tpl.category);
                    return (
                      <div
                        key={tpl.id}
                        className="group relative border border-border rounded-xl p-3 hover:border-primary/40 hover:bg-primary/5 transition-all cursor-pointer"
                        onClick={() => setPreviewTemplate(tpl)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") setPreviewTemplate(tpl);
                        }}
                      >
                        <div className="flex items-start gap-2">
                          <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                            <Icon className="h-3.5 w-3.5 text-primary" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-1">
                              <span className="text-sm font-medium text-foreground truncate">
                                {tpl.name}
                              </span>
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-primary/60 shrink-0 transition-colors" />
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">
                              {tpl.description}
                            </p>
                            <div className="flex items-center gap-2 mt-1.5">
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground">
                                {tpl.category}
                              </span>
                              {tpl.plan.complexityScore && (
                                <span className="text-[9px] text-muted-foreground/60">
                                  Complexity {tpl.plan.complexityScore}/10
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
