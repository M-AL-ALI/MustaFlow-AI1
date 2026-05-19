import { useState } from "react";
import Editor from "@monaco-editor/react";
import {
  useListProjectFiles,
  useGetProjectFile,
  getListProjectFilesQueryKey,
  getGetProjectFileQueryKey,
} from "@workspace/api-client-react";
import { FileCode2, FileText, FileJson, Globe, FileCog, FileType } from "lucide-react";
import { cn } from "@/lib/utils";

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
  if (path.endsWith(".css"))
    return <FileType className="h-3.5 w-3.5 shrink-0 text-blue-400" />;
  if (path.endsWith(".js") || path.endsWith(".mjs"))
    return <FileCog className="h-3.5 w-3.5 shrink-0 text-yellow-400" />;
  if (path.endsWith(".ts") || path.endsWith(".tsx"))
    return <FileCog className="h-3.5 w-3.5 shrink-0 text-blue-500" />;
  if (path.endsWith(".json"))
    return <FileJson className="h-3.5 w-3.5 shrink-0 text-green-400" />;
  if (path.endsWith(".md"))
    return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  return <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

export function CodeEditorTab({
  projectId,
  initialFileId,
}: {
  projectId: number;
  initialFileId?: number | null;
}) {
  const [selectedFileId, setSelectedFileId] = useState<number | null>(initialFileId ?? null);

  const { data: files = [] } = useListProjectFiles(projectId, {
    query: { queryKey: getListProjectFilesQueryKey(projectId) },
  });

  const { data: fileContent } = useGetProjectFile(projectId, selectedFileId ?? 0, {
    query: {
      enabled: selectedFileId !== null,
      queryKey: getGetProjectFileQueryKey(projectId, selectedFileId ?? 0),
    },
  });

  const selectedFile = files.find((f) => f.id === selectedFileId) ?? null;

  return (
    <div className="flex h-full min-h-0">
      {/* File tree */}
      <div className="w-52 shrink-0 border-r border-border bg-sidebar flex flex-col min-h-0">
        <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
          <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Files {files.length > 0 && `(${files.length})`}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {files.length === 0 ? (
            <div className="px-3 py-6 text-center">
              <FileCode2 className="h-6 w-6 text-muted-foreground/30 mx-auto mb-2" />
              <div className="text-[11px] text-muted-foreground">No files yet.</div>
              <div className="text-[10px] text-muted-foreground/60 mt-0.5">Build something first.</div>
            </div>
          ) : (
            files.map((file) => (
              <button
                key={file.id}
                onClick={() => setSelectedFileId(file.id)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left transition-colors",
                  selectedFileId === file.id
                    ? "bg-primary/10 text-primary border-r-2 border-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <FileIcon path={file.path} />
                <span className="truncate font-mono">{file.path}</span>
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
              <span className="ml-auto text-[10px] text-[#858585] px-1.5 py-0.5 rounded bg-[#2d2d2d] border border-white/10">
                {getLanguage(selectedFile.path)}
              </span>
            </div>
            <div className="flex-1 min-h-0">
              <Editor
                height="100%"
                language={getLanguage(selectedFile.path)}
                value={fileContent?.content ?? "// Loading…"}
                theme="vs-dark"
                options={{
                  readOnly: true,
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
              <div className="text-sm font-medium text-white/50">Select a file to view its code</div>
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
