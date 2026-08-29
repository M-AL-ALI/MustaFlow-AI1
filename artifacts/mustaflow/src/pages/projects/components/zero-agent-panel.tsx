import { authFetch } from "@/lib/api-fetch";
import { formatAssetBytes, uploadProjectAsset } from "@/lib/asset-upload";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  X,
  Send,
  Loader2,
  CheckCircle2,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Square,
  Layers2,
  Brain,
  Maximize2,
  Paperclip,
  ImagePlus,
  ListOrdered,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBuilderCreditCosts } from "@/lib/builder-followup-submit";
import {
  BUILDER_AGENT_MODES,
  BuilderModeIcon,
  builderModeLabel,
  type BuilderAgentMode,
} from "@/components/builder-mode-icon";
import { getBuilderCheckpointLabel, getBuilderCompletionMessage } from "@/lib/builder-completion";
import { DynamicAtom } from "@/components/icons/dynamic-atom";
import { AgentThinkingBubble } from "@/components/agent-thinking-bubble";
import { PlanCard, type StructuredPlan } from "./plan-card";
import { MarkdownMessage } from "./chat-history";
import { ToolCallGroup } from "./tool-call-card";
import { ZeroPromptQueueDrawer } from "./zero-prompt-queue-drawer";
import type { ZeroPromptQueueObservedPhase } from "@workspace/ora-contracts";
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
import { terminalPresentationFor, terminalTaskStatus } from "@/lib/zero-terminal";

type AgentMode = BuilderAgentMode;

const MODE_STORAGE_KEY = "mustaflow_zero_agent_mode";

type ZeroTask = {
  id: number;
  status: string;
  completionKind?: string | null;
  userRequest: string;
  createdAt: string;
  terminal?: unknown;
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
  origin?: string | null;
  attachments?: Array<{ kind: string; url?: string; alt?: string; assetId?: number }> | null;
  createdAt: string;
};

type PendingAttachment = {
  kind: "image" | "file";
  name: string;
  /** Authenticated content route for the shared asset registry. */
  url?: string;
  assetId?: number;
  uploading?: boolean;
  progress?: number;
  resized?: boolean;
  abortController?: AbortController;
  error?: string;
};

type Session = {
  id: string;
  startTime: Date;
  items: Array<{ msg: ZeroMessage; globalIdx: number }>;
};

const SESSION_GAP_MS = 30 * 60 * 1000;

function groupIntoSessions(sortedMsgs: ZeroMessage[]): Session[] {
  if (sortedMsgs.length === 0) return [];
  const sessions: Session[] = [];
  let current: Session = {
    id: sortedMsgs[0]!.createdAt,
    startTime: new Date(sortedMsgs[0]!.createdAt),
    items: [{ msg: sortedMsgs[0]!, globalIdx: 0 }],
  };
  for (let i = 1; i < sortedMsgs.length; i++) {
    const prev = new Date(sortedMsgs[i - 1]!.createdAt).getTime();
    const curr = new Date(sortedMsgs[i]!.createdAt).getTime();
    if (curr - prev > SESSION_GAP_MS) {
      sessions.push(current);
      current = {
        id: sortedMsgs[i]!.createdAt,
        startTime: new Date(sortedMsgs[i]!.createdAt),
        items: [{ msg: sortedMsgs[i]!, globalIdx: i }],
      };
    } else {
      current.items.push({ msg: sortedMsgs[i]!, globalIdx: i });
    }
  }
  sessions.push(current);
  return sessions;
}

function formatSessionLabel(date: Date): string {
  const now = new Date();
  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  if (isToday) return `Today at ${timeStr}`;
  if (isYesterday) return `Yesterday at ${timeStr}`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" }) + ` at ${timeStr}`;
}

