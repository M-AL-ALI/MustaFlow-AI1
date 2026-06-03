import { authFetch } from "@/lib/api-fetch";
import { useState, useCallback, useEffect } from "react";
import { useLocation } from "wouter";
import {
  Search,
  Star,
  GitFork,
  ArrowRight,
  Loader2,
  Globe,
  Smartphone,
  ShoppingCart,
  LayoutDashboard,
  Briefcase,
  Megaphone,
  Wrench,
  BrainCircuit,
  BookOpen,
  Newspaper,
  Users,
  Layers,
  Award,
  Sparkles,
  Filter,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface GalleryTemplate {
  id: number;
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  authorName: string | null;
  platform: string;
  stack: string;
  rating: number;
  ratingCount: number;
  forkCount: number;
  useCount: number;
  featured: boolean;
  editorsPick: boolean;
  isSystem: boolean;
  thumbnailUrl: string | null;
  previewUrl: string | null;
}

interface TemplateListResponse {
  templates: GalleryTemplate[];
}

const CATEGORIES = [
  { value: "all", label: "All", icon: Layers },
  { value: "web", label: "Web App", icon: Globe },
  { value: "mobile", label: "Mobile", icon: Smartphone },
  { value: "saas", label: "SaaS", icon: Briefcase },
  { value: "ecommerce", label: "E-commerce", icon: ShoppingCart },
  { value: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { value: "landing", label: "Landing Page", icon: Megaphone },
  { value: "portfolio", label: "Portfolio", icon: BookOpen },
  { value: "internal-tools", label: "Internal Tools", icon: Wrench },
  { value: "ai-app", label: "AI App", icon: BrainCircuit },
  { value: "blog", label: "Blog", icon: Newspaper },
  { value: "social", label: "Social", icon: Users },
];

const STACKS: Record<string, string> = {
  "react-vite": "React + Vite",
  nextjs: "Next.js",
  "node-api": "Node.js API",
  "python-flask": "Flask",
  "python-fastapi": "FastAPI",
  "go-gin": "Go + Gin",
  "static-html": "HTML/CSS/JS",
};

function StarRating({ rating, count }: { rating: number; count: number }) {
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Star className="h-3 w-3 fill-yellow-500 text-yellow-500" />
      <span className="text-foreground font-medium">{rating.toFixed(1)}</span>
      {count > 0 && <span>({count})</span>}
    </span>
  );
}

function TemplateCard({
  template,
  onUse,
  onFork,
}: {
  template: GalleryTemplate;
  onUse: (slug: string) => void;
  onFork: (slug: string) => void;
}) {
  const [, navigate] = useLocation();
  const categoryInfo = CATEGORIES.find((c) => c.value === template.category);

  return (
    <div
      className="group rounded-xl border border-border bg-card hover:border-primary/30 transition-all duration-150 flex flex-col overflow-hidden cursor-pointer"
      onClick={() => navigate(`/gallery/${template.slug}`)}
    >
      {/* Preview thumbnail / placeholder */}
      <div className="relative h-36 bg-muted/30 border-b border-border overflow-hidden flex items-center justify-center">
        {template.thumbnailUrl ? (
          <img
            src={template.thumbnailUrl}
            alt={template.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-muted-foreground/40">
            {categoryInfo ? (
              <categoryInfo.icon className="h-8 w-8" />
            ) : (
              <Globe className="h-8 w-8" />
            )}
          </div>
        )}
        {template.editorsPick && (
          <div className="absolute top-2 left-2 flex items-center gap-1 bg-primary/90 text-primary-foreground text-[10px] font-semibold px-2 py-0.5 rounded-full">
            <Award className="h-3 w-3" />
            Editor's Pick
          </div>
        )}
        {template.featured && !template.editorsPick && (
          <div className="absolute top-2 left-2 flex items-center gap-1 bg-yellow-500/90 text-yellow-950 text-[10px] font-semibold px-2 py-0.5 rounded-full">
            <Sparkles className="h-3 w-3" />
            Featured
          </div>
        )}
        {template.isSystem && (
          <div className="absolute top-2 right-2 bg-muted text-muted-foreground text-[10px] px-1.5 py-0.5 rounded font-medium">
            Official
          </div>
        )}
      </div>

      <div className="p-4 flex flex-col gap-3 flex-1">
        <div>
          <h3 className="font-semibold text-foreground text-sm leading-snug">{template.title}</h3>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{template.description}</p>
        </div>

        <div className="flex flex-wrap gap-1.5 mt-auto">
          {template.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full"
            >
              {tag}
            </span>
          ))}
          {STACKS[template.stack] && (
            <span className="text-[10px] bg-primary/10 text-primary px-2 py-0.5 rounded-full">
              {STACKS[template.stack]}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between pt-1 border-t border-border">
          <div className="flex items-center gap-3">
            <StarRating rating={template.rating} count={template.ratingCount} />
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <GitFork className="h-3 w-3" />
              {template.forkCount}
            </span>
          </div>
          <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFork(template.slug);
              }}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors"
            >
              Fork
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onUse(template.slug);
              }}
              className="text-xs bg-primary text-primary-foreground px-2 py-1 rounded hover:bg-primary/90 transition-colors font-medium"
            >
              Use
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function GalleryPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [showEditorsPick, setShowEditorsPick] = useState(false);
  const [templates, setTemplates] = useState<GalleryTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (category !== "all") params.set("category", category);
      if (search) params.set("search", search);
      if (showEditorsPick) params.set("editorsPick", "true");

      const res = await authFetch(`/api/gallery-templates?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load");
      const data = (await res.json()) as TemplateListResponse;
      setTemplates(data.templates);
    } catch {
      toast({ title: "Failed to load templates", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [category, search, showEditorsPick, toast]);

  useEffect(() => {
    const t = setTimeout(fetchTemplates, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [fetchTemplates, search]);

  const handleUse = async (slug: string) => {
    setSubmitting(slug);
    try {
      const res = await authFetch(`/api/gallery-templates/${slug}/use`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        if (res.status === 401) {
          toast({ title: "Sign in to use templates", variant: "destructive" });
          navigate("/sign-in");
          return;
        }
        throw new Error(data.error ?? "Failed");
      }
      const { projectId } = (await res.json()) as { projectId: number };
      toast({ title: "Project created", description: "Opening your new project..." });
      navigate(`/projects/${projectId}`);
    } catch (err) {
      toast({
        title: "Failed to create project",
        description: err instanceof Error ? err.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setSubmitting(null);
    }
  };

  const handleFork = async (slug: string) => {
    setSubmitting(slug + "-fork");
    try {
      const res = await authFetch(`/api/gallery-templates/${slug}/fork`, { method: "POST" });
      if (!res.ok) {
        if (res.status === 401) {
          toast({ title: "Sign in to fork templates", variant: "destructive" });
          navigate("/sign-in");
          return;
        }
        throw new Error("Failed to fork");
      }
      const { projectId } = (await res.json()) as { projectId: number };
      toast({ title: "Template forked", description: "Opening your fork..." });
      navigate(`/projects/${projectId}`);
    } catch (err) {
      toast({
        title: "Failed to fork template",
        description: err instanceof Error ? err.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setSubmitting(null);
    }
  };

  const editorsPicks = templates.filter((t) => t.editorsPick);
  const featuredTemplates = templates.filter((t) => t.featured && !t.editorsPick);
  const regularTemplates = templates.filter((t) => !t.featured && !t.editorsPick);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Template Gallery</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Start with a professionally built template and make it yours.
        </p>
      </div>

      {/* Search + filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search templates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm bg-muted/50 border border-border rounded-lg focus:outline-none focus:border-primary transition-colors"
          />
        </div>
        <button
          onClick={() => setShowEditorsPick((v) => !v)}
          className={cn(
            "flex items-center gap-2 px-4 py-2 text-sm rounded-lg border transition-colors",
            showEditorsPick
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
          )}
        >
          <Filter className="h-4 w-4" />
          Editor's Picks
        </button>
      </div>

      {/* Category pills */}
      <div className="flex gap-2 flex-wrap">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.value}
            onClick={() => setCategory(cat.value)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-colors border",
              category === cat.value
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
          >
            <cat.icon className="h-3.5 w-3.5" />
            {cat.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && templates.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Layers className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-muted-foreground text-sm">No templates found</p>
          {search && (
            <button
              onClick={() => setSearch("")}
              className="text-primary text-sm mt-2 hover:underline"
            >
              Clear search
            </button>
          )}
        </div>
      )}

      {!loading && templates.length > 0 && (
        <div className="space-y-10">
          {/* Editor's Picks section */}
          {editorsPicks.length > 0 && !showEditorsPick && (
            <section>
              <div className="flex items-center gap-2 mb-4">
                <Award className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                  Editor's Picks
                </h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {editorsPicks.map((t) => (
                  <TemplateCard key={t.id} template={t} onUse={handleUse} onFork={handleFork} />
                ))}
              </div>
            </section>
          )}

          {/* Featured section */}
          {featuredTemplates.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="h-4 w-4 text-yellow-500" />
                <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                  Featured
                </h2>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {featuredTemplates.map((t) => (
                  <TemplateCard key={t.id} template={t} onUse={handleUse} onFork={handleFork} />
                ))}
              </div>
            </section>
          )}

          {/* All templates */}
          {regularTemplates.length > 0 && (
            <section>
              {(editorsPicks.length > 0 || featuredTemplates.length > 0) && (
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">
                  All Templates
                </h2>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {regularTemplates.map((t) => (
                  <TemplateCard key={t.id} template={t} onUse={handleUse} onFork={handleFork} />
                ))}
              </div>
            </section>
          )}

          {/* Show all filter results */}
          {showEditorsPick && editorsPicks.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {editorsPicks.map((t) => (
                <TemplateCard key={t.id} template={t} onUse={handleUse} onFork={handleFork} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Submit CTA */}
      <div className="rounded-xl border border-border bg-card p-5 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Share your template</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Submit one of your projects to the gallery and help other builders get started faster.
          </p>
        </div>
        <button
          onClick={() => navigate("/projects")}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors shrink-0"
        >
          Submit a template
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>

      {/* Suppress unused var warning */}
      {submitting && null}
    </div>
  );
}
