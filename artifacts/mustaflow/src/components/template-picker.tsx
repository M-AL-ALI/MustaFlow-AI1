import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Rocket,
  Briefcase,
  LayoutDashboard,
  ShoppingCart,
  BookOpen,
  CalendarCheck,
  FileText,
  Columns,
  Calendar,
  UtensilsCrossed,
  Shield,
  Bot,
  CreditCard,
  Search,
  Activity,
  Link,
  PencilLine,
  X,
  Smartphone,
  MessageSquare,
  Building2,
  Palette,
  GraduationCap,
  Wrench,
  Heart,
  Star,
  ArrowRight,
  Clock,
  BookmarkPlus,
  Trash2,
  Package,
} from "lucide-react";
import {
  TEMPLATES,
  TEMPLATE_CATEGORIES,
  CATEGORY_COLORS,
  type TemplateDefinition,
  type TemplateCategory,
} from "@/lib/templates";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Rocket,
  Briefcase,
  LayoutDashboard,
  ShoppingCart,
  BookOpen,
  CalendarCheck,
  FileText,
  Columns,
  Calendar,
  UtensilsCrossed,
  Shield,
  Bot,
  CreditCard,
  Search,
  Activity,
  Link,
  Smartphone,
  MessageSquare,
  Building2,
  Palette,
  GraduationCap,
  Wrench,
  Heart,
  Star,
};

const RECENTLY_USED_KEY = "mustaflow_recent_templates";
const MAX_RECENT = 5;

function getRecentTemplateIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENTLY_USED_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export function recordTemplateUsed(templateId: string): void {
  try {
    const recent = getRecentTemplateIds().filter((id) => id !== templateId);
    recent.unshift(templateId);
    localStorage.setItem(RECENTLY_USED_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    // localStorage not available — no-op
  }
}

const MY_TEMPLATES_KEY = "mustaflow_my_templates";

export interface PersonalTemplate extends TemplateDefinition {
  savedAt: string;
  sourceProjectId?: number;
}

export function getPersonalTemplates(): PersonalTemplate[] {
  try {
    const raw = localStorage.getItem(MY_TEMPLATES_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as PersonalTemplate[];
  } catch {
    return [];
  }
}

export function savePersonalTemplate(template: PersonalTemplate): void {
  try {
    const existing = getPersonalTemplates().filter((t) => t.id !== template.id);
    existing.unshift(template);
    localStorage.setItem(MY_TEMPLATES_KEY, JSON.stringify(existing));
  } catch {
    // no-op
  }
}

export function deletePersonalTemplate(id: string): void {
  try {
    const existing = getPersonalTemplates().filter((t) => t.id !== id);
    localStorage.setItem(MY_TEMPLATES_KEY, JSON.stringify(existing));
  } catch {
    // no-op
  }
}

type TabView = "all" | "my-templates";

interface TemplatePickerProps {
  selectedId?: string;
  onSelect: (template: TemplateDefinition) => void;
  onStartFromScratch?: () => void;
  compact?: boolean;
  filterPlatform?: "web" | "mobile";
}

export function TemplatePicker({
  selectedId,
  onSelect,
  onStartFromScratch,
  compact = false,
  filterPlatform,
}: TemplatePickerProps) {
  const MOBILE_KINDS = ["mobile-cross", "mobile-ios", "mobile-android"];
  const [activeCategory, setActiveCategory] = useState<TemplateCategory | "All">("All");
  const [search, setSearch] = useState("");
  const [tabView, setTabView] = useState<TabView>("all");
  const [previewTemplate, setPreviewTemplate] = useState<TemplateDefinition | null>(null);
  const [personalTemplates, setPersonalTemplates] =
    useState<PersonalTemplate[]>(getPersonalTemplates);

  const recentIds = getRecentTemplateIds();
  const recentTemplates = recentIds
    .map((id) => TEMPLATES.find((t) => t.id === id))
    .filter(Boolean) as TemplateDefinition[];

  const filtered = TEMPLATES.filter((t) => {
    if (filterPlatform === "mobile" && !MOBILE_KINDS.includes(t.projectKind)) return false;
    if (filterPlatform === "web" && MOBILE_KINDS.includes(t.projectKind)) return false;
    const matchesCategory = activeCategory === "All" || t.category === activeCategory;
    const matchesSearch =
      search.trim() === "" ||
      t.title.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase()) ||
      t.category.toLowerCase().includes(search.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const cards = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-template-card]"),
    );
    const idx = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (idx === -1) return;

    if (e.key === "ArrowRight" && idx < cards.length - 1) {
      cards[idx + 1]?.focus();
      e.preventDefault();
    } else if (e.key === "ArrowLeft" && idx > 0) {
      cards[idx - 1]?.focus();
      e.preventDefault();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const firstTop = cards[0]?.getBoundingClientRect().top ?? 0;
      const cols =
        cards.filter((c) => Math.abs(c.getBoundingClientRect().top - firstTop) < 4).length || 1;
      const target = e.key === "ArrowDown" ? cards[idx + cols] : cards[idx - cols];
      if (target) {
        target.focus();
        e.preventDefault();
      }
    }
  }, []);

  function handleSelect(template: TemplateDefinition) {
    recordTemplateUsed(template.id);
    onSelect(template);
  }

  function handleDeletePersonal(id: string) {
    deletePersonalTemplate(id);
    setPersonalTemplates(getPersonalTemplates());
  }

  const templatesToShow = tabView === "my-templates" ? personalTemplates : filtered;

  return (
    <div className="flex gap-4">
      {/* Left panel: list */}
      <div className={cn("flex flex-col gap-4", previewTemplate ? "flex-1 min-w-0" : "w-full")}>
        {/* Tab toggle + search row */}
        <div className="flex items-center gap-2">
          {/* Tab toggle */}
          <div className="flex items-center bg-muted border border-border rounded-lg p-0.5 gap-0.5 shrink-0">
            <button
              type="button"
              onClick={() => setTabView("all")}
              className={cn(
                "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                tabView === "all"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setTabView("my-templates")}
              className={cn(
                "flex items-center gap-1 px-3 py-1 rounded-md text-xs font-medium transition-colors",
                tabView === "my-templates"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <BookmarkPlus className="h-3 w-3" />
              Saved
              {personalTemplates.length > 0 && (
                <span className="ml-0.5 rounded-full bg-primary/20 text-primary px-1.5 text-[10px] font-bold">
                  {personalTemplates.length}
                </span>
              )}
            </button>
          </div>

          {tabView === "all" && (
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search templates…"
                className="pl-8 h-8 text-sm"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}

          {onStartFromScratch && tabView === "all" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 text-xs gap-1.5"
              onClick={onStartFromScratch}
            >
              <PencilLine className="h-3.5 w-3.5" />
              Scratch
            </Button>
          )}
        </div>

        {/* My Templates empty state */}
        {tabView === "my-templates" && personalTemplates.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground gap-2">
            <BookmarkPlus className="h-8 w-8 opacity-30" />
            <p className="text-sm font-medium">No saved templates yet</p>
            <p className="text-xs max-w-xs">
              From any project's Manage tab, use "Save as Template" to create a reusable starting
              point.
            </p>
          </div>
        )}

        {/* Category filter (all tab only) */}
        {tabView === "all" && !search && (
          <div className="flex gap-1.5 flex-wrap">
            {(["All", ...TEMPLATE_CATEGORIES] as const).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setActiveCategory(cat)}
                className={cn(
                  "px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
                  activeCategory === cat
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground bg-card hover:text-foreground hover:border-border/80 hover:bg-muted",
                )}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* Recent templates (shown when not searching and not in "my" tab) */}
        {tabView === "all" && !search && activeCategory === "All" && recentTemplates.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Recently used
            </p>
            <div className="flex gap-2 flex-wrap">
              {recentTemplates.map((t) => {
                const Icon = ICON_MAP[t.icon] ?? Rocket;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => handleSelect(t)}
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors",
                      selectedId === t.id
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted",
                    )}
                  >
                    <Icon className="h-3 w-3 shrink-0" />
                    {t.title}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Template grid */}
        {tabView === "all" && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground gap-2">
            <Search className="h-8 w-8 opacity-30" />
            <p className="text-sm font-medium">No templates match your search</p>
            <p className="text-xs">Try a different keyword or category</p>
          </div>
        )}

        {templatesToShow.length > 0 && (
          <div
            className={cn("grid gap-3", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3")}
            onKeyDown={handleKeyDown}
            role="list"
            aria-label="Template gallery"
          >
            {templatesToShow.map((template) => {
              const Icon = ICON_MAP[template.icon] ?? Rocket;
              const isSelected = selectedId === template.id;
              const isPreviewing = previewTemplate?.id === template.id;
              const isPersonal = tabView === "my-templates";

              return (
                <div key={template.id} className="relative group/card">
                  <button
                    type="button"
                    data-template-card
                    role="listitem"
                    aria-label={`${template.title}: ${template.description}`}
                    aria-pressed={isSelected}
                    onClick={() => setPreviewTemplate(isPreviewing ? null : template)}
                    className={cn(
                      "w-full relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                      isSelected
                        ? "border-primary bg-primary/10 ring-1 ring-primary"
                        : isPreviewing
                          ? "border-primary/60 bg-primary/5"
                          : "border-border bg-card hover:border-primary/40 hover:bg-muted",
                    )}
                  >
                    {template.isStarterPack && (
                      <div className="absolute top-2 right-2">
                        <Package className="h-3 w-3 text-amber-400" />
                      </div>
                    )}
                    <div className="flex items-start justify-between gap-2">
                      <div
                        className={cn(
                          "rounded-lg p-1.5 border",
                          isSelected || isPreviewing
                            ? "bg-primary/20 text-primary border-primary/30"
                            : "bg-muted text-muted-foreground border-border group-hover/card:text-foreground",
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none shrink-0",
                          CATEGORY_COLORS[template.category],
                        )}
                      >
                        {template.category === "Starter Packs" ? "Pack" : template.category}
                      </span>
                    </div>
                    <div>
                      <p
                        className={cn(
                          "text-sm font-semibold leading-snug",
                          isSelected || isPreviewing ? "text-primary" : "text-foreground",
                        )}
                      >
                        {template.title}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                        {template.description}
                      </p>
                    </div>
                  </button>

                  {/* Delete button for personal templates */}
                  {isPersonal && (
                    <button
                      type="button"
                      aria-label={`Delete ${template.title}`}
                      onClick={() => handleDeletePersonal(template.id)}
                      className="absolute top-1.5 left-1.5 opacity-0 group-hover/card:opacity-100 transition-opacity rounded-md p-1 bg-destructive/10 text-destructive hover:bg-destructive/20"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Right panel: preview */}
      {previewTemplate && (
        <TemplatePreviewPanel
          template={previewTemplate}
          onUse={() => handleSelect(previewTemplate)}
          onClose={() => setPreviewTemplate(null)}
          isSelected={selectedId === previewTemplate.id}
        />
      )}
    </div>
  );
}

function TemplatePreviewPanel({
  template,
  onUse,
  onClose,
  isSelected,
}: {
  template: TemplateDefinition;
  onUse: () => void;
  onClose: () => void;
  isSelected: boolean;
}) {
  const Icon = ICON_MAP[template.icon] ?? Rocket;

  const highlights = extractHighlights(template.seedPrompt);

  return (
    <div className="w-56 shrink-0 flex flex-col rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 p-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <div className="rounded-lg p-1.5 border bg-primary/10 text-primary border-primary/20 shrink-0">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight truncate">{template.title}</p>
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium leading-none mt-0.5",
                CATEGORY_COLORS[template.category],
              )}
            >
              {template.category}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="text-muted-foreground hover:text-foreground shrink-0 mt-0.5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Visual mockup */}
      <TemplateMockup template={template} />

      {/* Description + highlights */}
      <div className="p-3 flex flex-col gap-2 flex-1">
        <p className="text-xs text-muted-foreground leading-relaxed">{template.description}</p>

        {highlights.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Includes
            </p>
            <ul className="flex flex-col gap-1">
              {highlights.map((h, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-foreground/80">
                  <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-primary/60 shrink-0" />
                  {h}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* CTA */}
      <div className="p-3 pt-0">
        <Button type="button" size="sm" className="w-full gap-1.5" onClick={onUse}>
          {isSelected ? "Template selected" : "Use this template"}
          {!isSelected && <ArrowRight className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

function TemplateMockup({ template }: { template: TemplateDefinition }) {
  const style = getMockupStyle(template);

  return (
    <div
      className="h-28 w-full relative overflow-hidden shrink-0 border-b border-border"
      style={{ background: style.bg }}
      aria-hidden="true"
    >
      {/* Simulated browser bar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-white/10 bg-black/20">
        <div className="h-1.5 w-1.5 rounded-full bg-red-400/70" />
        <div className="h-1.5 w-1.5 rounded-full bg-yellow-400/70" />
        <div className="h-1.5 w-1.5 rounded-full bg-green-400/70" />
        <div className="flex-1 h-1.5 rounded-full bg-white/10 ml-1" />
      </div>

      {/* Mockup content based on template type */}
      <div className="px-2 pt-1.5 space-y-1">
        {style.elements.map((el, i) => (
          <div
            key={i}
            className="rounded"
            style={{
              height: el.height,
              width: el.width,
              background: el.color,
              opacity: el.opacity ?? 1,
            }}
          />
        ))}
      </div>

      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent pointer-events-none" />
    </div>
  );
}

interface MockupElement {
  height: number | string;
  width: string;
  color: string;
  opacity?: number;
}

interface MockupStyle {
  bg: string;
  elements: MockupElement[];
}

function getMockupStyle(template: TemplateDefinition): MockupStyle {
  const byCategory: Record<string, MockupStyle> = {
    "Starter Packs": {
      bg: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
      elements: [
        { height: 18, width: "75%", color: "rgba(255,255,255,0.85)", opacity: 0.9 },
        { height: 8, width: "50%", color: "rgba(255,255,255,0.4)" },
        { height: 12, width: "40%", color: "#e3933a", opacity: 0.9 },
        { height: 20, width: "100%", color: "rgba(255,255,255,0.05)" },
        { height: 8, width: "60%", color: "rgba(255,255,255,0.2)" },
      ],
    },
    Marketing: {
      bg: "linear-gradient(135deg, #0a0a1a 0%, #1a0a2e 100%)",
      elements: [
        { height: 16, width: "80%", color: "rgba(139,92,246,0.9)" },
        { height: 8, width: "60%", color: "rgba(255,255,255,0.4)" },
        { height: 14, width: "35%", color: "rgba(139,92,246,0.8)" },
        { height: 16, width: "100%", color: "rgba(255,255,255,0.04)" },
        { height: 8, width: "55%", color: "rgba(255,255,255,0.15)" },
      ],
    },
    Portfolio: {
      bg: "linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 100%)",
      elements: [
        { height: 20, width: "65%", color: "rgba(255,255,255,0.9)" },
        { height: 6, width: "40%", color: "rgba(255,255,255,0.35)" },
        { height: 16, width: "100%", color: "rgba(255,255,255,0.03)" },
        { height: 8, width: "70%", color: "rgba(255,255,255,0.12)" },
        { height: 6, width: "45%", color: "rgba(255,255,255,0.08)" },
      ],
    },
    SaaS: {
      bg: "linear-gradient(135deg, #0a1628 0%, #0d1f3c 100%)",
      elements: [
        { height: 14, width: "100%", color: "rgba(14,165,233,0.15)" },
        { height: 6, width: "50%", color: "rgba(14,165,233,0.5)" },
        { height: 20, width: "100%", color: "rgba(14,165,233,0.06)" },
        { height: 8, width: "30%", color: "rgba(14,165,233,0.3)" },
        { height: 8, width: "30%", color: "rgba(14,165,233,0.3)" },
      ],
    },
    "E-commerce": {
      bg: "linear-gradient(135deg, #ffffff 0%, #f3f4f6 100%)",
      elements: [
        { height: 14, width: "100%", color: "rgba(0,0,0,0.06)" },
        { height: 24, width: "100%", color: "rgba(16,185,129,0.15)" },
        { height: 6, width: "40%", color: "rgba(0,0,0,0.2)" },
        { height: 14, width: "100%", color: "rgba(0,0,0,0.04)" },
        { height: 8, width: "55%", color: "rgba(16,185,129,0.5)" },
      ],
    },
    Content: {
      bg: "linear-gradient(135deg, #fafafa 0%, #f0f0f0 100%)",
      elements: [
        { height: 12, width: "100%", color: "rgba(0,0,0,0.07)" },
        { height: 10, width: "70%", color: "rgba(0,0,0,0.5)" },
        { height: 6, width: "55%", color: "rgba(0,0,0,0.2)" },
        { height: 6, width: "80%", color: "rgba(0,0,0,0.1)" },
        { height: 6, width: "65%", color: "rgba(0,0,0,0.1)" },
      ],
    },
    "Business Tools": {
      bg: "linear-gradient(135deg, #1e3a5f 0%, #152d4a 100%)",
      elements: [
        { height: 14, width: "100%", color: "rgba(255,255,255,0.08)" },
        { height: 8, width: "55%", color: "rgba(255,255,255,0.5)" },
        { height: 18, width: "100%", color: "rgba(59,130,246,0.2)" },
        { height: 6, width: "40%", color: "rgba(59,130,246,0.6)" },
        { height: 6, width: "30%", color: "rgba(255,255,255,0.2)" },
      ],
    },
    Productivity: {
      bg: "linear-gradient(135deg, #1a0a0a 0%, #2d1515 100%)",
      elements: [
        { height: 10, width: "100%", color: "rgba(239,68,68,0.15)" },
        { height: 18, width: "24%", color: "rgba(255,255,255,0.1)" },
        { height: 18, width: "24%", color: "rgba(255,255,255,0.1)" },
        { height: 18, width: "24%", color: "rgba(255,255,255,0.1)" },
        { height: 6, width: "60%", color: "rgba(239,68,68,0.4)" },
      ],
    },
    AI: {
      bg: "linear-gradient(135deg, #0d0d1a 0%, #1a0d2e 100%)",
      elements: [
        { height: 10, width: "100%", color: "rgba(139,92,246,0.08)" },
        { height: 16, width: "75%", color: "rgba(139,92,246,0.2)" },
        { height: 10, width: "50%", color: "rgba(255,255,255,0.1)" },
        { height: 14, width: "85%", color: "rgba(139,92,246,0.15)" },
        { height: 6, width: "30%", color: "rgba(139,92,246,0.5)" },
      ],
    },
    Mobile: {
      bg: "linear-gradient(135deg, #0a1628 0%, #0d1f3c 100%)",
      elements: [
        { height: 6, width: "40%", color: "rgba(255,255,255,0.5)" },
        { height: 20, width: "100%", color: "rgba(34,197,94,0.15)" },
        { height: 8, width: "60%", color: "rgba(255,255,255,0.2)" },
        { height: 8, width: "100%", color: "rgba(255,255,255,0.05)" },
        { height: 10, width: "40%", color: "rgba(34,197,94,0.4)" },
      ],
    },
  };

  return byCategory[template.category] ?? byCategory["Marketing"]!;
}

function extractHighlights(seedPrompt: string): string[] {
  const highlights: string[] = [];

  const patterns = [
    /(\w[\w\s]{3,30})\s+(?:section|page|screen|panel|view|tab)/gi,
    /(?:include|add|show|build)\s+(?:a\s+)?([A-Z][\w\s]{5,30}?)(?:\s+with|\s+that|\s+and|\.)/gi,
  ];

  const seen = new Set<string>();
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(seedPrompt)) !== null) {
      const text = match[1]?.trim() ?? "";
      const cleaned = text
        .replace(/^\s*(and|with|a|an|the)\s+/i, "")
        .trim()
        .toLowerCase();
      if (cleaned.length > 4 && cleaned.length < 30 && !seen.has(cleaned)) {
        seen.add(cleaned);
        highlights.push(cleaned.charAt(0).toUpperCase() + cleaned.slice(1));
        if (highlights.length >= 5) break;
      }
    }
    if (highlights.length >= 5) break;
  }

  return highlights.slice(0, 5);
}
