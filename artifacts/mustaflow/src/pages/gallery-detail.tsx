import { authFetch } from "@/lib/api-fetch";
import { useState, useEffect } from "react";
import { useParams, useLocation, Link } from "wouter";
import { PageMeta } from "@/components/page-meta";
import {
  Star,
  GitFork,
  ArrowLeft,
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
  ArrowRight,
  Eye,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface GalleryTemplate {
  id: number;
  slug: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  authorName: string | null;
  authorUsername: string | null;
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
  createdAt: string;
  publishedAt: string | null;
}

const CATEGORIES: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  web: { label: "Web App", icon: Globe },
  mobile: { label: "Mobile", icon: Smartphone },
  saas: { label: "SaaS", icon: Briefcase },
  ecommerce: { label: "E-commerce", icon: ShoppingCart },
  dashboard: { label: "Dashboard", icon: LayoutDashboard },
  landing: { label: "Landing Page", icon: Megaphone },
  portfolio: { label: "Portfolio", icon: BookOpen },
  "internal-tools": { label: "Internal Tools", icon: Wrench },
  "ai-app": { label: "AI App", icon: BrainCircuit },
  blog: { label: "Blog", icon: Newspaper },
  social: { label: "Social", icon: Users },
};

const STACKS: Record<string, string> = {
  "react-vite": "React + Vite",
  nextjs: "Next.js",
  "node-api": "Node.js API",
  "python-flask": "Flask",
  "python-fastapi": "FastAPI",
  "go-gin": "Go + Gin",
  "static-html": "HTML/CSS/JS",
};

const PLATFORM_LABELS: Record<string, string> = {
  web: "Web",
  cross: "Mobile (cross-platform)",
  ios: "iOS",
  android: "Android",
};

export default function GalleryDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [template, setTemplate] = useState<GalleryTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    authFetch(`/api/gallery-templates/${slug}`)
      .then(async (res) => {
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error("Failed to load");
        const data = (await res.json()) as GalleryTemplate;
        setTemplate(data);
      })
      .catch(() => {
        toast({ title: "Failed to load template", variant: "destructive" });
      })
      .finally(() => setLoading(false));
  }, [slug, toast]);

  const handleUse = async () => {
    setSubmitting(true);
    try {
      const res = await authFetch(`/api/gallery-templates/${slug}/use`, { method: "POST" });
      if (!res.ok) {
        if (res.status === 401) {
          toast({ title: "Sign in to use templates", variant: "destructive" });
          navigate("/sign-in");
          return;
        }
        const data = (await res.json()) as { error?: string };
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
      setSubmitting(false);
    }
  };

  const handleFork = async () => {
    setSubmitting(true);
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
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notFound || !template) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-20 text-center">
        <Layers className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
        <h1 className="text-lg font-semibold text-foreground mb-2">Template not found</h1>
        <p className="text-sm text-muted-foreground mb-6">
          This template may have been removed or is not yet published.
        </p>
        <Link
          href="/gallery"
          className="text-primary text-sm hover:underline inline-flex items-center gap-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to gallery
        </Link>
      </div>
    );
  }

  const categoryInfo = CATEGORIES[template.category];
  const CategoryIcon = categoryInfo?.icon ?? Globe;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
      <PageMeta
        title={`${template.title} — Template Gallery`}
        description={template.description}
        path={`/gallery/${template.slug}`}
      />

      {/* Breadcrumb */}
      <Link
        href="/gallery"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Template Gallery
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left: main info */}
        <div className="lg:col-span-2 space-y-6">
          {/* Thumbnail */}
          <div className="rounded-xl border border-border overflow-hidden bg-muted/30 aspect-video flex items-center justify-center">
            {template.thumbnailUrl ? (
              <img
                src={template.thumbnailUrl}
                alt={template.title}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground/40">
                <CategoryIcon className="h-12 w-12" />
                <span className="text-sm">{categoryInfo?.label ?? template.category}</span>
              </div>
            )}
          </div>

          {/* Title & badges */}
          <div>
            <div className="flex flex-wrap gap-2 mb-2">
              {template.editorsPick && (
                <span className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs font-semibold px-2 py-0.5 rounded-full">
                  <Award className="h-3 w-3" />
                  Editor's Pick
                </span>
              )}
              {template.featured && !template.editorsPick && (
                <span className="inline-flex items-center gap-1 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 text-xs font-semibold px-2 py-0.5 rounded-full">
                  <Sparkles className="h-3 w-3" />
                  Featured
                </span>
              )}
              {template.isSystem && (
                <span className="bg-muted text-muted-foreground text-xs px-2 py-0.5 rounded-full font-medium">
                  Official
                </span>
              )}
            </div>
            <h1 className="text-2xl font-bold text-foreground">{template.title}</h1>
            <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
              {template.description}
            </p>
          </div>

          {/* Tags */}
          {template.tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {template.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs bg-muted text-muted-foreground px-2.5 py-1 rounded-full"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Stats row */}
          <div className="flex items-center gap-5 text-sm text-muted-foreground border-t border-border pt-4">
            <span className="flex items-center gap-1.5">
              <Star className="h-4 w-4 fill-yellow-500 text-yellow-500" />
              <span className="font-medium text-foreground">{template.rating.toFixed(1)}</span>
              {template.ratingCount > 0 && <span>({template.ratingCount})</span>}
            </span>
            <span className="flex items-center gap-1.5">
              <GitFork className="h-4 w-4" />
              {template.forkCount} forks
            </span>
            <span className="flex items-center gap-1.5">
              <Eye className="h-4 w-4" />
              {template.useCount} uses
            </span>
          </div>
        </div>

        {/* Right: action sidebar */}
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <button
              onClick={handleUse}
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  Use this template
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
            <button
              onClick={handleFork}
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-border text-sm font-medium rounded-lg hover:bg-muted transition-colors disabled:opacity-60"
            >
              <GitFork className="h-4 w-4" />
              Fork
            </button>
            {template.previewUrl && (
              <a
                href={template.previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-border text-sm font-medium rounded-lg hover:bg-muted transition-colors"
              >
                <Eye className="h-4 w-4" />
                Live preview
              </a>
            )}
          </div>

          {/* Metadata */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Category</span>
              <span className="font-medium text-foreground">
                {categoryInfo?.label ?? template.category}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Platform</span>
              <span className="font-medium text-foreground">
                {PLATFORM_LABELS[template.platform] ?? template.platform}
              </span>
            </div>
            {STACKS[template.stack] && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Stack</span>
                <span className="font-medium text-foreground">{STACKS[template.stack]}</span>
              </div>
            )}
            {template.authorName && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Author</span>
                {template.authorUsername ? (
                  <Link
                    href={`/u/${template.authorUsername}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {template.authorName}
                  </Link>
                ) : (
                  <span className="font-medium text-foreground">{template.authorName}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
