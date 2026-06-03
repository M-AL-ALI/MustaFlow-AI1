import { authFetch } from "@/lib/api-fetch";
import { useState, useCallback, useEffect, useRef } from "react";
import {
  Boxes,
  Upload,
  Trash2,
  Copy,
  Download,
  Loader2,
  FileIcon,
  Image,
  FileCode2,
  FileText,
  RefreshCw,
  AlertCircle,
  Check,
  ExternalLink,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ProjectUpload {
  id: number;
  name: string;
  objectPath: string;
  contentType?: string;
  sizeBytes?: number;
  createdAt: string;
  publicUrl?: string;
}

interface ObjectStoragePanelProps {
  projectId: number;
}

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(contentType: string | undefined) {
  if (!contentType) return FileIcon;
  if (contentType.startsWith("image/")) return Image;
  if (contentType.startsWith("text/")) return FileText;
  if (contentType.includes("json") || contentType.includes("javascript")) return FileCode2;
  return FileIcon;
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function FileRow({
  file,
  projectId,
  onDeleted,
}: {
  file: ProjectUpload;
  projectId: number;
  onDeleted: () => void;
}) {
  const Icon = getFileIcon(file.contentType);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleCopyUrl = useCallback(() => {
    const url = file.publicUrl ?? `/api/storage/objects/${file.objectPath}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [file]);

  const handleDelete = useCallback(async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}/uploads/${file.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) onDeleted();
    } catch {
      // ignore
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }, [confirmDelete, projectId, file.id, onDeleted]);

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 last:border-0 hover:bg-muted/20 group transition-colors">
      <div className="flex items-center justify-center h-7 w-7 rounded bg-muted/60 shrink-0">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-foreground truncate font-medium">{file.name}</div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>{formatBytes(file.sizeBytes)}</span>
          <span>·</span>
          <span>{relativeTime(file.createdAt)}</span>
        </div>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button
          onClick={handleCopyUrl}
          className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Copy URL"
        >
          {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
        </button>
        {(file.publicUrl ?? file.objectPath) && (
          <a
            href={file.publicUrl ?? `/api/storage/objects/${file.objectPath}`}
            download={file.name}
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Download file"
          >
            <Download className="h-3 w-3" />
          </a>
        )}
        {file.publicUrl && (
          <a
            href={file.publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Open file"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <button
          onClick={() => void handleDelete()}
          onBlur={() => setTimeout(() => setConfirmDelete(false), 200)}
          className={cn(
            "h-6 w-6 flex items-center justify-center rounded transition-colors",
            confirmDelete
              ? "bg-red-500/20 text-red-400 opacity-100"
              : "text-muted-foreground hover:text-red-400 hover:bg-muted",
          )}
          title={confirmDelete ? "Click again to confirm" : "Delete file"}
        >
          {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
        </button>
      </div>
    </div>
  );
}

function CodeSnippet({ projectId }: { projectId: number }) {
  const [copied, setCopied] = useState(false);
  const code = `// Access your uploaded files
const response = await fetch('/api/projects/${projectId}/uploads');
const { uploads } = await response.json();

// Use a file's objectPath to serve it
// Public URL: /api/storage/public-objects/{objectPath}`;

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/40 border-b border-border">
        <span className="text-[10px] font-semibold text-muted-foreground">Code Snippet</span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          {copied ? <Check className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
      <pre className="text-[10px] font-mono text-muted-foreground p-3 overflow-x-auto whitespace-pre-wrap leading-relaxed">
        {code}
      </pre>
    </div>
  );
}

export function ObjectStoragePanel({ projectId }: ObjectStoragePanelProps) {
  const [files, setFiles] = useState<ProjectUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSnippet, setShowSnippet] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/uploads`, { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as { uploads: ProjectUpload[] };
        setFiles(data.uploads ?? []);
      } else {
        setError("Failed to load files.");
      }
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const handleUpload = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setUploading(true);
      setError(null);
      try {
        for (const file of Array.from(fileList)) {
          // Step 1: request presigned URL
          const urlRes = await authFetch(`/api/projects/${projectId}/uploads/request-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: file.name,
              contentType: file.type || "application/octet-stream",
              size: file.size,
            }),
            credentials: "include",
          });
          if (!urlRes.ok) {
            setError(`Failed to get upload URL for ${file.name}`);
            continue;
          }
          const { uploadURL, objectPath } = (await urlRes.json()) as {
            uploadURL: string;
            objectPath: string;
          };

          // Step 2: upload directly — must succeed before registering
          const putRes = await fetch(uploadURL, {
            method: "PUT",
            headers: { "Content-Type": file.type || "application/octet-stream" },
            body: file,
          });
          if (!putRes.ok) {
            setError(`Upload failed for ${file.name} (storage returned ${putRes.status})`);
            continue;
          }

          // Step 3: register the upload (only after confirmed PUT success)
          await authFetch(`/api/projects/${projectId}/uploads`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: file.name,
              contentType: file.type || "application/octet-stream",
              sizeBytes: file.size,
              objectPath,
            }),
            credentials: "include",
          });
        }
        await loadFiles();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed.");
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [projectId, loadFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      void handleUpload(e.dataTransfer.files);
    },
    [handleUpload],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleUpload(e.target.files)}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Object Storage
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void loadFiles()}
            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Refresh"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Upload file"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-2 space-y-2">
        {/* Upload drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "border-2 border-dashed border-border rounded-lg p-4 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors",
            "hover:border-primary/40 hover:bg-primary/5",
            uploading && "opacity-60 pointer-events-none",
          )}
        >
          {uploading ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <Upload className="h-5 w-5 text-muted-foreground" />
          )}
          <div className="text-[11px] text-muted-foreground text-center">
            {uploading ? "Uploading…" : "Drop files here or click to upload"}
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-1.5 text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {/* File list */}
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 gap-2 text-center">
            <Boxes className="h-8 w-8 text-muted-foreground/20" />
            <div className="text-[11px] text-muted-foreground">No files uploaded yet.</div>
          </div>
        ) : (
          <div className="border border-border rounded-md overflow-hidden bg-card">
            <div className="flex items-center justify-between px-3 py-1.5 bg-muted/40 border-b border-border">
              <span className="text-[10px] font-semibold text-muted-foreground">
                {files.length} file{files.length !== 1 ? "s" : ""}
              </span>
            </div>
            {files.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                projectId={projectId}
                onDeleted={() => void loadFiles()}
              />
            ))}
          </div>
        )}

        {/* Code snippet */}
        <button
          onClick={() => setShowSnippet((v) => !v)}
          className="w-full text-left text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
        >
          <FileCode2 className="h-3 w-3" />
          {showSnippet ? "Hide" : "Show"} code snippet
        </button>
        {showSnippet && <CodeSnippet projectId={projectId} />}
      </div>
    </div>
  );
}
