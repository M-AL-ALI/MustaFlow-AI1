import { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount, DiffEditor } from "@monaco-editor/react";
import { useUpdateProjectFile } from "@workspace/api-client-react";
import {
  X,
  Save,
  Loader2,
  FileCode2,
  Globe,
  FileCog,
  FileType,
  FileJson,
  FileText,
  Circle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

type MonacoEditor = Parameters<OnMount>[0];
type Monaco = Parameters<OnMount>[1];

export interface EditorTab {
  fileId: number;
  path: string;
  content: string;
  isDirty: boolean;
  lineNumber?: number;
}

interface DiffView {
  fileId: number;
  path: string;
  original: string;
  modified: string;
}

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
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".java")) return "java";
  if (path.endsWith(".rb")) return "ruby";
  if (path.endsWith(".php")) return "php";
  if (path.endsWith(".cpp") || path.endsWith(".cc") || path.endsWith(".c")) return "cpp";
  return "plaintext";
}

function FileTabIcon({ path }: { path: string }) {
  const cls = "h-3.5 w-3.5 shrink-0";
  if (path.endsWith(".html") || path.endsWith(".htm"))
    return <Globe className={cn(cls, "text-orange-400")} />;
  if (path.endsWith(".css")) return <FileType className={cn(cls, "text-blue-400")} />;
  if (path.endsWith(".js") || path.endsWith(".mjs"))
    return <FileCog className={cn(cls, "text-yellow-400")} />;
  if (path.endsWith(".ts") || path.endsWith(".tsx"))
    return <FileCog className={cn(cls, "text-blue-500")} />;
  if (path.endsWith(".json")) return <FileJson className={cn(cls, "text-green-400")} />;
  if (path.endsWith(".md")) return <FileText className={cn(cls, "text-zinc-400")} />;
  if (path.endsWith(".py")) return <FileCog className={cn(cls, "text-yellow-300")} />;
  return <FileCode2 className={cn(cls, "text-muted-foreground")} />;
}

interface MonacoEditorPaneProps {
  projectId: number;
  tabs: EditorTab[];
  activeTabIndex: number;
  diffView: DiffView | null;
  onTabClose: (index: number) => void;
  onTabActivate: (index: number) => void;
  onContentChange: (index: number, content: string) => void;
  onFileSaved: (fileId: number) => void;
  onDiffClose: () => void;
}

