import { useState, useRef, useEffect } from "react";
import {
  useListProjectFiles,
  useDeleteProjectFile,
  useRenameProjectFile,
  useCreateProjectFile,
  getListProjectFilesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileCode2,
  FileText,
  FileJson,
  Globe,
  FileCog,
  FileType,
  Plus,
  Loader2,
  Trash2,
  Pencil,
  Download,
  FolderPlus,
  Copy,
  MoveHorizontal,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface FileEntry {
  id: number;
  path: string;
  content?: string;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  file?: FileEntry;
}

function buildTree(files: FileEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sortedFiles) {
    const parts = file.path.split("/");
    let current = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      let dir = dirMap.get(dirPath);
      if (!dir) {
        dir = {
          name: parts[i]!,
          path: dirPath,
          isDir: true,
          children: [],
        };
        dirMap.set(dirPath, dir);
        current.push(dir);
      }
      current = dir.children;
    }

    const fileName = parts[parts.length - 1]!;
    current.push({
      name: fileName,
      path: file.path,
      isDir: false,
      children: [],
      file,
    });
  }

  function sortNodes(nodes: TreeNode[]): TreeNode[] {
    return nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function sortAll(nodes: TreeNode[]): TreeNode[] {
    sortNodes(nodes);
    for (const node of nodes) sortAll(node.children);
    return nodes;
  }

  return sortAll(root);
}

