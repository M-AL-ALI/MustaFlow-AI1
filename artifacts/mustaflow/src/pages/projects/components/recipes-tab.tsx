import { useState, useRef, useEffect } from "react";
import {
  Mail,
  CreditCard,
  Send,
  BarChart3,
  LineChart,
  DollarSign,
  Star,
  HelpCircle,
  Sparkles,
  Image,
  Play,
  Search,
  Moon,
  LogIn,
  CalendarPlus,
  MessageCircle,
  MapPin,
  Globe,
  FileSearch,
  X,
  ChevronRight,
  Clock,
  Zap,
  CheckCircle2,
  Loader2,
  ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  RECIPES,
  RECIPE_CATEGORIES,
  RECIPE_CATEGORY_COLORS,
  type RecipeDefinition,
  type RecipeCategory,
  type RecipeField,
} from "@/lib/recipes";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Mail,
  CreditCard,
  Send,
  BarChart3,
  LineChart,
  DollarSign,
  Star,
  HelpCircle,
  Sparkles,
  Image,
  Play,
  Search,
  Moon,
  LogIn,
  CalendarPlus,
  MessageCircle,
  MapPin,
  Globe,
  FileSearch,
};

interface RecipesTabProps {
  projectId: number;
  onApplyRecipe: (prompt: string) => void;
}

type View = "catalog" | "form";