export function MonacoEditorPane({
  projectId,
  tabs,
  activeTabIndex,
  diffView,
  onTabClose,
  onTabActivate,
  onContentChange,
  onFileSaved,
  onDiffClose,
}: MonacoEditorPaneProps) {
  const { toast } = useToast();
  const updateFile = useUpdateProjectFile();
  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const activeTab = tabs[activeTabIndex];

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    monaco.editor.defineTheme("mf-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#0d0f17",
        "editor.lineHighlightBackground": "#ffffff08",
        "editorLineNumber.foreground": "#3f4258",
        "editorLineNumber.activeForeground": "#6b7280",
        "editor.selectionBackground": "#3b4bdb40",
        "editor.inactiveSelectionBackground": "#3b4bdb20",
      },
    });
    monaco.editor.setTheme("mf-dark");

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void handleSave();
    });

    if (activeTab?.lineNumber) {
      editor.revealLineInCenter(activeTab.lineNumber);
      editor.setPosition({ lineNumber: activeTab.lineNumber, column: 1 });
    }
  };

  const handleSave = useCallback(async () => {
    if (!activeTab) return;
    setIsSaving(true);
    try {
      await updateFile.mutateAsync({
        id: projectId,
        fileId: activeTab.fileId,
        data: { content: activeTab.content },
      });
      onFileSaved(activeTab.fileId);
    } catch {
      toast({ title: "Failed to save file", variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  }, [activeTab, projectId, updateFile, onFileSaved, toast]);

  useEffect(() => {
    if (!activeTab?.lineNumber || !editorRef.current) return;
    editorRef.current.revealLineInCenter(activeTab.lineNumber);
    editorRef.current.setPosition({ lineNumber: activeTab.lineNumber, column: 1 });
  }, [activeTab?.lineNumber, activeTabIndex]);

  if (tabs.length === 0 && !diffView) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0d0f17] text-center gap-4">
        <FileCode2 className="h-12 w-12 text-muted-foreground/10" />
        <div>
          <div className="text-sm font-medium text-muted-foreground mb-1">No file open</div>
          <div className="text-xs text-muted-foreground/60">
            Select a file from the file tree to start editing
          </div>
        </div>
        <div className="text-[10px] text-muted-foreground/40 space-y-1">
          <div>Ctrl+S — Save file</div>
          <div>Ctrl+Z — Undo</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar */}
      {tabs.length > 0 && (
        <div className="flex items-center overflow-x-auto bg-zinc-950 border-b border-border shrink-0 min-h-0">
          {tabs.map((tab, i) => {
            const isActive = i === activeTabIndex && !diffView;
            return (
              <div
                key={`${tab.fileId}-${i}`}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 border-r border-border cursor-pointer group shrink-0 max-w-[180px]",
                  "transition-colors select-none",
                  isActive
                    ? "bg-[#0d0f17] text-foreground border-t-2 border-t-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-zinc-900",
                )}
                onClick={() => onTabActivate(i)}
              >
                <FileTabIcon path={tab.path} />
                <span className="text-[11px] truncate flex-1 min-w-0">
                  {tab.path.split("/").pop()}
                </span>
                {tab.isDirty && <Circle className="h-2 w-2 fill-current text-primary shrink-0" />}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(i);
                  }}
                  className="h-4 w-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-muted/60 transition-all shrink-0"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}

          <div className="flex-1" />

          {activeTab && !diffView && (
            <button
              onClick={() => void handleSave()}
              disabled={isSaving || !activeTab.isDirty}
              className={cn(
                "flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium transition-colors shrink-0",
                activeTab.isDirty
                  ? "text-primary hover:text-primary/80"
                  : "text-muted-foreground/40",
              )}
              title="Save (Ctrl+S)"
            >
              {isSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </button>
          )}
        </div>
      )}

      {/* Diff view banner */}
      {diffView && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/10 border-b border-yellow-500/20 shrink-0">
          <span className="text-[11px] text-yellow-400 font-medium flex-1">
            Diff view — {diffView.path.split("/").pop()}
          </span>
          <button
            onClick={onDiffClose}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-2 py-0.5 rounded hover:bg-muted transition-colors"
          >
            <X className="h-3 w-3" />
            Close diff
          </button>
        </div>
      )}

      {/* Editor / Diff */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {diffView ? (
          <DiffEditor
            height="100%"
            language={getLanguage(diffView.path)}
            original={diffView.original}
            modified={diffView.modified}
            theme="mf-dark"
            options={{
              readOnly: false,
              fontSize: 13,
              lineHeight: 20,
              fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderWhitespace: "boundary",
              wordWrap: "on",
            }}
          />
        ) : activeTab ? (
          <Editor
            height="100%"
            language={getLanguage(activeTab.path)}
            value={activeTab.content}
            theme="mf-dark"
            options={{
              fontSize: 13,
              lineHeight: 20,
              fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderWhitespace: "boundary",
              wordWrap: "on",
              tabSize: 2,
              insertSpaces: true,
              formatOnPaste: true,
              suggestOnTriggerCharacters: true,
              quickSuggestions: true,
              parameterHints: { enabled: true },
              folding: true,
              automaticLayout: true,
            }}
            onChange={(value) => {
              if (value !== undefined) onContentChange(activeTabIndex, value);
            }}
            onMount={handleEditorMount}
          />
        ) : null}
      </div>
    </div>
  );
}