function FileIcon({ path, className }: { path: string; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  if (path.endsWith(".html") || path.endsWith(".htm"))
    return <Globe className={cn(cls, "text-orange-400")} />;
  if (path.endsWith(".css")) return <FileType className={cn(cls, "text-blue-400")} />;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs"))
    return <FileCog className={cn(cls, "text-yellow-400")} />;
  if (path.endsWith(".ts") || path.endsWith(".tsx"))
    return <FileCog className={cn(cls, "text-blue-500")} />;
  if (path.endsWith(".json")) return <FileJson className={cn(cls, "text-green-400")} />;
  if (path.endsWith(".md") || path.endsWith(".mdx"))
    return <FileText className={cn(cls, "text-zinc-400")} />;
  if (path.endsWith(".py")) return <FileCog className={cn(cls, "text-yellow-300")} />;
  if (path.endsWith(".sh") || path.endsWith(".bash"))
    return <FileCog className={cn(cls, "text-green-300")} />;
  return <FileCode2 className={cn(cls, "text-muted-foreground")} />;
}

interface ContextMenuState {
  x: number;
  y: number;
  node: TreeNode;
}

interface FileTreeProps {
  projectId: number;
  onFileOpen: (file: FileEntry) => void;
  activeFilePath?: string;
}

export function FileTree({ projectId, onFileOpen, activeFilePath }: FileTreeProps) {
  const { data: files, isLoading } = useListProjectFiles(projectId, {
    query: { queryKey: getListProjectFilesQueryKey(projectId) },
  });
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createFile = useCreateProjectFile();
  const deleteFile = useDeleteProjectFile();
  const renameFile = useRenameProjectFile();

  const [expanded, setExpanded] = useState<Set<string>>(new Set(["src", ""]));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creatingIn, setCreatingIn] = useState<{ dirPath: string; type: "file" | "folder" } | null>(
    null,
  );
  const [createValue, setCreateValue] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [movingFile, setMovingFile] = useState<TreeNode | null>(null);
  const [moveValue, setMoveValue] = useState("");
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const typedFiles: FileEntry[] = (files as FileEntry[] | undefined) ?? [];
  const tree = buildTree(typedFiles);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });

  useEffect(() => {
    const close = () => setContextMenu(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const toggleExpanded = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleRightClick = (e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };

  const handleSelect = (e: React.MouseEvent, path: string) => {
    if (e.shiftKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    } else {
      setSelected(new Set([path]));
    }
  };

  const startRename = (node: TreeNode) => {
    setContextMenu(null);
    setRenamingPath(node.path);
    setRenameValue(node.name);
  };

  const commitRename = async () => {
    if (!renamingPath || !renameValue.trim()) {
      setRenamingPath(null);
      return;
    }
    const parts = renamingPath.split("/");
    parts[parts.length - 1] = renameValue.trim();
    const newPath = parts.join("/");
    if (newPath === renamingPath) {
      setRenamingPath(null);
      return;
    }
    const file = typedFiles.find((f) => f.path === renamingPath);
    if (!file) {
      setRenamingPath(null);
      return;
    }
    try {
      await renameFile.mutateAsync({ id: projectId, fileId: file.id, data: { path: newPath } });
      await invalidate();
    } catch {
      toast({ title: "Rename failed", variant: "destructive" });
    }
    setRenamingPath(null);
  };

  const startMove = (node: TreeNode) => {
    setContextMenu(null);
    setMovingFile(node);
    setMoveValue(node.path);
  };

  const commitMove = async () => {
    if (
      !movingFile ||
      !movingFile.file ||
      !moveValue.trim() ||
      moveValue.trim() === movingFile.path
    ) {
      setMovingFile(null);
      return;
    }
    try {
      await renameFile.mutateAsync({
        id: projectId,
        fileId: movingFile.file.id,
        data: { path: moveValue.trim() },
      });
      await invalidate();
      toast({ title: `Moved to ${moveValue.trim()}` });
    } catch {
      toast({ title: "Move failed", variant: "destructive" });
    } finally {
      setMovingFile(null);
    }
  };

  const handleDuplicate = async (node: TreeNode) => {
    setContextMenu(null);
    if (!node.file) return;
    const dotIdx = node.name.lastIndexOf(".");
    const base = dotIdx > 0 ? node.name.slice(0, dotIdx) : node.name;
    const suffix = dotIdx > 0 ? node.name.slice(dotIdx) : "";
    const parts = node.path.split("/");
    parts[parts.length - 1] = `${base}-copy${suffix}`;
    const newPath = parts.join("/");
    try {
      await createFile.mutateAsync({
        id: projectId,
        data: { path: newPath, content: node.file.content ?? "" },
      });
      await invalidate();
      toast({ title: `Duplicated as ${parts[parts.length - 1]}` });
    } catch {
      toast({ title: "Duplicate failed", variant: "destructive" });
    }
  };

  const handleDelete = async (node: TreeNode) => {
    setContextMenu(null);
    if (!node.file) return;
    try {
      await deleteFile.mutateAsync({ id: projectId, fileId: node.file.id });
      await invalidate();
      toast({ title: `Deleted ${node.name}` });
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    }
  };

  const startCreate = (dirPath: string, type: "file" | "folder") => {
    setContextMenu(null);
    setCreatingIn({ dirPath, type });
    setCreateValue("");
    if (!expanded.has(dirPath)) {
      setExpanded((prev) => new Set([...prev, dirPath]));
    }
  };

  const commitCreate = async () => {
    if (!creatingIn || !createValue.trim()) {
      setCreatingIn(null);
      return;
    }
    const name = createValue.trim();
    const dirPath = creatingIn.dirPath;
    const newPath = dirPath ? `${dirPath}/${name}` : name;

    if (creatingIn.type === "folder") {
      // Folders are virtual — create a .gitkeep placeholder to materialise the directory
      const keepPath = `${newPath}/.gitkeep`;
      try {
        await createFile.mutateAsync({ id: projectId, data: { path: keepPath, content: "" } });
        await invalidate();
        setExpanded((prev) => new Set([...prev, newPath]));
      } catch {
        toast({ title: "Failed to create folder", variant: "destructive" });
      }
    } else {
      try {
        await createFile.mutateAsync({ id: projectId, data: { path: newPath, content: "" } });
        await invalidate();
        const created = typedFiles.find((f) => f.path === newPath);
        if (created) onFileOpen(created);
      } catch {
        toast({ title: "Failed to create file", variant: "destructive" });
      }
    }
    setCreatingIn(null);
  };

  const handleDownload = (node: TreeNode) => {
    setContextMenu(null);
    if (!node.file) return;
    const blob = new Blob([node.file.content ?? ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = node.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  function renderNode(node: TreeNode, depth: number): React.ReactNode {
    const isExpanded = expanded.has(node.path);
    const isActive = !node.isDir && node.path === activeFilePath;
    const isSelected = selected.has(node.path);
    const isRenaming = renamingPath === node.path;

    const indent = depth * 12;

    return (
      <div key={node.path}>
        <div
          className={cn(
            "flex items-center gap-1.5 py-0.5 pr-2 cursor-pointer select-none rounded-sm group",
            "hover:bg-muted/50",
            isActive && "bg-primary/10 text-primary",
            isSelected && !isActive && "bg-muted",
          )}
          style={{ paddingLeft: 8 + indent }}
          onClick={(e) => {
            handleSelect(e, node.path);
            if (node.isDir) {
              toggleExpanded(node.path);
            } else if (node.file) {
              onFileOpen(node.file);
            }
          }}
          onContextMenu={(e) => handleRightClick(e, node)}
        >
          {node.isDir ? (
            <>
              {isExpanded ? (
                <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
              )}
              {isExpanded ? (
                <FolderOpen className="h-4 w-4 text-blue-400 shrink-0" />
              ) : (
                <Folder className="h-4 w-4 text-blue-400 shrink-0" />
              )}
            </>
          ) : (
            <>
              <span className="w-3 shrink-0" />
              <FileIcon path={node.path} />
            </>
          )}

          {isRenaming ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") setRenamingPath(null);
              }}
              className="flex-1 min-w-0 text-xs bg-background border border-primary/40 rounded px-1 outline-none"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className={cn(
                "text-[12px] truncate flex-1 min-w-0",
                isActive ? "text-primary font-medium" : "text-foreground/80",
              )}
            >
              {node.name}
            </span>
          )}
        </div>

        {node.isDir && isExpanded && (
          <div>
            {creatingIn?.dirPath === node.path && (
              <div
                className="flex items-center gap-1.5 py-0.5 pr-2"
                style={{ paddingLeft: 8 + indent + 12 }}
              >
                <span className="w-3 shrink-0" />
                {creatingIn.type === "folder" ? (
                  <Folder className="h-4 w-4 text-blue-400 shrink-0" />
                ) : (
                  <FileCode2 className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <input
                  autoFocus
                  value={createValue}
                  onChange={(e) => setCreateValue(e.target.value)}
                  onBlur={() => void commitCreate()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitCreate();
                    if (e.key === "Escape") setCreatingIn(null);
                  }}
                  placeholder={creatingIn.type === "folder" ? "folder name" : "file name"}
                  className="flex-1 min-w-0 text-xs bg-background border border-primary/40 rounded px-1 outline-none"
                />
              </div>
            )}
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Files
        </span>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => startCreate("", "file")}
                className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="New File"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>New File</TooltipContent>
          </Tooltip>
          <button
            onClick={() => startCreate("", "folder")}
            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="New Folder"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        {creatingIn?.dirPath === "" && (
          <div className="flex items-center gap-1.5 py-0.5 pr-2 pl-2">
            <span className="w-3 shrink-0" />
            {creatingIn.type === "folder" ? (
              <Folder className="h-4 w-4 text-blue-400 shrink-0" />
            ) : (
              <FileCode2 className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
            <input
              autoFocus
              value={createValue}
              onChange={(e) => setCreateValue(e.target.value)}
              onBlur={() => void commitCreate()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitCreate();
                if (e.key === "Escape") setCreatingIn(null);
              }}
              placeholder={creatingIn.type === "folder" ? "folder name" : "file name"}
              className="flex-1 min-w-0 text-xs bg-background border border-primary/40 rounded px-1 outline-none"
            />
          </div>
        )}
        {tree.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <FileCode2 className="h-8 w-8 text-muted-foreground/20 mx-auto mb-2" />
            <div className="text-[11px] text-muted-foreground">No files yet</div>
          </div>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}
      </div>

      {/* Move path overlay */}
      {movingFile && (
        <div className="absolute inset-x-0 bottom-0 z-40 border-t border-border bg-card p-2 shadow-lg">
          <div className="text-[10px] text-muted-foreground mb-1">
            Move <span className="font-medium text-foreground">{movingFile.name}</span> to:
          </div>
          <input
            autoFocus
            value={moveValue}
            onChange={(e) => setMoveValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitMove();
              if (e.key === "Escape") setMovingFile(null);
            }}
            className="w-full bg-muted border border-border rounded px-2 py-1 text-xs text-foreground outline-none focus:border-primary/50"
          />
          <div className="flex gap-1 mt-1">
            <button
              onClick={() => void commitMove()}
              className="flex-1 text-[10px] font-medium bg-primary text-primary-foreground rounded py-0.5 hover:bg-primary/90 transition-colors"
            >
              Move
            </button>
            <button
              onClick={() => setMovingFile(null)}
              className="flex-1 text-[10px] font-medium bg-muted text-foreground rounded py-0.5 hover:bg-muted/80 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[160px] text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {contextMenu.node.isDir && (
            <>
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-foreground hover:bg-muted transition-colors"
                onClick={() => startCreate(contextMenu.node.path, "file")}
              >
                <Plus className="h-3.5 w-3.5" /> New File
              </button>
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-foreground hover:bg-muted transition-colors"
                onClick={() => startCreate(contextMenu.node.path, "folder")}
              >
                <FolderPlus className="h-3.5 w-3.5" /> New Folder
              </button>
              <div className="border-t border-border my-1" />
            </>
          )}
          <button
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-foreground hover:bg-muted transition-colors"
            onClick={() => startRename(contextMenu.node)}
          >
            <Pencil className="h-3.5 w-3.5" /> Rename
          </button>
          {!contextMenu.node.isDir && (
            <>
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-foreground hover:bg-muted transition-colors"
                onClick={() => startMove(contextMenu.node)}
              >
                <MoveHorizontal className="h-3.5 w-3.5" /> Move…
              </button>
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-foreground hover:bg-muted transition-colors"
                onClick={() => void handleDuplicate(contextMenu.node)}
              >
                <Copy className="h-3.5 w-3.5" /> Duplicate
              </button>
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-foreground hover:bg-muted transition-colors"
                onClick={() => handleDownload(contextMenu.node)}
              >
                <Download className="h-3.5 w-3.5" /> Download
              </button>
              <div className="border-t border-border my-1" />
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-red-400 hover:bg-muted transition-colors"
                onClick={() => void handleDelete(contextMenu.node)}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