export function RecipesTab({ projectId: _projectId, onApplyRecipe }: RecipesTabProps) {
  const [activeCategory, setActiveCategory] = useState<RecipeCategory | "All">("All");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>("catalog");
  const [selectedRecipe, setSelectedRecipe] = useState<RecipeDefinition | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (view === "form") {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [view]);

  const filtered = RECIPES.filter((r) => {
    const matchesCategory = activeCategory === "All" || r.category === activeCategory;
    const matchesSearch =
      search.trim() === "" ||
      r.title.toLowerCase().includes(search.toLowerCase()) ||
      r.description.toLowerCase().includes(search.toLowerCase()) ||
      r.tags.some((tag) => tag.toLowerCase().includes(search.toLowerCase()));
    return matchesCategory && matchesSearch;
  });

  function openForm(recipe: RecipeDefinition) {
    setSelectedRecipe(recipe);
    setFormValues({});
    setApplied(false);
    setView("form");
  }

  function buildPrompt(recipe: RecipeDefinition, values: Record<string, string>): string {
    let prompt = recipe.promptTemplate;
    for (const [key, value] of Object.entries(values)) {
      const fieldVal = value.trim() || `[${key}]`;
      prompt = prompt.replace(new RegExp(`{{${key}}}`, "g"), fieldVal);
    }
    return prompt;
  }

  function handleApply() {
    if (!selectedRecipe) return;
    const requiredMissing = selectedRecipe.fields
      .filter((f) => f.required && !formValues[f.key]?.trim())
      .map((f) => f.label);
    if (requiredMissing.length > 0) {
      return;
    }
    setApplying(true);
    const prompt = buildPrompt(selectedRecipe, formValues);
    setTimeout(() => {
      onApplyRecipe(prompt);
      setApplied(true);
      setApplying(false);
    }, 300);
  }

  function handleFieldChange(key: string, value: string) {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }

  if (view === "form" && selectedRecipe) {
    return (
      <RecipeForm
        ref={formRef}
        recipe={selectedRecipe}
        values={formValues}
        onChange={handleFieldChange}
        onBack={() => {
          setView("catalog");
          setApplied(false);
        }}
        onApply={handleApply}
        applying={applying}
        applied={applied}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-y-auto">
      {/* Header */}
      <div>
        <h2 className="text-sm font-semibold">Recipes</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          One-click add-ons that drop a feature into your project — no coding required.
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search recipes…"
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

      {/* Category filter */}
      <div className="flex gap-1.5 flex-wrap">
        {(["All", ...RECIPE_CATEGORIES] as const).map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setActiveCategory(cat)}
            className={cn(
              "px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors",
              activeCategory === cat
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground bg-card hover:text-foreground hover:bg-muted",
            )}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Recipe list */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground gap-2">
          <Search className="h-8 w-8 opacity-30" />
          <p className="text-sm font-medium">No recipes match your search</p>
          <p className="text-xs">Try a different keyword or category</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((recipe) => {
            const Icon = ICON_MAP[recipe.icon] ?? Zap;
            return (
              <button
                key={recipe.id}
                type="button"
                onClick={() => openForm(recipe)}
                className="flex items-start gap-3 p-3 rounded-xl border border-border bg-card hover:border-primary/40 hover:bg-muted transition-all text-left group"
              >
                <div className="rounded-lg p-1.5 border bg-muted text-muted-foreground border-border group-hover:text-foreground transition-colors shrink-0 mt-0.5">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{recipe.title}</p>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium leading-none shrink-0",
                        RECIPE_CATEGORY_COLORS[recipe.category],
                      )}
                    >
                      {recipe.category}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                    {recipe.description}
                  </p>
                  <div className="flex items-center gap-3 mt-1.5">
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Clock className="h-3 w-3" />~{recipe.estimatedMinutes} min
                    </span>
                    <DifficultyBadge difficulty={recipe.difficulty} />
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0 mt-1" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DifficultyBadge({ difficulty }: { difficulty: RecipeDefinition["difficulty"] }) {
  const colors = {
    Easy: "text-green-400",
    Medium: "text-amber-400",
    Advanced: "text-red-400",
  };
  return (
    <span className={cn("flex items-center gap-1 text-[10px] font-medium", colors[difficulty])}>
      <Zap className="h-3 w-3" />
      {difficulty}
    </span>
  );
}

const RecipeForm = ({
  recipe,
  values,
  onChange,
  onBack,
  onApply,
  applying,
  applied,
  ref,
}: {
  recipe: RecipeDefinition;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onBack: () => void;
  onApply: () => void;
  applying: boolean;
  applied: boolean;
  ref: React.Ref<HTMLDivElement>;
}) => {
  const Icon = ICON_MAP[recipe.icon] ?? Zap;

  const missingRequired = recipe.fields
    .filter((f) => f.required && !values[f.key]?.trim())
    .map((f) => f.key);

  return (
    <div ref={ref} className="flex flex-col gap-4 p-4 h-full overflow-y-auto">
      {/* Back button + header */}
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground transition-colors mt-0.5"
          aria-label="Back to recipes"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div className="rounded-lg p-1.5 border bg-primary/10 text-primary border-primary/20 shrink-0">
              <Icon className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">{recipe.title}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                <DifficultyBadge difficulty={recipe.difficulty} />
                <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                  <Clock className="h-3 w-3" />~{recipe.estimatedMinutes} min
                </span>
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">{recipe.description}</p>
        </div>
      </div>

      {applied ? (
        <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
          <div className="w-12 h-12 rounded-full bg-green-500/10 border border-green-500/20 flex items-center justify-center">
            <CheckCircle2 className="h-6 w-6 text-green-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-green-400">Recipe applied</p>
            <p className="text-xs text-muted-foreground mt-1">
              The AI is adding this feature to your project now. Check the chat for progress.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onBack} className="mt-2">
            Apply another recipe
          </Button>
        </div>
      ) : (
        <>
          {recipe.fields.length === 0 ? (
            <div className="rounded-xl border border-border bg-muted/30 p-4 text-center">
              <p className="text-sm text-muted-foreground">
                This recipe has no required configuration — it will be applied directly to your
                project.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-muted-foreground">
                Fill in a few details and the AI will customize the feature for your project.
              </p>
              {recipe.fields.map((field) => (
                <RecipeFieldInput
                  key={field.key}
                  field={field}
                  value={values[field.key] ?? ""}
                  onChange={(v) => onChange(field.key, v)}
                  hasError={field.required ? missingRequired.includes(field.key) : false}
                />
              ))}
            </div>
          )}

          <div className="mt-auto pt-2">
            <Button
              type="button"
              className="w-full gap-2"
              onClick={onApply}
              disabled={applying || missingRequired.length > 0}
            >
              {applying ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending to AI…
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4" />
                  Apply Recipe
                </>
              )}
            </Button>
            {missingRequired.length > 0 && (
              <p className="text-[11px] text-muted-foreground text-center mt-2">
                Fill in the required fields above to continue
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
};

function RecipeFieldInput({
  field,
  value,
  onChange,
  hasError,
}: {
  field: RecipeField;
  value: string;
  onChange: (v: string) => void;
  hasError: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`recipe-field-${field.key}`} className="text-xs font-medium">
        {field.label}
        {field.required && <span className="text-destructive ml-1">*</span>}
      </Label>

      {field.type === "textarea" ? (
        <Textarea
          id={`recipe-field-${field.key}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          className={cn("text-sm resize-none", hasError && "border-destructive")}
        />
      ) : field.type === "select" && field.options ? (
        <select
          id={`recipe-field-${field.key}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            hasError && "border-destructive",
          )}
        >
          <option value="">{field.placeholder}</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={`recipe-field-${field.key}`}
          type={field.type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className={cn("text-sm", hasError && "border-destructive")}
        />
      )}
    </div>
  );
}
