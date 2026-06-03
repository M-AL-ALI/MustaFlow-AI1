import { authFetch } from "@/lib/api-fetch";
import { useState, useRef, useCallback } from "react";
import { Search, Loader2, Regex } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchResult {
  fileId: number;
  file: string;
  lineNumber: number;
  lineContent: string;
}

interface SearchPanelProps {
  projectId: number;
  onNavigateToFile: (fileId: number, lineNumber?: number) => void;
}

export function SearchPanel({ projectId, onNavigateToFile }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
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
        const params = new URLSearchParams({ q });
        if (useRegex) params.set("regex", "1");
        const res = await authFetch(`/api/projects/${projectId}/files/search?${params.toString()}`);
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
    [projectId, useRegex],
  );

  const handleChange = (val: string) => {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void runSearch(val), 400);
  };

  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    if (!acc[r.file]) acc[r.file] = [];
    acc[r.file]!.push(r);
    return acc;
  }, {});

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Search
        </span>
      </div>

      {/* Search input */}
      <div className="px-2 py-2 border-b border-border shrink-0">
        <div className="relative flex items-center">
          <Search className="absolute left-2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="Search in files…"
            className="w-full pl-7 pr-8 py-1.5 text-xs bg-background border border-border rounded text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={() => {
              setUseRegex((r) => !r);
              if (query) void runSearch(query);
            }}
            className={cn(
              "absolute right-2 flex items-center justify-center h-4 w-4 rounded transition-colors",
              useRegex ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
            title="Toggle regex"
          >
            <Regex className="h-3.5 w-3.5" />
          </button>
        </div>
        {isSearching && (
          <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            Searching…
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {!query && (
          <div className="px-3 py-8 text-center">
            <Search className="h-6 w-6 text-muted-foreground/20 mx-auto mb-2" />
            <div className="text-[11px] text-muted-foreground">
              Type to search across all project files
            </div>
            <div className="text-[10px] text-muted-foreground/60 mt-1">Toggle /.*/ for regex</div>
          </div>
        )}
        {searched && results.length === 0 && query && (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            No matches found for &ldquo;{query}&rdquo;
          </div>
        )}
        {Object.entries(grouped).map(([file, hits]) => (
          <div key={file}>
            <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide truncate bg-muted/30 border-b border-border/30 sticky top-0">
              {file}
              <span className="ml-1 text-muted-foreground/50">({hits.length})</span>
            </div>
            {hits.map((hit, i) => (
              <button
                key={i}
                onClick={() => onNavigateToFile(hit.fileId, hit.lineNumber)}
                className="w-full text-left px-2 py-1.5 flex items-start gap-2 hover:bg-muted/50 transition-colors border-b border-border/10 last:border-0"
              >
                <span className="text-[10px] text-muted-foreground shrink-0 w-7 text-right mt-px font-mono">
                  {hit.lineNumber}
                </span>
                <span className="text-[11px] font-mono text-foreground/80 truncate flex-1 min-w-0">
                  {hit.lineContent.trim()}
                </span>
              </button>
            ))}
          </div>
        ))}
        {results.length > 0 && (
          <div className="px-3 py-2 text-[10px] text-muted-foreground border-t border-border">
            {results.length} result{results.length !== 1 ? "s" : ""} in{" "}
            {Object.keys(grouped).length} file{Object.keys(grouped).length !== 1 ? "s" : ""}
          </div>
        )}
      </div>
    </div>
  );
}
