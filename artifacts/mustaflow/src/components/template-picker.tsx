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
};

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

  const filtered = TEMPLATES.filter((t) => {
    // Platform filter: "mobile" shows only mobile-* kinds; "web" hides them
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
      // Derive actual column count from rendered card positions rather than
      // hardcoding breakpoint assumptions that may not match the grid CSS.
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

  return (
    <div className="flex flex-col gap-4">
      {/* Search + scratch */}
      <div className="flex items-center gap-2">
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
        {onStartFromScratch && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 text-xs gap-1.5"
            onClick={onStartFromScratch}
          >
            <PencilLine className="h-3.5 w-3.5" />
            Start from scratch
          </Button>
        )}
      </div>

      {/* Category filter */}
      <div className="flex gap-1.5 flex-wrap">
        {(["All", ...TEMPLATE_CATEGORIES] as const).map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setActiveCategory(cat)}
            className={cn(
              "px-3 py-1 rounded-full text-xs font-medium border transition-colors",
              activeCategory === cat
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground bg-card hover:text-foreground hover:border-border/80 hover:bg-muted",
            )}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Template grid */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground gap-2">
          <Search className="h-8 w-8 opacity-30" />
          <p className="text-sm font-medium">No templates match your search</p>
          <p className="text-xs">Try a different keyword or category</p>
        </div>
      ) : (
        <div
          className={cn("grid gap-3", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3")}
          onKeyDown={handleKeyDown}
          role="list"
          aria-label="Template gallery"
        >
          {filtered.map((template) => {
            const Icon = ICON_MAP[template.icon] ?? Rocket;
            const isSelected = selectedId === template.id;
            return (
              <button
                key={template.id}
                type="button"
                data-template-card
                role="listitem"
                aria-label={`${template.title}: ${template.description}`}
                aria-pressed={isSelected}
                onClick={() => onSelect(template)}
                className={cn(
                  "group relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  isSelected
                    ? "border-primary bg-primary/10 ring-1 ring-primary"
                    : "border-border bg-card hover:border-primary/50 hover:bg-muted",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div
                    className={cn(
                      "rounded-lg p-1.5 border",
                      isSelected
                        ? "bg-primary/20 text-primary border-primary/30"
                        : "bg-muted text-muted-foreground border-border group-hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none",
                      CATEGORY_COLORS[template.category],
                    )}
                  >
                    {template.category}
                  </span>
                </div>
                <div>
                  <p
                    className={cn(
                      "text-sm font-semibold leading-snug",
                      isSelected ? "text-primary" : "text-foreground",
                    )}
                  >
                    {template.title}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                    {template.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
