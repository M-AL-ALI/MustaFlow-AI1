import { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
type MonacoEditor = Parameters<OnMount>[0];
import {
  useListProjectFiles,
  useGetProjectFile,
  useUpdateProjectFile,
  useCreateProjectFile,
  useDeleteProjectFile,
  useRenameProjectFile,
  useInstallPackage,
  useUninstallPackage,
  getListProjectFilesQueryKey,
  getGetProjectFileQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  FileCode2,
  FileText,
  FileJson,
  Globe,
  FileCog,
  FileType,
  Save,
  AlertCircle,
  Plus,
  X,
  Check,
  Search,
  Layers,
  ChevronRight,
  Loader2,
  Pencil,
  Trash2,
  Package,
  GitBranch,
  Github,
  ExternalLink,
  Lock,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { SNIPPETS, SNIPPET_CATEGORIES, type SnippetCategory } from "@/lib/snippets";

function getLanguage(path: string): string {
  if (path.endsWith(".html") || path.endsWith(".htm")) return "html";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md") || path.endsWith(".markdown")) return "markdown";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".svg") || path.endsWith(".xml")) return "xml";
  if (path.endsWith(".sh") || path.endsWith(".bash")) return "shell";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".toml")) return "ini";
  return "plaintext";
}

function FileIcon({ path }: { path: string }) {
  if (path.endsWith(".html") || path.endsWith(".htm"))
    return <Globe className="h-3.5 w-3.5 shrink-0 text-orange-400" />;
  if (path.endsWith(".css")) return <FileType className="h-3.5 w-3.5 shrink-0 text-blue-400" />;
  if (path.endsWith(".js") || path.endsWith(".mjs"))
    return <FileCog className="h-3.5 w-3.5 shrink-0 text-yellow-400" />;
  if (path.endsWith(".ts") || path.endsWith(".tsx"))
    return <FileCog className="h-3.5 w-3.5 shrink-0 text-blue-500" />;
  if (path.endsWith(".json")) return <FileJson className="h-3.5 w-3.5 shrink-0 text-green-400" />;
  if (path.endsWith(".md"))
    return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  return <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

type SidebarMode = "files" | "search" | "snippets" | "packages" | "git";

type SearchResult = {
  fileId: number;
  file: string;
  lineNumber: number;
  lineContent: string;
};

function FileSearchPanel({
  projectId,
  onFileSelect,
}: {
  projectId: number;
  onFileSelect: (fileId: number, lineNumber?: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setResults([]);
        setSearched(false);
        return;
      }
      setIsSearching(true);
      setSearched(false);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/files/search?q=${encodeURIComponent(q)}`,
        );
        if (res.ok) {
          const data = (await res.json()) as SearchResult[];
          setResults(data);
        } else {
          setResults([]);
        }
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
        setSearched(true);
      }
    },
    [projectId],
  );

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runSearch(val);
    }, 400);
  }

  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    if (!acc[r.file]) acc[r.file] = [];
    acc[r.file]!.push(r);
    return acc;
  }, {});

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-2 py-2 border-b border-border/50">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={handleChange}
            placeholder="Search in files…"
            className="w-full pl-6 pr-2 py-1 text-[11px] bg-background border border-border rounded text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {isSearching && (
            <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {!query && (
          <div className="px-3 py-6 text-center">
            <Search className="h-5 w-5 text-muted-foreground/30 mx-auto mb-2" />
            <div className="text-[10px] text-muted-foreground">
              Type to search across all project files
            </div>
          </div>
        )}
        {searched && results.length === 0 && query && (
          <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            No matches found
          </div>
        )}
        {Object.entries(grouped).map(([file, hits]) => (
          <div key={file}>
            <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide truncate bg-muted/30 border-b border-border/30">
              {file}
            </div>
            {hits.map((hit, i) => (
              <button
                key={i}
                onClick={() => onFileSelect(hit.fileId, hit.lineNumber)}
                className="w-full text-left px-2 py-1.5 flex items-start gap-1.5 hover:bg-muted/50 transition-colors group"
              >
                <span className="text-[10px] text-muted-foreground shrink-0 w-6 text-right mt-px">
                  {hit.lineNumber}
                </span>
                <span className="text-[11px] font-mono text-foreground/80 truncate flex-1 min-w-0">
                  {hit.lineContent}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SnippetLibraryPanel({ onInsert }: { onInsert: (prompt: string) => void }) {
  const [activeCategory, setActiveCategory] = useState<SnippetCategory | "All">("All");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered =
    activeCategory === "All" ? SNIPPETS : SNIPPETS.filter((s) => s.category === activeCategory);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-2 py-1.5 border-b border-border/50">
        <div className="flex flex-wrap gap-1">
          {(["All", ...SNIPPET_CATEGORIES] as Array<"All" | SnippetCategory>).map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={cn(
                "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                activeCategory === cat
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {filtered.map((snippet) => {
          const isOpen = expandedId === snippet.id;
          return (
            <div key={snippet.id} className="border-b border-border/20 last:border-0">
              <button
                onClick={() => setExpandedId(isOpen ? null : snippet.id)}
                className="w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-muted/40 transition-colors"
              >
                <Layers className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-medium text-foreground truncate">
                    {snippet.name}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">
                    {snippet.description}
                  </div>
                </div>
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform mt-0.5",
                    isOpen && "rotate-90",
                  )}
                />
              </button>
              {isOpen && (
                <div className="px-3 pb-2 space-y-2">
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    {snippet.prompt}
                  </p>
                  <button
                    onClick={() => {
                      onInsert(snippet.prompt);
                      setExpandedId(null);
                    }}
                    className="w-full text-[11px] py-1.5 rounded bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition-colors font-medium"
                  >
                    Send to AI Builder
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type PackageDep = { name: string; version: string; dev?: boolean };

function PackageManagerPanel({
  projectId,
  files,
}: {
  projectId: number;
  files: Array<{ id: number; path: string }>;
}) {
  const [deps, setDeps] = useState<PackageDep[]>([]);
  const [devDeps, setDevDeps] = useState<PackageDep[]>([]);
  const [parsed, setParsed] = useState(false);
  const [expanded, setExpanded] = useState<"deps" | "devDeps" | null>("deps");
  const [installName, setInstallName] = useState("");
  const [installVersion, setInstallVersion] = useState("");
  const [installDev, setInstallDev] = useState(false);
  const [removingPkg, setRemovingPkg] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const pkgFileEntry = files.find((f) => f.path === "package.json");
  const { data: pkgFile } = useGetProjectFile(projectId, pkgFileEntry?.id ?? 0, {
    query: {
      enabled: !!pkgFileEntry,
      queryKey: getGetProjectFileQueryKey(projectId, pkgFileEntry?.id ?? 0),
    },
  });

  const installMutation = useInstallPackage();
  const uninstallMutation = useUninstallPackage();

  /** Refresh the package.json file query so the panel re-reads the updated content. */
  const refreshPkg = () => {
    if (pkgFileEntry) {
      void queryClient.invalidateQueries({
        queryKey: getGetProjectFileQueryKey(projectId, pkgFileEntry.id),
      });
    }
  };

  useEffect(() => {
    if (!pkgFile?.content) return;
    try {
      const pkg = JSON.parse(pkgFile.content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      setDeps(Object.entries(pkg.dependencies ?? {}).map(([name, version]) => ({ name, version })));
      setDevDeps(
        Object.entries(pkg.devDependencies ?? {}).map(([name, version]) => ({
          name,
          version,
          dev: true,
        })),
      );
      setParsed(true);
    } catch {
      setParsed(false);
    }
  }, [pkgFile?.content]);

  const hasPkgJson = !!pkgFileEntry;

  const handleInstall = () => {
    const name = installName.trim();
    if (!name) return;
    installMutation.mutate(
      {
        id: projectId,
        data: { name, version: installVersion.trim() || undefined, dev: installDev },
      },
      {
        onSuccess: (result) => {
          toast({ title: `Installed ${name}` });
          setInstallName("");
          setInstallVersion("");
          // Update local state immediately from API result
          setDeps(Object.entries(result.dependencies).map(([n, v]) => ({ name: n, version: v })));
          setDevDeps(
            Object.entries(result.devDependencies).map(([n, v]) => ({
              name: n,
              version: v,
              dev: true,
            })),
          );
          refreshPkg();
        },
        onError: () => {
          toast({ title: `Failed to install ${name}`, variant: "destructive" });
        },
      },
    );
  };

  const handleUninstall = (pkgName: string) => {
    setRemovingPkg(pkgName);
    uninstallMutation.mutate(
      { id: projectId, data: { name: pkgName } },
      {
        onSuccess: (result) => {
          toast({ title: `Removed ${pkgName}` });
          setDeps(Object.entries(result.dependencies).map(([n, v]) => ({ name: n, version: v })));
          setDevDeps(
            Object.entries(result.devDependencies).map(([n, v]) => ({
              name: n,
              version: v,
              dev: true,
            })),
          );
          refreshPkg();
        },
        onError: () => {
          toast({ title: `Failed to remove ${pkgName}`, variant: "destructive" });
        },
        onSettled: () => setRemovingPkg(null),
      },
    );
  };

  if (!hasPkgJson) {
    return (
      <div className="px-3 py-6 text-center">
        <Package className="h-5 w-5 text-muted-foreground/30 mx-auto mb-2" />
        <div className="text-[11px] text-muted-foreground">No package.json found</div>
        <div className="text-[10px] text-muted-foreground/60 mt-0.5">
          Build something first to see packages
        </div>
      </div>
    );
  }

  if (!parsed && pkgFile) {
    return (
      <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
        Could not parse package.json
      </div>
    );
  }

  if (!pkgFile) {
    return (
      <div className="px-3 py-4 flex items-center justify-center">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const totalCount = deps.length + devDeps.length;
  const isInstalling = installMutation.isPending;

  function renderSection(title: string, items: PackageDep[], sectionKey: "deps" | "devDeps") {
    const isOpen = expanded === sectionKey;
    return (
      <div key={sectionKey} className="border-b border-border/30 last:border-0">
        <button
          onClick={() => setExpanded(isOpen ? null : sectionKey)}
          className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-left"
        >
          {isOpen ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
          <span className="text-[11px] font-medium text-foreground flex-1">{title}</span>
          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {items.length}
          </span>
        </button>
        {isOpen && (
          <div className="pb-1">
            {items.length === 0 ? (
              <div className="px-3 py-2 text-[10px] text-muted-foreground">None</div>
            ) : (
              items.map((dep) => {
                const isRemoving = removingPkg === dep.name;
                return (
                  <div
                    key={dep.name}
                    className="group flex items-center gap-2 px-3 py-1.5 hover:bg-muted/30 transition-colors"
                  >
                    <Package className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-[11px] font-mono text-foreground flex-1 truncate">
                      {dep.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground font-mono shrink-0 group-hover:hidden">
                      {dep.version}
                    </span>
                    <button
                      onClick={() => handleUninstall(dep.name)}
                      disabled={isRemoving || uninstallMutation.isPending}
                      className="hidden group-hover:flex items-center justify-center h-4 w-4 shrink-0 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                      title={`Remove ${dep.name}`}
                    >
                      {isRemoving ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <X className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Install panel */}
      <div className="px-3 py-2.5 border-b border-border/50 bg-muted/20 space-y-2">
        <div className="text-[10px] text-muted-foreground font-medium">
          {totalCount} package{totalCount !== 1 ? "s" : ""} installed
        </div>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={installName}
            onChange={(e) => setInstallName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleInstall()}
            placeholder="Package name"
            className="flex-1 min-w-0 text-[11px] bg-background border border-border/60 rounded px-2 py-1 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <input
            type="text"
            value={installVersion}
            onChange={(e) => setInstallVersion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleInstall()}
            placeholder="Version"
            className="w-16 text-[11px] bg-background border border-border/60 rounded px-2 py-1 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={installDev}
              onChange={(e) => setInstallDev(e.target.checked)}
              className="h-3 w-3 accent-primary"
            />
            <span className="text-[10px] text-muted-foreground">Dev dependency</span>
          </label>
          <button
            onClick={handleInstall}
            disabled={!installName.trim() || isInstalling}
            className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isInstalling ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
            Install
          </button>
        </div>
      </div>
      {/* Package list */}
      <div className="flex-1 overflow-y-auto">
        {renderSection("Dependencies", deps, "deps")}
        {renderSection("Dev Dependencies", devDeps, "devDeps")}
      </div>
    </div>
  );
}

function GitPushPanel({ projectId }: { projectId: number }) {
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [commitMessage, setCommitMessage] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    repoUrl: string;
    commitSha: string;
    filesCount: number;
    created: boolean;
  } | null>(null);
  const { toast } = useToast();

  const LS_KEY = `mf-github-${projectId}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as {
        repo?: string;
        branch?: string;
      };
      if (saved.repo) setRepo(saved.repo);
      if (saved.branch) setBranch(saved.branch);
    } catch {
      // intentionally ignored
    }
  }, [LS_KEY]);

  async function handlePush() {
    if (!repo.trim()) return;
    setPushing(true);
    setError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = {
        repo: repo.trim(),
        branch: branch.trim() || "main",
        private: isPrivate,
        commitMessage: commitMessage.trim() || undefined,
      };
      if (token.trim()) body.token = token.trim();

      const res = await fetch(`/api/projects/${projectId}/github/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        repoUrl?: string;
        commitSha?: string;
        filesCount?: number;
        created?: boolean;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? "Push failed");
      } else {
        setResult({
          repoUrl: data.repoUrl!,
          commitSha: data.commitSha!,
          filesCount: data.filesCount!,
          created: data.created ?? false,
        });
        localStorage.setItem(LS_KEY, JSON.stringify({ repo: repo.trim(), branch: branch.trim() }));
        toast({ title: "Pushed to GitHub", description: `${data.filesCount} files pushed` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Push failed";
      setError(msg);
    } finally {
      setPushing(false);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto">
      <div className="px-3 py-2 border-b border-border/50 bg-muted/20">
        <div className="flex items-center gap-2">
          <Github className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[11px] font-medium text-foreground">Push to GitHub</span>
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          Push all project files to a GitHub repository
        </div>
      </div>

      <div className="p-3 space-y-3">
        {result && (
          <div className="rounded-lg bg-green-500/10 border border-green-500/20 p-2.5 space-y-1.5">
            <div className="text-[11px] text-green-400 font-medium flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5" />
              {result.created ? "Repository created and pushed" : "Pushed successfully"}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {result.filesCount} files · {result.commitSha.slice(0, 7)}
            </div>
            <a
              href={result.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[11px] text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {result.repoUrl}
            </a>
            <button
              onClick={() => setResult(null)}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Push again
            </button>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-2.5 text-[11px] text-destructive">
            {error}
          </div>
        )}

        {!result && (
          <>
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                Repository name
              </label>
              <input
                type="text"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="my-project"
                className="w-full px-2 py-1.5 text-[11px] bg-background border border-border rounded text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                Branch
              </label>
              <input
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="w-full px-2 py-1.5 text-[11px] bg-background border border-border rounded text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary font-mono"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                Commit message
              </label>
              <input
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Push from MustaFlow AI"
                className="w-full px-2 py-1.5 text-[11px] bg-background border border-border rounded text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <Lock className="h-3 w-3" />
                GitHub token
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_… or use stored GITHUB_TOKEN secret"
                className="w-full px-2 py-1.5 text-[11px] bg-background border border-border rounded text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary font-mono"
              />
              <div className="text-[10px] text-muted-foreground">
                Leave blank to use the GITHUB_TOKEN project secret
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsPrivate((v) => !v)}
                className={cn(
                  "w-8 h-4 rounded-full transition-colors relative shrink-0",
                  isPrivate ? "bg-primary" : "bg-muted-foreground/30",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform shadow-sm",
                    isPrivate ? "left-4.5" : "left-0.5",
                  )}
                  style={{ transform: isPrivate ? "translateX(14px)" : "translateX(0)" }}
                />
              </button>
              <span className="text-[11px] text-muted-foreground">Private repository</span>
            </div>

            <button
              onClick={() => void handlePush()}
              disabled={pushing || !repo.trim()}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {pushing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Pushing…
                </>
              ) : (
                <>
                  <GitBranch className="h-3.5 w-3.5" />
                  Push to GitHub
                </>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const EDITOR_LS_KEY = (projectId: number) => `mf-editor-file-${projectId}`;

export function CodeEditorTab({
  projectId,
  initialFileId,
  onHtmlFileSaved,
  onSnippetInsert,
}: {
  projectId: number;
  initialFileId?: number | null;
  onHtmlFileSaved?: () => void;
  onSnippetInsert?: (prompt: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("files");

  const resolveInitialFile = (): number | null => {
    if (initialFileId != null) return initialFileId;
    try {
      const stored = localStorage.getItem(EDITOR_LS_KEY(projectId));
      if (stored) return Number(stored);
    } catch {
      // intentionally ignored
    }
    return null;
  };

  const [selectedFileId, setSelectedFileId] = useState<number | null>(resolveInitialFile);
  const [pendingFileId, setPendingFileId] = useState<number | null>(null);
  const [editorContent, setEditorContent] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);

  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const newFileInputRef = useRef<HTMLInputElement>(null);

  const [renamingFileId, setRenamingFileId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [confirmDeleteFileId, setConfirmDeleteFileId] = useState<number | null>(null);

  const editorRef = useRef<MonacoEditor | null>(null);
  const pendingRevealLineRef = useRef<number | null>(null);

  const { data: files = [] } = useListProjectFiles(projectId, {
    query: { queryKey: getListProjectFilesQueryKey(projectId) },
  });

  const { data: fileContent } = useGetProjectFile(projectId, selectedFileId ?? 0, {
    query: {
      enabled: selectedFileId !== null,
      queryKey: getGetProjectFileQueryKey(projectId, selectedFileId ?? 0),
    },
  });

  const updateFile = useUpdateProjectFile();
  const createFile = useCreateProjectFile();
  const deleteFile = useDeleteProjectFile();
  const renameFile = useRenameProjectFile();

  const selectedFile = files.find((f) => f.id === selectedFileId) ?? null;
  const confirmDeleteFile = files.find((f) => f.id === confirmDeleteFileId) ?? null;

  const displayContent = editorContent !== null ? editorContent : (fileContent?.content ?? "");

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const newVal = value ?? "";
      setEditorContent(newVal);
      setIsDirty(newVal !== (fileContent?.content ?? ""));
    },
    [fileContent?.content],
  );

  function switchToFile(fileId: number, lineNumber?: number) {
    if (lineNumber) pendingRevealLineRef.current = lineNumber;
    if (isDirty) {
      setPendingFileId(fileId);
      setShowUnsavedWarning(true);
    } else {
      setSelectedFileId(fileId);
      setEditorContent(null);
      setIsDirty(false);
      setShowUnsavedWarning(false);
      try {
        localStorage.setItem(EDITOR_LS_KEY(projectId), String(fileId));
      } catch {
        // intentionally ignored
      }
    }
    setSidebarMode("files");
  }

  useEffect(() => {
    const line = pendingRevealLineRef.current;
    if (!line || !editorRef.current) return;
    const timer = setTimeout(() => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: 1 });
      ed.focus();
      pendingRevealLineRef.current = null;
    }, 200);
    return () => clearTimeout(timer);
  }, [selectedFileId, fileContent]);

  function discardAndSwitch() {
    if (pendingFileId !== null) {
      setSelectedFileId(pendingFileId);
      setEditorContent(null);
      setIsDirty(false);
      setShowUnsavedWarning(false);
      setPendingFileId(null);
      try {
        localStorage.setItem(EDITOR_LS_KEY(projectId), String(pendingFileId));
      } catch {
        // intentionally ignored
      }
    }
  }

  function cancelSwitch() {
    setPendingFileId(null);
    setShowUnsavedWarning(false);
  }

  async function handleSave(): Promise<boolean> {
    if (!selectedFileId || editorContent === null) return false;
    try {
      await updateFile.mutateAsync({
        id: projectId,
        fileId: selectedFileId,
        data: { content: editorContent },
      });
      setIsDirty(false);
      void queryClient.invalidateQueries({
        queryKey: getGetProjectFileQueryKey(projectId, selectedFileId),
      });
      toast({ title: "File saved", description: selectedFile?.path });
      const lowerPath = selectedFile?.path.toLowerCase() ?? "";
      const isHtml = lowerPath.endsWith(".html") || lowerPath.endsWith(".htm");
      if (isHtml) onHtmlFileSaved?.();
      if (selectedFile?.path && editorContent !== null) {
        window.dispatchEvent(
          new CustomEvent("mustaflow:file-saved", {
            detail: { path: selectedFile.path, content: editorContent },
          }),
        );
      }
      return true;
    } catch {
      toast({
        title: "Save failed",
        description: "Could not save the file. Please try again.",
        variant: "destructive",
      });
      return false;
    }
  }

  function startNewFile() {
    setShowNewFileInput(true);
    setNewFilePath("");
    setTimeout(() => newFileInputRef.current?.focus(), 50);
  }

  function cancelNewFile() {
    setShowNewFileInput(false);
    setNewFilePath("");
  }

  async function handleCreateFile() {
    const trimmed = newFilePath.trim();
    if (!trimmed) return;
    try {
      const created = await createFile.mutateAsync({
        id: projectId,
        data: { path: trimmed, content: "" },
      });
      await queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
      setShowNewFileInput(false);
      setNewFilePath("");
      setSelectedFileId(created.id);
      setEditorContent("");
      setIsDirty(false);
      try {
        localStorage.setItem(EDITOR_LS_KEY(projectId), String(created.id));
      } catch {
        // intentionally ignored
      }
      toast({ title: "File created", description: trimmed });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not create file.";
      toast({ title: "Create failed", description: msg, variant: "destructive" });
    }
  }

  function startRename(fileId: number, currentPath: string) {
    setRenamingFileId(fileId);
    setRenameValue(currentPath);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  }

  function cancelRename() {
    setRenamingFileId(null);
    setRenameValue("");
  }

  async function handleRename(fileId: number) {
    const trimmed = renameValue.trim();
    if (!trimmed) return cancelRename();
    const currentFile = files.find((f) => f.id === fileId);
    if (currentFile?.path === trimmed) return cancelRename();
    try {
      await renameFile.mutateAsync({
        id: projectId,
        fileId,
        data: { path: trimmed },
      });
      await queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
      if (selectedFileId === fileId) {
        void queryClient.invalidateQueries({
          queryKey: getGetProjectFileQueryKey(projectId, fileId),
        });
      }
      setRenamingFileId(null);
      setRenameValue("");
      toast({ title: "File renamed", description: trimmed });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not rename file.";
      toast({ title: "Rename failed", description: msg, variant: "destructive" });
    }
  }

  async function handleDeleteFile(fileId: number) {
    try {
      await deleteFile.mutateAsync({ id: projectId, fileId });
      await queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
      setConfirmDeleteFileId(null);
      if (selectedFileId === fileId) {
        setSelectedFileId(null);
        setEditorContent(null);
        setIsDirty(false);
        try {
          localStorage.removeItem(EDITOR_LS_KEY(projectId));
        } catch {
          // intentionally ignored
        }
      }
      toast({ title: "File deleted" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not delete file.";
      toast({ title: "Delete failed", description: msg, variant: "destructive" });
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Left rail: icon tabs */}
      <div className="w-8 shrink-0 border-r border-border bg-sidebar flex flex-col items-center py-1 gap-0.5">
        <button
          onClick={() => setSidebarMode("files")}
          title="Files"
          className={cn(
            "p-1.5 rounded transition-colors",
            sidebarMode === "files"
              ? "text-primary bg-primary/10"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          <FileCode2 className="h-4 w-4" />
        </button>
        <button
          onClick={() => setSidebarMode("search")}
          title="Search in files"
          className={cn(
            "p-1.5 rounded transition-colors",
            sidebarMode === "search"
              ? "text-primary bg-primary/10"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          <Search className="h-4 w-4" />
        </button>
        <button
          onClick={() => setSidebarMode("snippets")}
          title="Snippet library"
          className={cn(
            "p-1.5 rounded transition-colors",
            sidebarMode === "snippets"
              ? "text-primary bg-primary/10"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          <Layers className="h-4 w-4" />
        </button>
        <button
          onClick={() => setSidebarMode("packages")}
          title="Package manager"
          className={cn(
            "p-1.5 rounded transition-colors",
            sidebarMode === "packages"
              ? "text-primary bg-primary/10"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          <Package className="h-4 w-4" />
        </button>
        <button
          onClick={() => setSidebarMode("git")}
          title="Push to GitHub"
          className={cn(
            "p-1.5 rounded transition-colors",
            sidebarMode === "git"
              ? "text-primary bg-primary/10"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          <Github className="h-4 w-4" />
        </button>
      </div>

      {/* Sidebar panel */}
      <div className="w-52 shrink-0 border-r border-border bg-sidebar flex flex-col min-h-0">
        {sidebarMode === "files" && (
          <>
            <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
              <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex-1">
                Files {files.length > 0 && `(${files.length})`}
              </span>
              <button
                onClick={startNewFile}
                title="New file"
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            {showNewFileInput && (
              <div className="px-2 py-1.5 border-b border-border/50 bg-muted/30">
                <div className="flex items-center gap-1">
                  <input
                    ref={newFileInputRef}
                    type="text"
                    value={newFilePath}
                    onChange={(e) => setNewFilePath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleCreateFile();
                      if (e.key === "Escape") cancelNewFile();
                    }}
                    placeholder="filename.html"
                    className="flex-1 min-w-0 text-[11px] font-mono bg-background border border-border rounded px-2 py-1 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button
                    onClick={() => void handleCreateFile()}
                    disabled={createFile.isPending || !newFilePath.trim()}
                    className="p-1 rounded text-primary hover:bg-primary/10 transition-colors disabled:opacity-40"
                    title="Create"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={cancelNewFile}
                    className="p-1 rounded text-muted-foreground hover:bg-muted transition-colors"
                    title="Cancel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto py-1">
              {files.length === 0 && !showNewFileInput ? (
                <div className="px-3 py-6 text-center">
                  <FileCode2 className="h-6 w-6 text-muted-foreground/30 mx-auto mb-2" />
                  <div className="text-[11px] text-muted-foreground">No files yet.</div>
                  <div className="text-[10px] text-muted-foreground/60 mt-0.5">
                    Build something first.
                  </div>
                </div>
              ) : (
                files.map((file) => {
                  const isRenaming = renamingFileId === file.id;
                  const isConfirmDelete = confirmDeleteFileId === file.id;

                  if (isRenaming) {
                    return (
                      <div
                        key={file.id}
                        className="flex items-center gap-1 px-2 py-1.5 bg-primary/5 border-r-2 border-primary"
                      >
                        <input
                          ref={renameInputRef}
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void handleRename(file.id);
                            if (e.key === "Escape") cancelRename();
                          }}
                          className="flex-1 min-w-0 text-[11px] font-mono bg-background border border-primary/50 rounded px-1.5 py-0.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                        <button
                          onClick={() => void handleRename(file.id)}
                          disabled={renameFile.isPending}
                          className="p-0.5 rounded text-primary hover:bg-primary/10 transition-colors disabled:opacity-40 shrink-0"
                          title="Confirm rename"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={cancelRename}
                          className="p-0.5 rounded text-muted-foreground hover:bg-muted transition-colors shrink-0"
                          title="Cancel"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  }

                  if (isConfirmDelete) {
                    return (
                      <div
                        key={file.id}
                        className="px-2 py-1.5 bg-destructive/10 border-r-2 border-destructive"
                      >
                        <div className="text-[10px] text-destructive/80 truncate mb-1">
                          Delete {file.path}?
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => void handleDeleteFile(file.id)}
                            disabled={deleteFile.isPending}
                            className="flex-1 text-[10px] py-0.5 rounded bg-destructive/20 text-destructive hover:bg-destructive/30 transition-colors disabled:opacity-50"
                          >
                            {deleteFile.isPending ? "Deleting…" : "Delete"}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteFileId(null)}
                            className="flex-1 text-[10px] py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={file.id}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors group",
                        selectedFileId === file.id
                          ? "bg-primary/10 text-primary border-r-2 border-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <button
                        onClick={() => switchToFile(file.id)}
                        className="flex items-center gap-2 flex-1 min-w-0 text-left"
                      >
                        <FileIcon path={file.path} />
                        <span className="truncate font-mono">{file.path}</span>
                        {selectedFileId === file.id && isDirty && (
                          <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                        )}
                      </button>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(file.id, file.path);
                          }}
                          title="Rename"
                          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteFileId(file.id);
                          }}
                          title="Delete"
                          className="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {sidebarMode === "search" && (
          <>
            <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Search
              </span>
            </div>
            <div className="flex-1 min-h-0">
              <FileSearchPanel projectId={projectId} onFileSelect={switchToFile} />
            </div>
          </>
        )}

        {sidebarMode === "snippets" && (
          <>
            <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
              <Layers className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Snippets
              </span>
            </div>
            <div className="flex-1 min-h-0">
              <SnippetLibraryPanel
                onInsert={(prompt) => {
                  onSnippetInsert?.(prompt);
                  toast({ title: "Snippet sent", description: "Check the AI Builder chat below." });
                }}
              />
            </div>
          </>
        )}

        {sidebarMode === "packages" && (
          <>
            <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
              <Package className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Packages
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <PackageManagerPanel projectId={projectId} files={files} />
            </div>
          </>
        )}

        {sidebarMode === "git" && (
          <>
            <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
              <Github className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Git
              </span>
            </div>
            <div className="flex-1 min-h-0">
              <GitPushPanel projectId={projectId} />
            </div>
          </>
        )}
      </div>

      {/* Monaco editor area */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0 bg-[#1e1e1e]">
        {selectedFile ? (
          <>
            {/* File breadcrumb bar */}
            <div className="shrink-0 px-4 py-2 border-b border-white/10 bg-[#252526] flex items-center gap-2">
              <FileIcon path={selectedFile.path} />
              <span className="text-[11px] font-mono text-[#cccccc]">{selectedFile.path}</span>
              {isDirty && (
                <span className="text-[10px] text-yellow-400/80 flex items-center gap-1">
                  <span className="w-1 h-1 rounded-full bg-yellow-400 inline-block" />
                  unsaved
                </span>
              )}
              <span className="ml-auto text-[10px] text-[#858585] px-1.5 py-0.5 rounded bg-[#2d2d2d] border border-white/10">
                {getLanguage(selectedFile.path)}
              </span>
              {isDirty && (
                <button
                  onClick={() => void handleSave()}
                  disabled={updateFile.isPending}
                  className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60 ml-1"
                >
                  <Save className="h-3 w-3" />
                  {updateFile.isPending ? "Saving…" : "Save"}
                </button>
              )}
            </div>

            {/* Unsaved changes warning */}
            {showUnsavedWarning && (
              <div className="shrink-0 px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20 flex items-center gap-2 text-xs text-yellow-400">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">
                  You have unsaved changes. Save before switching, or discard them.
                </span>
                <button
                  onClick={() =>
                    void handleSave().then((ok) => {
                      if (ok && pendingFileId !== null) {
                        setSelectedFileId(pendingFileId);
                        setEditorContent(null);
                        setIsDirty(false);
                        setShowUnsavedWarning(false);
                        setPendingFileId(null);
                        try {
                          localStorage.setItem(EDITOR_LS_KEY(projectId), String(pendingFileId));
                        } catch {
                          // intentionally ignored
                        }
                      }
                    })
                  }
                  className="px-2 py-0.5 rounded bg-yellow-500/20 hover:bg-yellow-500/30 transition-colors whitespace-nowrap"
                >
                  Save & switch
                </button>
                <button
                  onClick={discardAndSwitch}
                  className="px-2 py-0.5 rounded hover:bg-white/10 transition-colors whitespace-nowrap"
                >
                  Discard
                </button>
                <button
                  onClick={cancelSwitch}
                  className="px-2 py-0.5 rounded hover:bg-white/10 transition-colors whitespace-nowrap"
                >
                  Cancel
                </button>
              </div>
            )}

            <div className="flex-1 min-h-0">
              <Editor
                height="100%"
                language={getLanguage(selectedFile.path)}
                value={displayContent}
                onChange={handleEditorChange}
                theme="vs-dark"
                onMount={(ed) => {
                  editorRef.current = ed;
                }}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  lineHeight: 20,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  renderLineHighlight: "line",
                  folding: true,
                  padding: { top: 16, bottom: 16 },
                  scrollbar: { vertical: "auto", horizontal: "auto" },
                  overviewRulerLanes: 0,
                  hideCursorInOverviewRuler: true,
                }}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <FileCode2 className="h-10 w-10 opacity-20 text-white" />
            <div className="text-center">
              <div className="text-sm font-medium text-white/50">Select a file to edit</div>
              <div className="text-[11px] mt-1 text-white/30">
                {files.length === 0
                  ? "Build something first — your files will appear here"
                  : "Click any file in the panel on the left"}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Delete confirmation overlay */}
      {confirmDeleteFile && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl space-y-4">
            <div className="space-y-1.5">
              <div className="font-semibold text-foreground">Delete file?</div>
              <div className="text-sm text-muted-foreground">
                <span className="font-mono text-foreground">{confirmDeleteFile.path}</span> will be
                permanently deleted. This cannot be undone.
              </div>
            </div>
            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={() => setConfirmDeleteFileId(null)}
                className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDeleteFile(confirmDeleteFile.id)}
                disabled={deleteFile.isPending}
                className="px-3 py-1.5 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50"
              >
                {deleteFile.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
