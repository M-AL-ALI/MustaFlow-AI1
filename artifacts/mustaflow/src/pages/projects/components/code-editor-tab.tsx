import { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
type MonacoEditor = Parameters<OnMount>[0];
import {
  useListProjectFiles,
  useGetProjectFile,
  useUpdateProjectFile,
  useCreateProjectFile,
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
  if (path.endsWith(".svg") || path.endsWith(".xml")) return "xml";
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

type SidebarMode = "files" | "search" | "snippets";

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
            <div className="text-[10px] text-muted-foreground">Type to search across all project files</div>
          </div>
        )}
        {searched && results.length === 0 && query && (
          <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">No matches found</div>
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
                  <div className="text-[11px] font-medium text-foreground truncate">{snippet.name}</div>
                  <div className="text-[10px] text-muted-foreground truncate">{snippet.description}</div>
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
                  <p className="text-[10px] text-muted-foreground leading-relaxed">{snippet.prompt}</p>
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
  const [selectedFileId, setSelectedFileId] = useState<number | null>(initialFileId ?? null);
  const [pendingFileId, setPendingFileId] = useState<number | null>(null);
  const [editorContent, setEditorContent] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);

  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const newFileInputRef = useRef<HTMLInputElement>(null);

  // Monaco editor instance ref for programmatic line navigation
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

  const selectedFile = files.find((f) => f.id === selectedFileId) ?? null;

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
    }
    setSidebarMode("files");
  }

  // Reveal the pending line once file content loads and editor is mounted
  useEffect(() => {
    const line = pendingRevealLineRef.current;
    if (!line || !editorRef.current) return;
    // Small delay to let Monaco finish rendering the new file content
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
      toast({ title: "File created", description: trimmed });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Could not create file.";
      toast({ title: "Create failed", description: msg, variant: "destructive" });
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
                  <div className="text-[10px] text-muted-foreground/60 mt-0.5">Build something first.</div>
                </div>
              ) : (
                files.map((file) => (
                  <button
                    key={file.id}
                    onClick={() => switchToFile(file.id)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors",
                      selectedFileId === file.id
                        ? "bg-primary/10 text-primary border-r-2 border-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <FileIcon path={file.path} />
                    <span className="truncate font-mono">{file.path}</span>
                    {selectedFileId === file.id && isDirty && (
                      <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                    )}
                  </button>
                ))
              )}
            </div>
          </>
        )}

        {sidebarMode === "search" && (
          <>
            <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Search</span>
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
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Snippets</span>
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
                onMount={(ed) => { editorRef.current = ed; }}
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
    </div>
  );
}
