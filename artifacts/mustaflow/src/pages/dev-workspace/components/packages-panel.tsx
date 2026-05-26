import { useState, useCallback, useEffect, useRef } from "react";
import {
  Package,
  Search,
  Plus,
  Trash2,
  ExternalLink,
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface PackageEntry {
  name: string;
  version: string;
  isDev: boolean;
}

interface SearchResult {
  name: string;
  version: string;
  description: string;
  url?: string;
  score?: number;
}

interface PackagesPanelProps {
  projectId: number;
}

type Registry = "npm" | "pypi";

function PackageRow({
  pkg,
  projectId,
  onRemoved,
}: {
  pkg: PackageEntry;
  projectId: number;
  onRemoved: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const handleRemove = useCallback(async () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setRemoving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/packages/uninstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: pkg.name, dev: pkg.isDev }),
        credentials: "include",
      });
      if (res.ok) onRemoved();
    } catch {
      // ignore
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  }, [confirmRemove, projectId, pkg.name, pkg.isDev, onRemoved]);

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/30 group transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-mono text-foreground truncate">{pkg.name}</span>
          {pkg.isDev && (
            <span className="text-[9px] text-muted-foreground bg-muted border border-border rounded px-1 shrink-0">
              dev
            </span>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground">{pkg.version}</div>
      </div>
      <button
        onClick={() => void handleRemove()}
        onBlur={() => setTimeout(() => setConfirmRemove(false), 200)}
        className={cn(
          "h-5 w-5 flex items-center justify-center rounded transition-colors opacity-0 group-hover:opacity-100",
          confirmRemove
            ? "bg-red-500/20 text-red-400 opacity-100"
            : "text-muted-foreground hover:text-red-400 hover:bg-muted",
        )}
        title={confirmRemove ? "Click again to confirm removal" : "Remove package"}
      >
        {removing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
      </button>
    </div>
  );
}

function SearchResultRow({
  result,
  installing,
  onInstall,
}: {
  result: SearchResult;
  installing: boolean;
  onInstall: (name: string, dev: boolean) => void;
}) {
  const [showDevOption, setShowDevOption] = useState(false);

  return (
    <div className="px-3 py-2 border-b border-border/50 last:border-0">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-mono font-medium text-foreground truncate">
              {result.name}
            </span>
            <span className="text-[10px] text-muted-foreground shrink-0">{result.version}</span>
            {result.url && (
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground/50 hover:text-primary transition-colors shrink-0"
              >
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
          </div>
          {result.description && (
            <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2 leading-relaxed">
              {result.description}
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => onInstall(result.name, false)}
            disabled={installing}
            className="h-6 px-2 flex items-center gap-1 text-[10px] bg-primary text-primary-foreground rounded disabled:opacity-40 hover:bg-primary/90 transition-colors font-medium"
          >
            {installing ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <Plus className="h-2.5 w-2.5" />
            )}
            Install
          </button>
          <button
            onClick={() => setShowDevOption((v) => !v)}
            className="h-6 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="More options"
          >
            <ChevronDown
              className={cn("h-2.5 w-2.5 transition-transform", showDevOption && "rotate-180")}
            />
          </button>
        </div>
      </div>
      {showDevOption && (
        <div className="mt-1.5 flex justify-end">
          <button
            onClick={() => {
              onInstall(result.name, true);
              setShowDevOption(false);
            }}
            disabled={installing}
            className="h-5 px-2 text-[10px] text-muted-foreground border border-border rounded hover:bg-muted transition-colors"
          >
            Install as devDependency
          </button>
        </div>
      )}
    </div>
  );
}

export function PackagesPanel({ projectId }: PackagesPanelProps) {
  const [query, setQuery] = useState("");
  const [registry, setRegistry] = useState<Registry>("npm");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installingPkg, setInstallingPkg] = useState<string | null>(null);

  const [installed, setInstalled] = useState<PackageEntry[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);
  const [depsExpanded, setDepsExpanded] = useState(true);
  const [devDepsExpanded, setDevDepsExpanded] = useState(false);

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/packages`, { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const deps: PackageEntry[] = Object.entries(data.dependencies ?? {}).map(
          ([name, version]) => ({
            name,
            version,
            isDev: false,
          }),
        );
        const devDeps: PackageEntry[] = Object.entries(data.devDependencies ?? {}).map(
          ([name, version]) => ({ name, version, isDev: true }),
        );
        setInstalled([...deps, ...devDeps]);
      }
    } catch {
      // ignore
    } finally {
      setLoadingInstalled(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  const runSearch = useCallback(
    async (q: string) => {
      if (q.trim().length < 2) {
        setSearchResults([]);
        return;
      }
      setSearching(true);
      setSearchError(null);
      try {
        const res = await fetch(
          `/api/projects/${projectId}/packages/search?q=${encodeURIComponent(q)}&registry=${registry}`,
          { credentials: "include" },
        );
        if (res.ok) {
          const data = (await res.json()) as { results: SearchResult[] };
          setSearchResults(data.results ?? []);
        } else {
          setSearchError("Search failed. Try again.");
        }
      } catch {
        setSearchError("Network error during search.");
      } finally {
        setSearching(false);
      }
    },
    [projectId, registry],
  );

  const handleQueryChange = useCallback(
    (q: string) => {
      setQuery(q);
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
      if (q.trim().length < 2) {
        setSearchResults([]);
        return;
      }
      searchTimeout.current = setTimeout(() => void runSearch(q), 400);
    },
    [runSearch],
  );

  const handleInstall = useCallback(
    async (name: string, dev: boolean) => {
      setInstallingPkg(name);
      try {
        const res = await fetch(`/api/projects/${projectId}/packages/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, dev }),
          credentials: "include",
        });
        if (res.ok) {
          setQuery("");
          setSearchResults([]);
          await loadInstalled();
        }
      } catch {
        // ignore
      } finally {
        setInstallingPkg(null);
      }
    },
    [projectId, loadInstalled],
  );

  const deps = installed.filter((p) => !p.isDev);
  const devDeps = installed.filter((p) => p.isDev);
  const showSearch = query.trim().length >= 2;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Packages
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRegistry(registry === "npm" ? "pypi" : "npm")}
            className="h-5 px-1.5 text-[9px] font-medium text-muted-foreground bg-muted border border-border rounded hover:text-foreground transition-colors"
            title="Switch registry"
          >
            {registry.toUpperCase()}
          </button>
          <button
            onClick={() => void loadInstalled()}
            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Refresh"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-2 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5 h-7 rounded-md bg-muted/50 border border-border px-2 focus-within:border-primary/50 transition-colors">
          {searching ? (
            <Loader2 className="h-3 w-3 text-muted-foreground shrink-0 animate-spin" />
          ) : (
            <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
          <input
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder={`Search ${registry} packages…`}
            className="flex-1 bg-transparent text-xs outline-none text-foreground placeholder:text-muted-foreground/60"
          />
          {query && (
            <button
              onClick={() => {
                setQuery("");
                setSearchResults([]);
              }}
              className="h-4 w-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {showSearch ? (
          <div>
            {searchError ? (
              <div className="flex items-start gap-1.5 text-xs text-red-400 px-3 py-3">
                <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                {searchError}
              </div>
            ) : searchResults.length === 0 && !searching ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No results for &quot;{query}&quot;
              </div>
            ) : (
              searchResults.map((r) => (
                <SearchResultRow
                  key={r.name}
                  result={r}
                  installing={installingPkg === r.name}
                  onInstall={(name, dev) => void handleInstall(name, dev)}
                />
              ))
            )}
          </div>
        ) : loadingInstalled ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : installed.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
            <div className="w-10 h-10 rounded-xl bg-muted/50 border border-border flex items-center justify-center">
              <Package className="h-5 w-5 text-muted-foreground/40" />
            </div>
            <div className="text-xs text-muted-foreground max-w-[160px] leading-relaxed">
              Search for packages above to install them.
            </div>
          </div>
        ) : (
          <div className="py-1">
            {/* Dependencies */}
            {deps.length > 0 && (
              <div>
                <button
                  onClick={() => setDepsExpanded((v) => !v)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                >
                  {depsExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  Dependencies ({deps.length})
                </button>
                {depsExpanded &&
                  deps.map((p) => (
                    <PackageRow
                      key={p.name}
                      pkg={p}
                      projectId={projectId}
                      onRemoved={() => void loadInstalled()}
                    />
                  ))}
              </div>
            )}

            {/* Dev Dependencies */}
            {devDeps.length > 0 && (
              <div>
                <button
                  onClick={() => setDevDepsExpanded((v) => !v)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                >
                  {devDepsExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  Dev Dependencies ({devDeps.length})
                </button>
                {devDepsExpanded &&
                  devDeps.map((p) => (
                    <PackageRow
                      key={p.name}
                      pkg={p}
                      projectId={projectId}
                      onRemoved={() => void loadInstalled()}
                    />
                  ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
