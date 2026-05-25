import { useState, useEffect, useRef } from "react";
import {
  Search,
  Puzzle,
  Loader2,
  Shield,
  Star,
  Download,
  Code2,
  FileText,
  ExternalLink,
  ChevronRight,
  Layers,
  Zap,
  Globe,
  BrainCircuit,
  Database,
  BarChart3,
  Wrench,
  CheckCircle2,
  Clock,
  Lock,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface Extension {
  id: number;
  slug: string;
  name: string;
  description: string;
  version: string;
  authorName: string | null;
  category: string;
  tags: string[];
  scopes: string[];
  iconUrl: string | null;
  homepageUrl: string | null;
  installCount: number;
  vetted: boolean;
  featured: boolean;
  isSystem: boolean;
}

interface ProjectOption {
  id: number;
  name: string;
}

const CATEGORIES = [
  { value: "all", label: "All", icon: Layers },
  { value: "productivity", label: "Productivity", icon: Zap },
  { value: "ai", label: "AI", icon: BrainCircuit },
  { value: "data", label: "Data", icon: Database },
  { value: "analytics", label: "Analytics", icon: BarChart3 },
  { value: "devtools", label: "Dev Tools", icon: Wrench },
  { value: "integrations", label: "Integrations", icon: Globe },
];

const SCOPE_LABELS: Record<string, { label: string; icon: React.ElementType }> = {
  read_files: { label: "Read files", icon: FileText },
  write_files: { label: "Write files", icon: Code2 },
  call_ai: { label: "Call AI", icon: BrainCircuit },
  access_env: { label: "Access env vars", icon: Lock },
  access_secrets: { label: "Access secrets", icon: Lock },
  trigger_build: { label: "Trigger builds", icon: Zap },
  read_logs: { label: "Read logs", icon: FileText },
};

const DOCS_SECTIONS = [
  {
    title: "Manifest Format",
    content: `Every extension is described by a manifest.json file:\n\n{\n  "name": "My Extension",\n  "slug": "my-extension",\n  "version": "1.0.0",\n  "description": "What this extension does",\n  "author": "Your name",\n  "scopes": ["read_files", "write_files"],\n  "entrypoint": "https://your-extension.example.com/handler"\n}`,
  },
  {
    title: "Available Scopes",
    content:
      "read_files — Read project file contents\nwrite_files — Create or update project files\ncall_ai — Make AI model calls on behalf of the project\naccess_env — Read environment variable names (not values)\naccess_secrets — Read project secret names (not values)\ntrigger_build — Queue a build/refine task\nread_logs — Read build and runtime logs",
  },
  {
    title: "Install Flow",
    content:
      "1. User installs extension from the marketplace\n2. Extension receives a project token scoped to declared permissions\n3. Extension can call /api/v1/extensions/context with the token\n4. All extension calls are logged in the audit trail\n5. Users can revoke access at any time from project settings",
  },
  {
    title: "Vetting Checklist",
    content:
      "Before an extension is listed publicly, the MustaFlow team checks:\n✓ Manifest is valid and scopes are justified\n✓ Entrypoint is reachable over HTTPS\n✓ No undeclared data collection\n✓ Privacy policy linked\n✓ Source code or reproducible build available",
  },
];

interface ExtensionCardProps {
  ext: Extension;
  projects: ProjectOption[];
  onInstall: (extSlug: string, projectId: number) => Promise<void>;
  installing: boolean;
}

function ExtensionCard({ ext, projects, onInstall, installing }: ExtensionCardProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!showPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPicker]);

  const handleInstallClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (projects.length === 0) return;
    if (projects.length === 1) {
      void onInstall(ext.slug, projects[0].id);
      return;
    }
    setSelectedProjectId(null);
    setShowPicker((v) => !v);
  };

  const handleConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedProjectId == null) return;
    setShowPicker(false);
    void onInstall(ext.slug, selectedProjectId);
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 hover:border-primary/30 transition-colors">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-lg bg-muted/50 border border-border flex items-center justify-center shrink-0 overflow-hidden">
          {ext.iconUrl ? (
            <img src={ext.iconUrl} alt={ext.name} className="h-8 w-8 object-contain" />
          ) : (
            <Puzzle className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-foreground">{ext.name}</h3>
            {ext.vetted && (
              <span className="flex items-center gap-1 text-[10px] text-green-500 font-medium">
                <CheckCircle2 className="h-3 w-3" />
                Vetted
              </span>
            )}
            {ext.featured && !ext.vetted && (
              <span className="flex items-center gap-1 text-[10px] text-primary font-medium">
                <Star className="h-3 w-3" />
                Featured
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{ext.description}</p>
        </div>
      </div>

      {ext.scopes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {ext.scopes.slice(0, 4).map((scope) => {
            const info = SCOPE_LABELS[scope];
            return (
              <span
                key={scope}
                className="flex items-center gap-1 text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full"
                title={`Requires: ${scope}`}
              >
                {info ? <info.icon className="h-2.5 w-2.5" /> : null}
                {info?.label ?? scope}
              </span>
            );
          })}
          {ext.scopes.length > 4 && (
            <span className="text-[10px] text-muted-foreground px-2 py-0.5">
              +{ext.scopes.length - 4} more
            </span>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between relative">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Download className="h-3 w-3" />
            {ext.installCount.toLocaleString()}
          </span>
          <span>v{ext.version}</span>
          {ext.authorName && <span>by {ext.authorName}</span>}
        </div>
        <div className="flex items-center gap-2" ref={pickerRef}>
          {ext.homepageUrl && (
            <a
              href={ext.homepageUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <div className="relative">
            <button
              onClick={handleInstallClick}
              disabled={installing || projects.length === 0}
              className="flex items-center gap-1.5 text-xs bg-primary/10 text-primary hover:bg-primary/20 px-3 py-1 rounded-md font-medium transition-colors disabled:opacity-50"
            >
              {installing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <>
                  Install
                  {projects.length > 1 && <ChevronDown className="h-3 w-3" />}
                </>
              )}
            </button>

            {/* Project picker dropdown */}
            {showPicker && projects.length > 1 && (
              <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-lg border border-border bg-popover shadow-lg">
                <div className="p-2">
                  <p className="text-[10px] text-muted-foreground font-medium px-2 pb-1.5">
                    Select a project
                  </p>
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedProjectId(p.id);
                      }}
                      className={cn(
                        "w-full text-left px-2 py-1.5 rounded-md text-xs transition-colors",
                        selectedProjectId === p.id
                          ? "bg-primary/10 text-primary"
                          : "text-foreground hover:bg-muted",
                      )}
                    >
                      {p.name}
                    </button>
                  ))}
                  <div className="mt-1.5 pt-1.5 border-t border-border flex justify-end px-1">
                    <button
                      onClick={handleConfirm}
                      disabled={selectedProjectId == null}
                      className="text-xs px-3 py-1 bg-primary text-primary-foreground rounded-md disabled:opacity-40 transition-colors hover:bg-primary/90"
                    >
                      Install
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface InstallResponse {
  ok: boolean;
  tokenSecretName?: string;
  scopes?: string[];
}

interface ProjectListItem {
  id: number;
  name: string;
}

export default function ExtensionsPage() {
  const { toast } = useToast();
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeDoc, setActiveDoc] = useState<number | null>(null);
  const [showSubmitForm, setShowSubmitForm] = useState(false);
  const [submitData, setSubmitData] = useState({
    slug: "",
    name: "",
    description: "",
    category: "productivity",
    manifestUrl: "",
    repositoryUrl: "",
    homepageUrl: "",
  });
  const [submitting, setSubmitting] = useState(false);

  // Project list for the install picker
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  // Which extension slug is currently mid-install (to show spinner on that card only)
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);

  // Fetch user's projects once on mount so the install picker is ready
  useEffect(() => {
    fetch("/api/projects", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: unknown) => {
        const rows = Array.isArray(data) ? (data as ProjectListItem[]) : [];
        setProjects(rows.map((p) => ({ id: p.id, name: p.name })));
      })
      .catch(() => {
        /* projects unavailable — install buttons stay disabled */
      });
  }, []);

  // One-click install handler wired to ExtensionCard
  const handleInstall = async (extSlug: string, projectId: number): Promise<void> => {
    setInstallingSlug(extSlug);
    try {
      const res = await fetch(`/api/projects/${projectId}/extensions/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ slug: extSlug }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as InstallResponse;
      toast({
        title: "Extension installed",
        description: data.tokenSecretName
          ? `A scoped access token has been added to your project secrets as ${data.tokenSecretName}.`
          : "The extension has been added to your project.",
      });
    } catch (err) {
      toast({
        title: "Install failed",
        description: err instanceof Error ? err.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setInstallingSlug(null);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);

    const params = new URLSearchParams();
    if (category !== "all") params.set("category", category);
    if (search) params.set("search", search);

    fetch(`/api/extensions?${params}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: unknown) => setExtensions(Array.isArray(data) ? (data as Extension[]) : []))
      .catch(() => setExtensions([]))
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [category, search]);

  const handleSubmit = async () => {
    if (!submitData.slug || !submitData.name || !submitData.description) {
      toast({ title: "Fill in all required fields", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/extensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitData),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        throw new Error(d.error ?? "Failed to submit");
      }
      toast({
        title: "Extension submitted",
        description: "The team will review your extension and get back to you.",
      });
      setShowSubmitForm(false);
      setSubmitData({
        slug: "",
        name: "",
        description: "",
        category: "productivity",
        manifestUrl: "",
        repositoryUrl: "",
        homepageUrl: "",
      });
    } catch (err) {
      toast({
        title: "Failed to submit",
        description: err instanceof Error ? err.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const featuredExts = extensions.filter((e) => e.featured || e.isSystem);
  const otherExts = extensions.filter((e) => !e.featured && !e.isSystem);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Extensions</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Extend your projects with third-party tools and integrations.
        </p>
      </div>

      {/* Search + filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search extensions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm bg-muted/50 border border-border rounded-lg focus:outline-none focus:border-primary transition-colors"
          />
        </div>
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

      {/* Extension listings */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && extensions.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <Puzzle className="h-10 w-10 text-muted-foreground/30" />
          <p className="text-muted-foreground text-sm">
            No extensions listed yet — be the first to publish one.
          </p>
        </div>
      )}

      {!loading && extensions.length > 0 && (
        <div className="space-y-8">
          {featuredExts.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Featured
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {featuredExts.map((e) => (
                  <ExtensionCard
                    key={e.id}
                    ext={e}
                    projects={projects}
                    onInstall={handleInstall}
                    installing={installingSlug === e.slug}
                  />
                ))}
              </div>
            </section>
          )}
          {otherExts.length > 0 && (
            <section>
              {featuredExts.length > 0 && (
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                  All Extensions
                </h2>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {otherExts.map((e) => (
                  <ExtensionCard
                    key={e.id}
                    ext={e}
                    projects={projects}
                    onInstall={handleInstall}
                    installing={installingSlug === e.slug}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Coming soon placeholder */}
      {!loading && extensions.length === 0 && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">Extensions launching soon</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            The extensions marketplace is coming in a future update. In the meantime, you can submit
            your extension for early review.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {["Code Copilot", "Figma Import", "PostHog Analytics", "Sentry Logger"].map((name) => (
              <div
                key={name}
                className="rounded-lg border border-dashed border-border p-3 text-center"
              >
                <Puzzle className="h-5 w-5 text-muted-foreground/40 mx-auto mb-1.5" />
                <p className="text-xs text-muted-foreground">{name}</p>
                <p className="text-[10px] text-muted-foreground/60 mt-0.5">Coming soon</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Developer docs */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Code2 className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">
              Extensions API — Developer Docs
            </h2>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Build extensions that integrate with MustaFlow projects.
          </p>
        </div>
        <div className="divide-y divide-border">
          {DOCS_SECTIONS.map((section, i) => (
            <div key={section.title}>
              <button
                onClick={() => setActiveDoc(activeDoc === i ? null : i)}
                className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-muted/30 transition-colors"
              >
                <span className="text-sm font-medium text-foreground">{section.title}</span>
                <ChevronRight
                  className={cn(
                    "h-4 w-4 text-muted-foreground transition-transform",
                    activeDoc === i && "rotate-90",
                  )}
                />
              </button>
              {activeDoc === i && (
                <div className="px-5 pb-4">
                  <pre className="text-xs text-muted-foreground font-mono whitespace-pre-wrap bg-muted/30 rounded-lg p-4 leading-relaxed">
                    {section.content}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Submit CTA */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Build an extension</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Publish your extension to reach thousands of MustaFlow users. All extensions are
              reviewed by the team before listing.
            </p>
          </div>
          <button
            onClick={() => setShowSubmitForm((v) => !v)}
            className="shrink-0 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors"
          >
            <Shield className="h-4 w-4" />
            Submit Extension
          </button>
        </div>

        {showSubmitForm && (
          <div className="border-t border-border pt-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                { key: "name", label: "Name *", placeholder: "My Extension" },
                {
                  key: "slug",
                  label: "Slug *",
                  placeholder: "my-extension",
                },
                {
                  key: "manifestUrl",
                  label: "Manifest URL",
                  placeholder: "https://example.com/manifest.json",
                },
                {
                  key: "repositoryUrl",
                  label: "Repository URL",
                  placeholder: "https://github.com/...",
                },
              ].map((field) => (
                <div key={field.key}>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    {field.label}
                  </label>
                  <input
                    type="text"
                    placeholder={field.placeholder}
                    value={submitData[field.key as keyof typeof submitData]}
                    onChange={(e) => setSubmitData((d) => ({ ...d, [field.key]: e.target.value }))}
                    className="w-full px-3 py-2 text-sm bg-muted/50 border border-border rounded-lg focus:outline-none focus:border-primary"
                  />
                </div>
              ))}
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Description *
              </label>
              <textarea
                placeholder="What does your extension do?"
                value={submitData.description}
                onChange={(e) => setSubmitData((d) => ({ ...d, description: e.target.value }))}
                rows={3}
                className="w-full px-3 py-2 text-sm bg-muted/50 border border-border rounded-lg focus:outline-none focus:border-primary resize-none"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSubmitForm(false)}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit for Review"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
