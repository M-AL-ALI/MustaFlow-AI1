import { useState, useCallback, useRef } from "react";
import Editor from "@monaco-editor/react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

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

export function CodeEditorTab({
  projectId,
  initialFileId,
  onHtmlFileSaved,
}: {
  projectId: number;
  initialFileId?: number | null;
  onHtmlFileSaved?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedFileId, setSelectedFileId] = useState<number | null>(initialFileId ?? null);
  const [pendingFileId, setPendingFileId] = useState<number | null>(null);
  const [editorContent, setEditorContent] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);

  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const newFileInputRef = useRef<HTMLInputElement>(null);

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

  function switchToFile(fileId: number) {
    if (isDirty) {
      setPendingFileId(fileId);
      setShowUnsavedWarning(true);
    } else {
      setSelectedFileId(fileId);
      setEditorContent(null);
      setIsDirty(false);
      setShowUnsavedWarning(false);
    }
  }

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
      {/* File tree */}
      <div className="w-52 shrink-0 border-r border-border bg-sidebar flex flex-col min-h-0">
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