function SessionCard({
  session,
  isCurrentSession,
  isExpanded,
  onToggle,
  children,
}: {
  session: Session;
  isCurrentSession: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const firstUserMsg = session.items.find((it) => it.msg.role === "user")?.msg.content ?? null;
  const msgCount = session.items.length;

  return (
    <div>
      {!isCurrentSession && (
        <button
          onClick={onToggle}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/30 transition-colors group"
          aria-expanded={isExpanded}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 text-muted-foreground/40 transition-transform shrink-0",
              isExpanded && "rotate-90",
            )}
          />
          <div className="flex-1 min-w-0">
            <span className="text-[10px] text-muted-foreground/60 font-medium">
              {formatSessionLabel(session.startTime)}
            </span>
            {!isExpanded && firstUserMsg && (
              <p className="text-[10px] text-muted-foreground/35 truncate mt-0.5">{firstUserMsg}</p>
            )}
          </div>
          <span className="text-[9px] text-muted-foreground/30 shrink-0 tabular-nums">
            {msgCount} msg{msgCount !== 1 ? "s" : ""}
          </span>
        </button>
      )}
      {isExpanded && <div>{children}</div>}
    </div>
  );
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled", "discarded"]);

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
  completionKind,
  onRollback,
  isRollingBack,
}: {
  version: ZeroVersion;
  completionKind?: string | null;
  onRollback: (id: number) => void;
  isRollingBack: boolean;
}) {
  const ts = version.createdAt
    ? new Date(version.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const label = getBuilderCheckpointLabel(
    version.changelogEntry || version.userRequest || `Version #${version.id}`,
    completionKind,
  );

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
  /** When set, scroll to the chat message whose plan.taskId matches and briefly highlight it */
  scrollToTaskId?: number | null;
  /** Called once the scroll + highlight cycle completes */
  onScrollToComplete?: () => void;
  /** Owner-approved support proposal carried into this exact project. */
  supportSessionId?: number | null;
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
  scrollToTaskId,
  onScrollToComplete,
  supportSessionId,
}: ZeroAgentPanelProps) {
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState("");
  const [agentMode, setAgentMode] = useState<AgentMode>(loadPersistedMode);
  const [planMode, setPlanMode] = useState(false);
  const [runInBackground, setRunInBackground] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(initialActiveTaskId ?? null);
  const [pendingStartedAt, setPendingStartedAt] = useState<Date | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showPromptQueue, setShowPromptQueue] = useState(false);
  const [runPhase, setRunPhase] = useState<ZeroPromptQueueObservedPhase | null>(null);
  const [isDetached, setIsDetached] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [highlightedMsgId, setHighlightedMsgId] = useState<number | null>(null);
  const [supportHandoffError, setSupportHandoffError] = useState<string | null>(null);
  /** Tracks which scrollToTaskId we have already acted on to avoid re-running */
  const appliedScrollTaskIdRef = useRef<number | null>(null);
  const appliedSupportSessionRef = useRef<number | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [assetQuota, setAssetQuota] = useState<{
    usedBytes: number;
    reservedBytes: number;
    limitBytes: number;
  } | null>(null);
  const creditCosts = useBuilderCreditCosts();

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

  const handleSseConnectionChange = useCallback((connected: boolean) => {
    setSseConnected(connected);
  }, []);

  const handleRunPhaseChange = useCallback((phase: ZeroPromptQueueObservedPhase | null) => {
    setRunPhase(phase);
  }, []);

  useEffect(() => {
    setRunPhase(null);
  }, [activeTaskId]);

  const { data: messages } = useListMessages(projectId, {
    query: {
      queryKey: getListMessagesQueryKey(projectId),
      refetchInterval: activeTaskId ? (sseConnected ? 30000 : 3000) : 20000,
      staleTime: 2000,
    },
  });

  const { data: tasks } = useListTasks(projectId, {
    query: {
      queryKey: getListTasksQueryKey(projectId),
      refetchInterval: activeTaskId ? (sseConnected ? 30000 : 2000) : 15000,
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

  const tasksArr = useMemo(
    () =>
      ((tasks as ZeroTask[] | undefined) ?? []).map((task) => ({
        ...task,
        status: terminalTaskStatus(task, task.status),
      })),
    [tasks],
  );
  const versionsArr = useMemo(() => (versions as ZeroVersion[] | undefined) ?? [], [versions]);
  const messagesArr = useMemo(() => (messages as ZeroMessage[] | undefined) ?? [], [messages]);

  const activeTask = activeTaskId ? tasksArr.find((t) => t.id === activeTaskId) : null;
  const isTaskTerminal = activeTask ? TERMINAL_STATUSES.has(activeTask.status) : false;
  const isBusy = sendMessage.isPending || uploadingCount > 0 || (!!activeTaskId && !isTaskTerminal);

  const dismissBubble = useCallback(() => {
    setActiveTaskId(null);
    setPendingStartedAt(null);
    setSseConnected(false);
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

  const loadAssetQuota = useCallback(async () => {
    const response = await authFetch(`/api/projects/${projectId}/assets/quota`);
    if (!response.ok) return;
    setAssetQuota(
      (await response.json()) as {
        usedBytes: number;
        reservedBytes: number;
        limitBytes: number;
      },
    );
  }, [projectId]);

  useEffect(() => {
    if (isOpen) void loadAssetQuota();
  }, [isOpen, loadAssetQuota]);

  // ── File upload ──────────────────────────────────────────────────────────
  const handleFiles = useCallback(
    async (files: FileList | File[], source: "picker" | "paste" | "drop" = "picker") => {
      const list = Array.from(files);
      for (const file of list) {
        const abortController = new AbortController();
        const placeholder: PendingAttachment = {
          kind: file.type.startsWith("image/") ? "image" : "file",
          name: file.name,
          uploading: true,
          progress: 0,
          abortController,
        };
        setAttachments((prev) => [...prev, placeholder]);
        setUploadingCount((count) => count + 1);
        try {
          const result = await uploadProjectAsset({
            projectId,
            file,
            source,
            signal: abortController.signal,
            onProgress: (progress) => {
              setAttachments((current) =>
                current.map((item) => (item === placeholder ? { ...item, progress } : item)),
              );
            },
          });
          setAttachments((current) =>
            current.map((item) =>
              item === placeholder
                ? {
                    kind: result.mimeType.startsWith("image/") ? "image" : "file",
                    name: result.name,
                    assetId: result.assetId,
                    url: result.contentUrl,
                    resized: result.resized,
                    uploading: false,
                    progress: 100,
                  }
                : item,
            ),
          );
        } catch (error) {
          setAttachments((current) =>
            current.map((item) =>
              item === placeholder
                ? {
                    ...item,
                    uploading: false,
                    error:
                      error instanceof DOMException && error.name === "AbortError"
                        ? "Upload cancelled"
                        : error instanceof Error
                          ? error.message
                          : "The upload could not be completed.",
                  }
                : item,
            ),
          );
        } finally {
          setUploadingCount((count) => Math.max(0, count - 1));
          void loadAssetQuota();
        }
      }
    },
    [loadAssetQuota, projectId],
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
        (a) => a.kind === "file" && a.assetId && !a.uploading && !a.error,
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
            // Only force intent when Plan Mode is explicitly enabled. Otherwise
            // omit it so the server-side classifier can route conversational
            // questions to the converse pipeline instead of silently completing
            // through refine with "Refined 0 files".
            ...(usePlan ? { agentIntent: "plan" as const } : {}),
            origin: "zero",
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

  useEffect(() => {
    if (
      !isOpen ||
      !supportSessionId ||
      appliedSupportSessionRef.current === supportSessionId ||
      sendMessage.isPending
    ) {
      return;
    }
    appliedSupportSessionRef.current = supportSessionId;
    setSupportHandoffError(null);
    void (async () => {
      const response = await authFetch(`/api/support/zero-sessions/${supportSessionId}`);
      const body = (await response.json().catch(() => null)) as {
        session?: {
          id: number;
          status: string;
          proposal?: { instruction?: unknown };
        };
        error?: string;
      } | null;
      if (!response.ok || !body?.session) {
        throw new Error(body?.error ?? "This approved support change could not be loaded.");
      }
      if (body.session.status === "applying" || body.session.status === "applied") {
        const url = new URL(window.location.href);
        url.searchParams.delete("supportSession");
        window.history.replaceState(null, "", url);
        return;
      }
      if (body.session.status !== "approved") {
        throw new Error("This support proposal is not approved for a project change.");
      }
      const instruction = body.session.proposal?.instruction;
      if (typeof instruction !== "string" || !instruction.trim()) {
        throw new Error("This support proposal does not contain an approved change.");
      }
      setActiveTaskId(null);
      setPendingStartedAt(new Date());
      sendMessage.mutate(
        {
          id: projectId,
          data: {
            content: instruction,
            agentMode: "eco",
            planMode: false,
            background: false,
            agentIntent: "mutate",
            origin: `support-session:${supportSessionId}`,
            idempotencyKey: `support-session:${supportSessionId}`,
            supportSessionId,
          },
        },
        {
          onSuccess: (data) => {
            const plan = data?.assistantMessage?.plan as Record<string, unknown> | null | undefined;
            const taskId =
              plan && typeof plan === "object" ? (plan.taskId as number | undefined) : undefined;
            if (taskId) setActiveTaskId(taskId);
            setPendingStartedAt(taskId ? new Date() : null);
            const url = new URL(window.location.href);
            url.searchParams.delete("supportSession");
            window.history.replaceState(null, "", url);
            void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
            void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
          },
          onError: (error) => {
            setPendingStartedAt(null);
            setSupportHandoffError(
              error instanceof Error
                ? error.message
                : "The approved support change could not start. Nothing was changed.",
            );
          },
        },
      );
    })().catch((error: unknown) => {
      setPendingStartedAt(null);
      setSupportHandoffError(
        error instanceof Error
          ? error.message
          : "The approved support change could not start. Nothing was changed.",
      );
    });
  }, [isOpen, projectId, queryClient, sendMessage, supportSessionId]);

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
    void authFetch(`/api/projects/${projectId}/tasks/${activeTaskId}/cancel`, {
      method: "POST",
      credentials: "include",
    }).then(() => {
      void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
    });
  }, [activeTaskId, projectId, queryClient]);

  // Legacy fallback: if no messages have origin='zero' yet (pre-backfill projects),
  // show all messages so the thread isn't empty. New messages will carry origin='zero'
  // going forward, at which point the filter takes effect naturally.
  const hasZeroOriginMessages = useMemo(
    () => messagesArr.some((m) => m.origin === "zero"),
    [messagesArr],
  );

  const sortedMessages = useMemo(() => {
    const filtered = hasZeroOriginMessages
      ? messagesArr.filter((m) => m.origin === "zero")
      : messagesArr;
    return [...filtered].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [messagesArr, hasZeroOriginMessages]);

  const sessions = useMemo(() => groupIntoSessions(sortedMessages), [sortedMessages]);

  // Tracks sessions toggled away from their default state.
  // Default: last session expanded, all previous sessions collapsed.
  const [toggledSessions, setToggledSessions] = useState<Set<string>>(new Set());

  const toggleSession = useCallback((sessionId: string) => {
    setToggledSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const sortedVersions = useMemo(
    () =>
      [...versionsArr].sort(
        (a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime(),
      ),
    [versionsArr],
  );

  /** Build a map of taskId → task for associating plan payloads to events */
  const taskById = useMemo(() => new Map(tasksArr.map((t) => [t.id, t])), [tasksArr]);

  /**
   * The message ID of the *first* assistant message whose plan.taskId matches
   * activeTaskId. Only this one message renders the inline AgentThinkingBubble
   * (guard against duplicate bubbles if the same taskId somehow appears in
   * multiple messages). null when no such message exists yet (triggering the
   * fallback bottom bubble).
   */
  const inlineBubbleMsgId = useMemo<number | null>(() => {
    if (activeTaskId === null) return null;
    for (const msg of sortedMessages) {
      if (msg.role === "user") continue;
      const payload = msg.plan as Record<string, unknown> | null | undefined;
      if (
        payload &&
        typeof payload === "object" &&
        (payload.taskId as number | undefined) === activeTaskId
      ) {
        return msg.id;
      }
    }
    return null;
  }, [activeTaskId, sortedMessages]);

  /** True when the inline bubble is anchored to a message in the thread. */
  const activeTaskIsInThread = inlineBubbleMsgId !== null;

  /**
   * When `scrollToTaskId` changes (or messages finish loading), find the
   * assistant message whose plan.taskId matches, scroll to it, and briefly
   * highlight it so the user can spot it easily.
   */
  useEffect(() => {
    if (scrollToTaskId == null) {
      appliedScrollTaskIdRef.current = null;
      return;
    }
    if (appliedScrollTaskIdRef.current === scrollToTaskId) return;

    const target = sortedMessages.find((m) => {
      if (m.role === "user") return false;
      const payload = m.plan as Record<string, unknown> | null | undefined;
      return (
        payload != null &&
        typeof payload === "object" &&
        (payload.taskId as number | undefined) === scrollToTaskId
      );
    });

    if (!target) return; // Messages not yet loaded — re-runs when sortedMessages changes

    appliedScrollTaskIdRef.current = scrollToTaskId;
    setHighlightedMsgId(target.id);

    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(
        `[data-msg-id="${target.id}"]`,
      ) as HTMLElement | null;
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    const t = setTimeout(() => {
      setHighlightedMsgId(null);
      onScrollToComplete?.();
    }, 2000);

    return () => clearTimeout(t);
  }, [scrollToTaskId, sortedMessages, onScrollToComplete]);

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
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          void handleFiles(event.dataTransfer.files, "drop");
        }}
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
              <BuilderModeIcon mode={agentMode} className="h-2.5 w-2.5" />
              {agentMode}
              <ChevronDown className="h-2.5 w-2.5 opacity-50" />
            </button>
            {showModeMenu && (
              <div className="absolute top-full right-0 mt-1.5 w-44 bg-popover border border-border rounded-xl shadow-xl py-1 z-10">
                {BUILDER_AGENT_MODES.map((mode) => (
                  <button
                    key={mode}
                    onClick={() => {
                      handleSetMode(mode);
                      setShowModeMenu(false);
                    }}
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-2 text-[11px] hover:bg-muted transition-colors",
                      "first:rounded-t-xl last:rounded-b-xl",
                      agentMode === mode
                        ? "text-foreground font-semibold"
                        : "text-muted-foreground",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <BuilderModeIcon mode={mode} className="h-3 w-3" />
                      {builderModeLabel(mode)}
                    </span>
                    <span className="text-muted-foreground/50">
                      {creditCosts.standard[mode as keyof typeof creditCosts.standard]} cr
                    </span>
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

        {supportHandoffError && (
          <div className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600">
            {supportHandoffError}
          </div>
        )}

        {/* ── Thread ── */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-3 hide-scrollbar">
          {sortedMessages.length === 0 && !activeTaskId && !sendMessage.isPending && (
            <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
              <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <DynamicAtom size={32} className="text-primary" animate />
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Zero is ready for another request
                </p>
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

          {/* Legacy fallback notice — shown when no zero-tagged messages exist yet */}
          {!hasZeroOriginMessages && sortedMessages.length > 0 && (
            <div className="mx-3 mb-2 px-3 py-2 rounded-lg bg-muted/40 border border-border/50 text-[10px] text-muted-foreground leading-relaxed">
              Showing all messages. Older messages predate Zero's thread filter and won't be
              separated from the main chat. New conversations will be filtered automatically.
            </div>
          )}

          {/* Messages grouped into collapsible session cards */}
          {sessions.map((session, sessionIdx) => {
            const isCurrentSession = sessionIdx === sessions.length - 1;
            const isExpanded = isCurrentSession
              ? !toggledSessions.has(session.id)
              : toggledSessions.has(session.id);

            return (
              <SessionCard
                key={session.id}
                session={session}
                isCurrentSession={isCurrentSession}
                isExpanded={isExpanded}
                onToggle={() => toggleSession(session.id)}
              >
                {session.items.map(({ msg, globalIdx }) => {
                  const msgTime = new Date(msg.createdAt).getTime();
                  const nextGlobalIdx = globalIdx + 1;
                  const nextTime =
                    nextGlobalIdx < sortedMessages.length
                      ? new Date(sortedMessages[nextGlobalIdx]!.createdAt).getTime()
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

                  const taskId =
                    !isUser && planPayload && typeof planPayload === "object"
                      ? (planPayload.taskId as number | undefined)
                      : undefined;
                  const task = taskId ? taskById.get(taskId) : undefined;
                  const completionText =
                    (task ? terminalPresentationFor(task)?.message : null) ??
                    getBuilderCompletionMessage(task?.completionKind);

                  return (
                    <div
                      key={msg.id}
                      data-msg-id={msg.id}
                      className={cn(
                        "rounded-lg transition-colors duration-300",
                        highlightedMsgId === msg.id && "bg-primary/10 ring-1 ring-primary/30",
                      )}
                    >
                      {isUser ? (
                        <UserBubble
                          text={msg.content}
                          attachments={(msg.attachments ?? [])
                            .filter((attachment) => attachment.kind === "image" && attachment.url)
                            .map((attachment) => ({
                              kind: "image" as const,
                              name: attachment.alt ?? "Attached image",
                              url: attachment.url,
                              assetId: attachment.assetId,
                            }))}
                        />
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
                        <ZeroBubble
                          content={
                            msg.content ||
                            ((planPayload as { report?: { summary?: string } }).report?.summary
                              ? `${completionText}. ${(planPayload as { report: { summary: string } }).report.summary}`
                              : `${completionText}.`)
                          }
                        />
                      ) : isTaskQueued ? null : msg.content ? (
                        <ZeroBubble content={msg.content} />
                      ) : null}

                      {/*
                       * Inline live stream — render AgentThinkingBubble directly
                       * below the triggering message when this task is the active one.
                       * Keyed to msg.id so only one bubble ever mounts even if
                       * multiple messages share a taskId. Once the task is terminal
                       * the bubble auto-dismisses and PersistedToolEvents takes over.
                       */}
                      {msg.id === inlineBubbleMsgId && taskId !== undefined && (
                        <div className="px-3 py-1">
                          <AgentThinkingBubble
                            projectId={projectId}
                            taskId={taskId}
                            startedAt={pendingStartedAt}
                            onDismiss={dismissBubble}
                            onConnectionChange={handleSseConnectionChange}
                            onRunPhaseChange={handleRunPhaseChange}
                          />
                        </div>
                      )}

                      {/* Persisted tool-call events for completed tasks only */}
                      {taskId &&
                        task &&
                        TERMINAL_STATUSES.has(task.status) &&
                        taskId !== activeTaskId && (
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
                          completionKind={task?.completionKind}
                          onRollback={handleRollback}
                          isRollingBack={rollbackVersion.isPending}
                        />
                      ))}
                    </div>
                  );
                })}
              </SessionCard>
            );
          })}

          {/*
           * Fallback live stream — only shown when the active task's assistant
           * message has NOT yet appeared in the sorted message list (e.g. the
           * first 1-2 seconds right after sendMessage succeeds, before the
           * messages query re-fetches). Once the message appears in the thread
           * the inline AgentThinkingBubble above takes over and this disappears.
           */}
          {activeTaskId !== null && !activeTaskIsInThread && (
            <div className="px-3 py-1">
              <AgentThinkingBubble
                projectId={projectId}
                taskId={activeTaskId}
                startedAt={pendingStartedAt}
                onDismiss={dismissBubble}
                onConnectionChange={handleSseConnectionChange}
                onRunPhaseChange={handleRunPhaseChange}
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
                  {a.uploading && <span className="tabular-nums">{a.progress ?? 0}%</span>}
                  {a.resized && !a.uploading && <span title="Resized before upload">resized</span>}
                  {a.error && <span className="text-destructive truncate">{a.error}</span>}
                  <button
                    onClick={() => {
                      a.abortController?.abort();
                      setAttachments((prev) => prev.filter((_, j) => j !== i));
                    }}
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

            <button
              type="button"
              onClick={() => setShowPromptQueue(true)}
              aria-label="Open queued prompts"
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border border-border text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/60 transition-colors"
              title="Queued prompts"
            >
              <ListOrdered className="h-2.5 w-2.5" />
              Queue
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
              accept=".pdf,.txt,.md,.csv,.json,.docx,.xlsx,.pptx,.webm,.mp4"
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
              disabled={isBusy}
              className="shrink-0 flex items-center justify-center h-9 w-9 rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              title="Attach image (right-click for file)"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </button>
            {assetQuota && (
              <span
                className="shrink-0 text-[9px] text-muted-foreground/60 tabular-nums"
                title="Storage used by all uploads on this account"
              >
                {formatAssetBytes(assetQuota.usedBytes + assetQuota.reservedBytes)} /{" "}
                {formatAssetBytes(assetQuota.limitBytes)}
              </span>
            )}

            {/* Textarea — drag-resizable vertically */}
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={(event) => {
                if (!event.clipboardData.files.length) return;
                event.preventDefault();
                void handleFiles(event.clipboardData.files, "paste");
              }}
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

        {showPromptQueue && (
          <ZeroPromptQueueDrawer
            projectId={projectId}
            activeTaskId={activeTaskId}
            phase={runPhase}
            onClose={() => setShowPromptQueue(false)}
          />
        )}
      </div>
    </>
  );
}
