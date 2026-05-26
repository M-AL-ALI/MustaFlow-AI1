import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  X,
  Send,
  Loader2,
  CheckCircle2,
  RotateCcw,
  ChevronDown,
  Square,
  Zap,
  Layers2,
  Brain,
  Maximize2,
  Paperclip,
  ImagePlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DynamicAtom } from "@/components/icons/dynamic-atom";
import { AgentThinkingBubble } from "@/components/agent-thinking-bubble";
import { PlanCard, type StructuredPlan } from "./plan-card";
import { MarkdownMessage } from "./chat-history";
import { ToolCallGroup } from "./tool-call-card";
import {
  useListMessages,
  useSendMessage,
  useListTasks,
  useListVersions,
  useRollbackVersion,
  useListTaskEvents,
  getListMessagesQueryKey,
  getListTasksQueryKey,
  getListVersionsQueryKey,
  getListProjectFilesQueryKey,
  getGetProjectQueryKey,
  getListTaskEventsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type AgentMode = "lite" | "eco" | "power" | "pro";

const MODE_STORAGE_KEY = "mustaflow_zero_agent_mode";

type ZeroTask = {
  id: number;
  status: string;
  userRequest: string;
  createdAt: string;
};

type ZeroVersion = {
  id: number;
  userRequest?: string | null;
  changelogEntry?: string | null;
  createdAt?: string | null;
};

type ZeroMessage = {
  id: number;
  role: string;
  content: string;
  agentMode: string;
  planMode: boolean;
  plan?: Record<string, unknown> | null;
  createdAt: string;
};

type PendingAttachment = {
  kind: "image" | "file";
  name: string;
  /** objectPath stored in R2/local storage for images */
  url?: string;
  /** For non-image uploads registered in project uploads */
  uploadId?: number;
  uploading?: boolean;
  error?: string;
};

const AGENT_MODES: { value: AgentMode; label: string; credits: string }[] = [
  { value: "lite", label: "Lite", credits: "1 cr" },
  { value: "eco", label: "Eco", credits: "2 cr" },
  { value: "power", label: "Power", credits: "5 cr" },
  { value: "pro", label: "Pro", credits: "10 cr" },
];

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

function getModeStyle(mode: AgentMode) {
  if (mode === "pro") return "text-purple-400 border-purple-500/30 bg-purple-500/10";
  if (mode === "power") return "text-primary border-primary/30 bg-primary/10";
  if (mode === "eco") return "text-green-400 border-green-500/30 bg-green-500/10";
  return "text-muted-foreground border-border bg-muted/60";
}

function loadPersistedMode(): AgentMode {
  try {
    const v = localStorage.getItem(MODE_STORAGE_KEY);
    if (v === "lite" || v === "eco" || v === "power" || v === "pro") return v;
  } catch {
    /* ignore */
  }
  return "power";
}

function savePersistedMode(mode: AgentMode) {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** Resize an image file to ≤ 1500 px on either side for the vision model. */
async function resizeImageForVision(file: File): Promise<Blob> {
  const MAX = 1500;
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width <= MAX && height <= MAX) {
        resolve(file);
        return;
      }
      const scale = Math.min(MAX / width, MAX / height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((b) => resolve(b ?? file), file.type, 0.92);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

// Spec: user messages LEFT, Zero messages RIGHT
function UserBubble({ text, attachments }: { text: string; attachments?: PendingAttachment[] }) {
  return (
    <div className="flex justify-start px-3 py-1">
      <div className="max-w-[85%] bg-muted/70 border border-border rounded-2xl rounded-tl-sm px-3 py-2 text-xs text-foreground">
        {attachments && attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {attachments.map((a, i) =>
              a.kind === "image" && a.url ? (
                <img
                  key={i}
                  src={a.url.startsWith("/objects/") ? `/api/storage${a.url}` : a.url}
                  alt={a.name}
                  className="max-h-24 max-w-[120px] rounded-lg object-contain border border-border"
                />
              ) : (
                <span
                  key={i}
                  className="px-2 py-0.5 rounded border border-border bg-background/60 text-[10px] text-muted-foreground"
                >
                  {a.name}
                </span>
              ),
            )}
          </div>
        )}
        {text}
      </div>
    </div>
  );
}

// Zero messages RIGHT with DynamicAtom avatar
function ZeroBubble({ content }: { content: string }) {
  return (
    <div className="flex items-start justify-end gap-2 px-3 py-1">
      <div className="max-w-[85%] bg-primary/8 border border-primary/15 rounded-2xl rounded-tr-sm px-3 py-2 text-xs text-foreground leading-relaxed">
        <MarkdownMessage content={content} />
      </div>
      <div className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-primary/15 border border-primary/20 flex items-center justify-center">
        <DynamicAtom size={12} className="text-primary" animate={false} />
      </div>
    </div>
  );
}

// Plan card RIGHT with DynamicAtom avatar
function ZeroPlanBubble({
  plan,
  projectId,
  agentMode,
  messageId,
  isBusy,
  onBuild,
}: {
  plan: StructuredPlan;
  projectId: number;
  agentMode: AgentMode;
  messageId: number;
  isBusy: boolean;
  onBuild: (prompt: string, mode: AgentMode, bg: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-end gap-2 px-3 py-1">
      <div className="flex-1 min-w-0">
        <PlanCard
          plan={plan}
          projectId={projectId}
          initialAgentMode={agentMode}
          onBuild={onBuild}
          disabled={isBusy}
          messageId={messageId}
        />
      </div>
      <div className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-primary/15 border border-primary/20 flex items-center justify-center">
        <DynamicAtom size={12} className="text-primary" animate={false} />
      </div>
    </div>
  );
}

function CheckpointMarker({
  version,
  onRollback,
  isRollingBack,
}: {
  version: ZeroVersion;
  onRollback: (id: number) => void;
  isRollingBack: boolean;
}) {
  const ts = version.createdAt
    ? new Date(version.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const label = version.changelogEntry || version.userRequest || `Version #${version.id}`;

  return (
    <div className="flex items-center gap-2 py-2 px-3">
      <div className="flex-1 h-px bg-border/40" />
      <div className="flex flex-col items-center gap-0.5 shrink-0">
        <button
          onClick={() => onRollback(version.id)}
          disabled={isRollingBack}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-green-500/25 bg-green-500/5 text-green-400 text-[10px] font-medium hover:bg-green-500/10 hover:border-green-500/40 transition-colors disabled:opacity-50"
          title={`Restore to this checkpoint: ${label}`}
        >
          {isRollingBack ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-2.5 w-2.5" />
          )}
          Checkpoint saved{ts ? ` · ${ts}` : ""}
          <RotateCcw className="h-2.5 w-2.5 opacity-60" />
        </button>
        {label && (
          <span className="text-[9px] text-muted-foreground/50 max-w-48 truncate">{label}</span>
        )}
      </div>
      <div className="flex-1 h-px bg-border/40" />
    </div>
  );
}

/** Renders persisted tool-call events for a completed task inline in thread */
function PersistedToolEvents({
  projectId,
  taskId,
  taskStatus,
}: {
  projectId: number;
  taskId: number;
  taskStatus: string;
}) {
  const { data } = useListTaskEvents(projectId, taskId, {
    query: {
      queryKey: getListTaskEventsQueryKey(projectId, taskId),
      staleTime: 60_000,
      refetchInterval: TERMINAL_STATUSES.has(taskStatus) ? false : 5000,
    },
  });

  const events =
    (data as Array<{ id: number; eventType: string; message: string }> | undefined) ?? [];
  if (events.length === 0) return null;

  return <ToolCallGroup events={events} taskStatus={taskStatus} />;
}

export interface ZeroAgentPanelProps {
  projectId: number;
  isOpen: boolean;
  onClose: () => void;
  onBuildComplete?: () => void;
  onBackgroundRun?: (taskId: number | null) => void;
  /** Active background task ID so panel can reattach on re-open */
  initialActiveTaskId?: number | null;
  width?: number;
  onWidthChange?: (w: number) => void;
}

export function ZeroAgentPanel({
  projectId,
  isOpen,
  onClose,
  onBuildComplete,
  onBackgroundRun,
  initialActiveTaskId,
  width = 380,
  onWidthChange,
}: ZeroAgentPanelProps) {
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState("");
  const [agentMode, setAgentMode] = useState<AgentMode>(loadPersistedMode);
  const [planMode, setPlanMode] = useState(false);
  const [runInBackground, setRunInBackground] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(initialActiveTaskId ?? null);
  const [pendingStartedAt, setPendingStartedAt] = useState<Date | null>(null);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [isDetached, setIsDetached] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sendMessage = useSendMessage();
  const rollbackVersion = useRollbackVersion();

  // Reattach to a background task when the panel is (re)opened
  useEffect(() => {
    if (isOpen && initialActiveTaskId != null && activeTaskId == null) {
      setActiveTaskId(initialActiveTaskId);
      setPendingStartedAt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialActiveTaskId]);

  // Auto-focus the textarea when the panel opens (e.g. via keyboard shortcut)
  useEffect(() => {
    if (!isOpen) return;
    const id = setTimeout(() => {
      textareaRef.current?.focus();
    }, 50);
    return () => clearTimeout(id);
  }, [isOpen]);

  const { data: messages } = useListMessages(projectId, {
    query: {
      queryKey: getListMessagesQueryKey(projectId),
      refetchInterval: activeTaskId ? 3000 : 20000,
      staleTime: 2000,
    },
  });

  const { data: tasks } = useListTasks(projectId, {
    query: {
      queryKey: getListTasksQueryKey(projectId),
      refetchInterval: activeTaskId ? 2000 : 15000,
      staleTime: 1000,
    },
  });

  const { data: versions } = useListVersions(projectId, {
    query: {
      queryKey: getListVersionsQueryKey(projectId),
      refetchInterval: 20000,
      staleTime: 5000,
    },
  });

  const tasksArr = useMemo(() => (tasks as ZeroTask[] | undefined) ?? [], [tasks]);
  const versionsArr = useMemo(() => (versions as ZeroVersion[] | undefined) ?? [], [versions]);
  const messagesArr = useMemo(() => (messages as ZeroMessage[] | undefined) ?? [], [messages]);

  const activeTask = activeTaskId ? tasksArr.find((t) => t.id === activeTaskId) : null;
  const isTaskTerminal = activeTask ? TERMINAL_STATUSES.has(activeTask.status) : false;
  const isBusy = sendMessage.isPending || uploadingCount > 0 || (!!activeTaskId && !isTaskTerminal);

  const dismissBubble = useCallback(() => {
    setActiveTaskId(null);
    setPendingStartedAt(null);
    onBackgroundRun?.(null);
    void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
    onBuildComplete?.();
  }, [projectId, queryClient, onBuildComplete, onBackgroundRun]);

  const handleSetMode = useCallback((m: AgentMode) => {
    setAgentMode(m);
    savePersistedMode(m);
  }, []);

  // ── File upload ──────────────────────────────────────────────────────────
  const uploadImage = useCallback(
    async (file: File): Promise<PendingAttachment | null> => {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) return null;
      if (file.size > 5 * 1024 * 1024) return null;
      setUploadingCount((c) => c + 1);
      try {
        const blob = await resizeImageForVision(file);
        const res = await fetch(`/api/projects/${projectId}/attachments/upload-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ contentType: blob.type || file.type, sizeBytes: blob.size }),
        });
        if (!res.ok) return null;
        const { uploadUrl, objectPath } = (await res.json()) as {
          uploadUrl: string;
          objectPath: string;
        };
        const put = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": blob.type || file.type },
          body: blob,
        });
        if (!put.ok) return null;
        return { kind: "image", name: file.name, url: objectPath };
      } catch {
        return null;
      } finally {
        setUploadingCount((c) => Math.max(0, c - 1));
      }
    },
    [projectId],
  );

  const uploadNonImage = useCallback(
    async (file: File): Promise<PendingAttachment | null> => {
      setUploadingCount((c) => c + 1);
      try {
        const reqRes = await fetch(`/api/projects/${projectId}/uploads/request-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            name: file.name,
            size: file.size,
            contentType: file.type || "application/octet-stream",
          }),
        });
        if (!reqRes.ok) return null;
        const { uploadURL, objectPath } = (await reqRes.json()) as {
          uploadURL: string;
          objectPath: string;
        };
        const put = await fetch(uploadURL, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!put.ok) return null;
        const regRes = await fetch(`/api/projects/${projectId}/uploads`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            objectPath,
            name: file.name,
            size: file.size,
            contentType: file.type || "application/octet-stream",
          }),
        });
        if (!regRes.ok) return null;
        const row = (await regRes.json()) as { id: number; filename: string };
        return { kind: "file", name: row.filename, uploadId: row.id };
      } catch {
        return null;
      } finally {
        setUploadingCount((c) => Math.max(0, c - 1));
      }
    },
    [projectId],
  );

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).slice(0, 4);
      for (const file of list) {
        const placeholder: PendingAttachment = { kind: "image", name: file.name, uploading: true };
        setAttachments((prev) => [...prev, placeholder]);
        const result = file.type.startsWith("image/")
          ? await uploadImage(file)
          : await uploadNonImage(file);
        setAttachments((prev) =>
          prev.map((a) =>
            a === placeholder
              ? result
                ? { ...result, uploading: false }
                : {
                    kind: "file" as const,
                    name: file.name,
                    uploading: false,
                    error: "Upload failed",
                  }
              : a,
          ),
        );
      }
    },
    [uploadImage, uploadNonImage],
  );

  // ── Auto-scroll ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (nearBottom || activeTaskId) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages, activeTaskId, tasksArr]);

  // Close mode menu on outside click
  useEffect(() => {
    if (!showModeMenu) return;
    const h = (e: MouseEvent) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setShowModeMenu(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [showModeMenu]);

  // Drag-resize handle
  const onDragHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      const onMove = (ev: MouseEvent) => {
        const newW = Math.min(700, Math.max(280, startW + (startX - ev.clientX)));
        onWidthChange?.(newW);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, onWidthChange],
  );

  const doSend = useCallback(
    (content: string, opts?: { planMode?: boolean; background?: boolean; mode?: AgentMode }) => {
      if (!content.trim() || isBusy) return;
      const imageAttachments = attachments
        .filter((a) => a.kind === "image" && a.url && !a.uploading && !a.error)
        .map((a) => ({ kind: "image" as const, url: a.url!, alt: a.name }));

      // Non-image file uploads: append file names to message so the agent can
      // access them via list_uploads/read_upload tools (API only accepts image kind)
      const fileAttachments = attachments.filter(
        (a) => a.kind === "file" && a.uploadId && !a.uploading && !a.error,
      );
      const fileContext =
        fileAttachments.length > 0
          ? `\n\n[Uploaded files: ${fileAttachments.map((a) => a.name).join(", ")} — use list_uploads to access them]`
          : "";

      setAttachments([]);
      setActiveTaskId(null);
      setPendingStartedAt(new Date());

      const usePlan = opts?.planMode ?? planMode;
      const useBg = opts?.background ?? runInBackground;
      const useMode = opts?.mode ?? agentMode;

      sendMessage.mutate(
        {
          id: projectId,
          data: {
            content: content + fileContext,
            agentMode: useMode,
            planMode: usePlan,
            background: useBg,
            agentIntent: usePlan ? ("plan" as const) : ("build" as const),
            ...(imageAttachments.length > 0 ? { attachments: imageAttachments } : {}),
          },
        },
        {
          onSuccess: (data) => {
            const plan = data?.assistantMessage?.plan as Record<string, unknown> | null | undefined;
            const tid =
              plan && typeof plan === "object" ? (plan.taskId as number | undefined) : undefined;
            if (tid) {
              if (!useBg) {
                setActiveTaskId(tid);
              } else {
                onBackgroundRun?.(tid);
                onClose();
                setPendingStartedAt(null);
              }
            } else {
              setPendingStartedAt(null);
            }
            void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
            void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
          },
          onError: () => {
            setPendingStartedAt(null);
          },
        },
      );
    },
    [
      isBusy,
      attachments,
      planMode,
      runInBackground,
      agentMode,
      sendMessage,
      projectId,
      queryClient,
      onBackgroundRun,
      onClose,
    ],
  );

  const handleSend = useCallback(() => {
    const text = prompt.trim();
    if (!text && attachments.filter((a) => !a.error).length === 0) return;
    setPrompt("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    doSend(text || "(attached file)");
  }, [prompt, attachments, doSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleRollback = useCallback(
    (versionId: number) => {
      rollbackVersion.mutate(
        { id: projectId, versionId },
        {
          onSuccess: () => {
            void queryClient.invalidateQueries({
              queryKey: getListProjectFilesQueryKey(projectId),
            });
            void queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
            void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
          },
        },
      );
    },
    [projectId, queryClient, rollbackVersion],
  );

  const handleStopTask = useCallback(() => {
    if (!activeTaskId) return;
    void fetch(`/api/projects/${projectId}/tasks/${activeTaskId}/cancel`, {
      method: "POST",
      credentials: "include",
    }).then(() => {
      void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
    });
  }, [activeTaskId, projectId, queryClient]);

  const sortedMessages = useMemo(
    () =>
      [...messagesArr].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [messagesArr],
  );

  const sortedVersions = useMemo(
    () =>
      [...versionsArr].sort(
        (a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
      ),
    [versionsArr],
  );

  /** Build a map of taskId → task for associating plan payloads to events */
  const taskById = useMemo(() => new Map(tasksArr.map((t) => [t.id, t])), [tasksArr]);

  if (!isOpen) return null;

  return (
    <>
      {/* Drag-resize handle */}
      <div
        className="fixed top-0 bottom-0 z-[59] cursor-col-resize w-1.5 hover:bg-primary/25 transition-colors"
        style={{ right: width - 1 }}
        onMouseDown={onDragHandleMouseDown}
      />

      {/* Panel */}
      <div
        className={cn(
          "fixed top-0 right-0 bottom-0 z-[60] flex flex-col bg-card border-l border-border shadow-2xl",
          "animate-in slide-in-from-right duration-200",
          isDetached && "top-10 bottom-10 right-6 rounded-xl border shadow-2xl",
        )}
        style={{ width }}
      >
        {/* ── Header ── */}
        <div className="shrink-0 flex items-center gap-2 px-3 h-11 border-b border-border bg-card/80 backdrop-blur-sm">
          <span className="text-primary shrink-0">
            <DynamicAtom size={16} animate={isBusy} />
          </span>
          <span className="text-sm font-bold tracking-tight text-foreground">Zero</span>
          <span className="text-[10px] text-muted-foreground/40 font-mono">agent</span>

          {isBusy && (
            <span className="flex items-center gap-1 text-[10px] text-primary font-medium">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
              </span>
              Working…
            </span>
          )}

          <div className="flex-1" />

          {/* Mode selector — persisted to localStorage */}
          <div className="relative shrink-0" ref={modeMenuRef}>
            <button
              onClick={() => setShowModeMenu((v) => !v)}
              className={cn(
                "flex items-center gap-1 px-2 py-1 rounded-lg text-[9px] font-bold uppercase tracking-wide border transition-colors",
                getModeStyle(agentMode),
              )}
              title="Select builder mode"
            >
              <Zap className="h-2.5 w-2.5" />
              {agentMode}
              <ChevronDown className="h-2.5 w-2.5 opacity-50" />
            </button>
            {showModeMenu && (
              <div className="absolute top-full right-0 mt-1.5 w-44 bg-popover border border-border rounded-xl shadow-xl py-1 z-10">
                {AGENT_MODES.map((m) => (
                  <button
                    key={m.value}
                    onClick={() => {
                      handleSetMode(m.value);
                      setShowModeMenu(false);
                    }}
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-2 text-[11px] hover:bg-muted transition-colors",
                      "first:rounded-t-xl last:rounded-b-xl",
                      agentMode === m.value
                        ? "text-foreground font-semibold"
                        : "text-muted-foreground",
                    )}
                  >
                    <span>{m.label}</span>
                    <span className="text-muted-foreground/50">{m.credits}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => setIsDetached((v) => !v)}
            className="h-7 w-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title={isDetached ? "Dock panel" : "Float panel"}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Close Zero"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Thread ── */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-3 hide-scrollbar">
          {sortedMessages.length === 0 && !activeTaskId && !sendMessage.isPending && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
              <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <DynamicAtom size={32} className="text-primary" animate />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">Zero is ready</p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed max-w-[240px]">
                  Describe what to build or change. Zero reads files, writes code, and runs commands
                  — streaming every action live.
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5 justify-center mt-1">
                {[
                  "Add dark mode toggle",
                  "Fix mobile layout",
                  "Add search bar",
                  "Refactor auth",
                ].map((chip) => (
                  <button
                    key={chip}
                    onClick={() => {
                      setPrompt(chip);
                      textareaRef.current?.focus();
                    }}
                    className="px-2.5 py-1 rounded-full border border-border bg-muted/40 text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-colors"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages interleaved with tool events + checkpoint markers */}
          {sortedMessages.map((msg, idx) => {
            const msgTime = new Date(msg.createdAt).getTime();
            const nextTime =
              idx < sortedMessages.length - 1
                ? new Date(sortedMessages[idx + 1]!.createdAt).getTime()
                : Infinity;

            const checkpointsAfter = sortedVersions.filter((v) => {
              const vt = v.createdAt ? new Date(v.createdAt).getTime() : 0;
              return vt > msgTime && vt < nextTime;
            });

            const isUser = msg.role === "user";
            const planPayload = msg.plan as Record<string, unknown> | null | undefined;
            const payloadKind =
              planPayload && typeof planPayload === "object" ? planPayload.kind : undefined;
            const isReport = payloadKind === "report";
            const isError = payloadKind === "error";
            const isTaskQueued = payloadKind === "task-queued" || payloadKind === "task-done";
            const isPlanCard =
              msg.planMode &&
              !isUser &&
              !isReport &&
              !isError &&
              planPayload &&
              typeof planPayload === "object";

            // For assistant messages with a taskId, show persisted tool events
            const taskId =
              !isUser && planPayload && typeof planPayload === "object"
                ? (planPayload.taskId as number | undefined)
                : undefined;
            const task = taskId ? taskById.get(taskId) : undefined;

            return (
              <div key={msg.id}>
                {isUser ? (
                  <UserBubble text={msg.content} />
                ) : isPlanCard ? (
                  <ZeroPlanBubble
                    plan={planPayload as StructuredPlan}
                    projectId={projectId}
                    agentMode={agentMode}
                    messageId={msg.id}
                    isBusy={isBusy}
                    onBuild={(builtPrompt, mode, bg) =>
                      doSend(builtPrompt, { planMode: false, background: bg, mode })
                    }
                  />
                ) : isReport ? (
                  // Build-complete message — show a summary so users see the
                  // final result rather than a blank gap in the thread
                  <ZeroBubble
                    content={
                      msg.content ||
                      ((planPayload as { report?: { summary?: string } }).report?.summary
                        ? `Build complete. ${(planPayload as { report: { summary: string } }).report.summary}`
                        : "Build complete.")
                    }
                  />
                ) : isTaskQueued ? null : msg.content ? (
                  <ZeroBubble content={msg.content} />
                ) : null}

                {/* Persisted tool-call events for this message's task */}
                {taskId && task && TERMINAL_STATUSES.has(task.status) && (
                  <PersistedToolEvents
                    projectId={projectId}
                    taskId={taskId}
                    taskStatus={task.status}
                  />
                )}

                {checkpointsAfter.map((v) => (
                  <CheckpointMarker
                    key={v.id}
                    version={v}
                    onRollback={handleRollback}
                    isRollingBack={rollbackVersion.isPending}
                  />
                ))}
              </div>
            );
          })}

          {/* Live tool-call stream (active task) */}
          {activeTaskId !== null && (
            <div className="px-3 py-1">
              <AgentThinkingBubble
                projectId={projectId}
                taskId={activeTaskId}
                startedAt={pendingStartedAt}
                onDismiss={dismissBubble}
              />
            </div>
          )}

          {sendMessage.isPending && !activeTaskId && (
            <div className="flex items-center justify-end gap-2 px-5 py-3">
              <span className="text-xs text-muted-foreground">Starting…</span>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            </div>
          )}

          <div className="h-4" />
        </div>

        {/* ── Composer ── */}
        <div className="shrink-0 border-t border-border bg-card/60 backdrop-blur-sm">
          {/* Pending attachments preview */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              {attachments.map((a, i) => (
                <div
                  key={i}
                  className="relative flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-background/60 text-[10px] text-muted-foreground max-w-[140px]"
                >
                  {a.uploading ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0" />
                  ) : a.kind === "image" ? (
                    <ImagePlus className="h-2.5 w-2.5 shrink-0 text-primary" />
                  ) : (
                    <Paperclip className="h-2.5 w-2.5 shrink-0" />
                  )}
                  <span className="truncate">{a.name}</span>
                  <button
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="ml-0.5 text-muted-foreground/50 hover:text-foreground shrink-0"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Toggles */}
          <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
            <button
              onClick={() => setPlanMode((v) => !v)}
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors",
                planMode
                  ? "border-violet-500/40 bg-violet-500/10 text-violet-400"
                  : "border-border text-muted-foreground/60 hover:text-muted-foreground",
              )}
              title={planMode ? "Plan Mode on — Zero proposes steps first" : "Plan Mode off"}
            >
              <Brain className="h-2.5 w-2.5" />
              Plan
            </button>

            <button
              onClick={() => setRunInBackground((v) => !v)}
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-colors",
                runInBackground
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground/60 hover:text-muted-foreground",
              )}
              title={
                runInBackground
                  ? "Background on — panel closes, progress pill shows in top bar"
                  : "Background off"
              }
            >
              <Layers2 className="h-2.5 w-2.5" />
              BG
            </button>

            <div className="flex-1" />

            {runInBackground && (
              <span className="text-[9px] text-muted-foreground/50 italic">closes on send</span>
            )}
          </div>

          {/* Input row */}
          <div className="flex items-end gap-2 px-3 pb-3">
            {/* Hidden file inputs */}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.md,.csv,.json"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void handleFiles(e.target.files);
                e.target.value = "";
              }}
            />

            {/* Attach button (image / file) */}
            <button
              onClick={() => imageInputRef.current?.click()}
              onContextMenu={(e) => {
                e.preventDefault();
                fileInputRef.current?.click();
              }}
              disabled={isBusy || attachments.length >= 4}
              className="shrink-0 flex items-center justify-center h-9 w-9 rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Attach image (right-click for file)"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </button>

            {/* Textarea — drag-resizable vertically */}
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                planMode
                  ? "Describe what to plan…"
                  : runInBackground
                    ? "Tell Zero what to build (background)…"
                    : "Tell Zero what to build or change…"
              }
              disabled={isBusy}
              rows={1}
              className={cn(
                "flex-1 resize-y bg-muted/40 border border-border rounded-xl px-3 py-2.5 text-xs text-foreground",
                "placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/40 focus:bg-muted/60",
                "transition-colors disabled:opacity-50 min-h-[38px] max-h-[120px] overflow-y-auto leading-[1.5]",
              )}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
              }}
            />

            {isBusy ? (
              <button
                onClick={handleStopTask}
                className="shrink-0 flex items-center justify-center h-9 w-9 rounded-xl border border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                title="Stop build"
              >
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!prompt.trim() && attachments.filter((a) => !a.error).length === 0}
                className={cn(
                  "shrink-0 flex items-center justify-center h-9 w-9 rounded-xl transition-colors",
                  "bg-primary text-primary-foreground hover:bg-primary/90",
                  "disabled:opacity-40 disabled:cursor-not-allowed",
                )}
                title="Send (Enter)"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
