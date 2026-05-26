import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  X,
  Loader2,
  ChevronDown,
  ChevronRight,
  Mic,
  MicOff,
  Paperclip,
  ImagePlus,
  Send,
  Square,
  Zap,
  Layers2,
  Brain,
  MousePointer2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DynamicAtom } from "@/components/icons/dynamic-atom";
import { AgentThinkingBubble } from "@/components/agent-thinking-bubble";
import { MarkdownMessage } from "@/pages/projects/components/chat-history";
import { ToolCallGroup } from "@/pages/projects/components/tool-call-card";
import { PlanCard, type StructuredPlan } from "@/pages/projects/components/plan-card";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type AgentMode = "lite" | "eco" | "power" | "pro";

const MODE_STORAGE_KEY = "mustaflow_dev_chat_mode";

type ZeroMessage = {
  id: number;
  role: string;
  content: string;
  agentMode: string;
  planMode: boolean;
  plan?: Record<string, unknown> | null;
  origin?: string | null;
  createdAt: string;
};

type ZeroVersion = {
  id: number;
  userRequest?: string | null;
  changelogEntry?: string | null;
  createdAt?: string | null;
};

type PendingImage = {
  objectUrl: string;
  file: File;
  uploading?: boolean;
  uploadedUrl?: string;
  error?: string;
};

type ZeroTask = {
  id: number;
  status: string;
  userRequest: string;
  createdAt: string;
};

type Session = {
  id: string;
  startTime: Date;
  items: Array<{ msg: ZeroMessage; globalIdx: number }>;
};

const SESSION_GAP_MS = 30 * 60 * 1000;
// All statuses that mean the task is no longer running
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "discarded",
  "needs_approval",
  "needs_review",
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function groupIntoSessions(msgs: ZeroMessage[]): Session[] {
  if (msgs.length === 0) return [];
  const sessions: Session[] = [];
  let current: Session = {
    id: msgs[0]!.createdAt,
    startTime: new Date(msgs[0]!.createdAt),
    items: [{ msg: msgs[0]!, globalIdx: 0 }],
  };
  for (let i = 1; i < msgs.length; i++) {
    const prev = new Date(msgs[i - 1]!.createdAt).getTime();
    const curr = new Date(msgs[i]!.createdAt).getTime();
    if (curr - prev > SESSION_GAP_MS) {
      sessions.push(current);
      current = {
        id: msgs[i]!.createdAt,
        startTime: new Date(msgs[i]!.createdAt),
        items: [{ msg: msgs[i]!, globalIdx: i }],
      };
    } else {
      current.items.push({ msg: msgs[i]!, globalIdx: i });
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

const AGENT_MODES: {
  value: AgentMode;
  label: string;
  credits: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "lite", label: "Lite", credits: "1 cr", icon: Zap },
  { value: "eco", label: "Eco", credits: "2 cr", icon: Layers2 },
  { value: "power", label: "Power", credits: "5 cr", icon: Brain },
  {
    value: "pro",
    label: "Pro",
    credits: "10 cr",
    icon: DynamicAtom as React.ComponentType<{ className?: string }>,
  },
];

interface DevChatPanelProps {
  projectId: number;
  onBuildComplete?: () => void;
}

export function DevChatPanel({ projectId, onBuildComplete }: DevChatPanelProps) {
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState("");
  const [agentMode, setAgentMode] = useState<AgentMode>(loadPersistedMode);
  const [planMode, setPlanMode] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null);
  const [pendingStartedAt, setPendingStartedAt] = useState<Date | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);

  // Voice state
  const [isListening, setIsListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sendMessage = useSendMessage();
  const rollbackVersion = useRollbackVersion();

  // Sessions for collapsible history
  const [toggledSessions, setToggledSessions] = useState<Set<string>>(new Set());
  const toggleSession = useCallback((id: string) => {
    setToggledSessions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Close mode menu on outside click
  useEffect(() => {
    if (!showModeMenu) return;
    const handler = (e: MouseEvent) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setShowModeMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModeMenu]);

  const handleSseConnectionChange = useCallback((connected: boolean) => {
    setSseConnected(connected);
  }, []);

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
      refetchInterval: 30000,
      staleTime: 10000,
    },
  });

  const typedTasks = useMemo(() => (tasks as ZeroTask[] | undefined) ?? [], [tasks]);
  const typedVersions = useMemo(() => (versions as ZeroVersion[] | undefined) ?? [], [versions]);

  const isTaskTerminal = useMemo(() => {
    if (!activeTaskId) return true;
    const t = typedTasks.find((x) => x.id === activeTaskId);
    return t ? TERMINAL_STATUSES.has(t.status) : false;
  }, [typedTasks, activeTaskId]);

  const _activeTaskStatus = useMemo(() => {
    if (!activeTaskId) return null;
    return typedTasks.find((x) => x.id === activeTaskId)?.status ?? null;
  }, [typedTasks, activeTaskId]);

  const isBusy = sendMessage.isPending || uploadingCount > 0 || (!!activeTaskId && !isTaskTerminal);

  // Sync activeTaskId from tasks list — clear once terminal
  useEffect(() => {
    if (activeTaskId === null) return;
    if (!isTaskTerminal) return;
    const timeout = setTimeout(() => {
      setActiveTaskId(null);
      setPendingStartedAt(null);
      setSseConnected(false);
      void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      onBuildComplete?.();
    }, 1500);
    return () => clearTimeout(timeout);
  }, [isTaskTerminal, activeTaskId, projectId, queryClient, onBuildComplete]);

  // Hard-cap: if we've been showing a spinner for > 2 min, force-clear.
  // Protects against tasks that never reach a terminal status client-side.
  useEffect(() => {
    if (!activeTaskId || !pendingStartedAt) return;
    const elapsed = Date.now() - pendingStartedAt.getTime();
    const remaining = Math.max(0, 120_000 - elapsed);
    const t = setTimeout(() => {
      setActiveTaskId(null);
      setPendingStartedAt(null);
      setSseConnected(false);
    }, remaining);
    return () => clearTimeout(t);
  }, [activeTaskId, pendingStartedAt]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeTaskId, pendingStartedAt]);

  const typedMessages = useMemo(() => (messages as ZeroMessage[] | undefined) ?? [], [messages]);

  const hasZeroOriginMessages = useMemo(
    () => typedMessages.some((m) => m.origin === "zero"),
    [typedMessages],
  );

  const sortedMessages = useMemo(() => {
    const filtered = hasZeroOriginMessages
      ? typedMessages.filter((m) => m.origin === "zero")
      : typedMessages;
    return [...filtered].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [typedMessages, hasZeroOriginMessages]);

  const sessions = useMemo(() => groupIntoSessions(sortedMessages), [sortedMessages]);

  const inlineBubbleMsgId = useMemo(() => {
    if (!activeTaskId) return null;
    for (const msg of sortedMessages) {
      if (msg.role === "assistant" && msg.plan) {
        const plan = msg.plan as { taskId?: number };
        if (plan.taskId === activeTaskId) return msg.id;
      }
    }
    return null;
  }, [sortedMessages, activeTaskId]);

  const activeTaskIsInThread = inlineBubbleMsgId !== null;

  // ── Image upload ───────────────────────────────────────────────────────────
  const uploadImage = useCallback(
    async (file: File): Promise<string | null> => {
      if (file.size > MAX_IMAGE_BYTES) {
        return null;
      }
      try {
        const resized = await resizeImageForVision(file);
        const resizedFile = new File([resized], file.name, { type: resized.type || file.type });
        const metaRes = await fetch(`/api/projects/${projectId}/attachments/upload-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            filename: resizedFile.name,
            mimeType: resizedFile.type,
            size: resizedFile.size,
          }),
        });
        if (!metaRes.ok) return null;
        const { uploadUrl, objectPath } = (await metaRes.json()) as {
          uploadUrl: string;
          objectPath: string;
        };
        const up = await fetch(uploadUrl, {
          method: "PUT",
          body: resizedFile,
          headers: { "Content-Type": resizedFile.type },
        });
        if (!up.ok) return null;
        return objectPath;
      } catch {
        return null;
      }
    },
    [projectId],
  );

  const handleImageFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((f) => f.type.startsWith("image/")).slice(0, 4);
      if (imageFiles.length === 0) return;

      const pendingItems: PendingImage[] = imageFiles.map((f) => ({
        objectUrl: URL.createObjectURL(f),
        file: f,
        uploading: true,
      }));
      setImages((prev) => [...prev, ...pendingItems]);
      setUploadingCount((n) => n + pendingItems.length);

      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i]!;
        const objUrl = pendingItems[i]!.objectUrl;
        const uploadedUrl = await uploadImage(file);
        setImages((prev) =>
          prev.map((img) =>
            img.objectUrl === objUrl
              ? {
                  ...img,
                  uploading: false,
                  uploadedUrl: uploadedUrl ?? undefined,
                  error: uploadedUrl ? undefined : "Upload failed",
                }
              : img,
          ),
        );
        setUploadingCount((n) => Math.max(0, n - 1));
      }
    },
    [uploadImage],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);
      const imageItems = items.filter((it) => it.type.startsWith("image/"));
      if (imageItems.length > 0) {
        e.preventDefault();
        const files = imageItems.map((it) => it.getAsFile()).filter(Boolean) as File[];
        void handleImageFiles(files);
      }
    },
    [handleImageFiles],
  );

  const removeImage = useCallback((objectUrl: string) => {
    setImages((prev) => {
      const img = prev.find((i) => i.objectUrl === objectUrl);
      if (img) URL.revokeObjectURL(img.objectUrl);
      return prev.filter((i) => i.objectUrl !== objectUrl);
    });
  }, []);

  // ── Voice dictation ────────────────────────────────────────────────────────
  const stopVoice = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      try {
        mr.stop();
      } catch {
        /* ignore */
      }
    }
    const stream = mediaStreamRef.current;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    mediaRecorderRef.current = null;
    mediaStreamRef.current = null;
    setIsListening(false);
  }, []);

  const startVoice = useCallback(async () => {
    if (isListening) {
      stopVoice();
      return;
    }
    setVoiceError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceError("Microphone not supported in this browser.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setVoiceError("Microphone access blocked. Allow microphone access in your browser.");
      return;
    }
    mediaStreamRef.current = stream;
    const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaChunksRef.current = [];
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) mediaChunksRef.current.push(e.data);
    };
    mr.onstop = async () => {
      const blob = new Blob(mediaChunksRef.current, { type: "audio/webm" });
      mediaChunksRef.current = [];
      setIsListening(false);
      if (blob.size === 0) return;
      try {
        const res = await fetch("/api/transcribe?format=webm", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: blob,
          credentials: "include",
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          setVoiceError(errBody.error ?? `Transcription failed`);
          return;
        }
        const { text } = (await res.json()) as { text?: string };
        if (text) setPrompt((prev) => (prev ? prev + " " + text : text));
      } catch {
        setVoiceError("Transcription failed.");
      }
    };
    mediaRecorderRef.current = mr;
    mr.start();
    setIsListening(true);
  }, [isListening, stopVoice]);

  // ── Send ───────────────────────────────────────────────────────────────────
  // overrideText: when provided (e.g. from PlanCard onBuild), use this instead of
  // the prompt state to avoid the stale-closure problem with setPrompt + doSend().
  const doSend = useCallback(
    (overrideText?: string) => {
      const text = (overrideText !== undefined ? overrideText : prompt).trim();
      const readyImages = images.filter((i) => i.uploadedUrl && !i.uploading && !i.error);
      if (!text && readyImages.length === 0) return;
      if (isBusy) return;

      const attachments = readyImages.map((i) => ({
        kind: "image" as const,
        url: i.uploadedUrl!,
        alt: i.file.name,
      }));

      setPrompt("");
      setImages([]);
      setPendingStartedAt(new Date());

      sendMessage.mutate(
        {
          id: projectId,
          data: {
            content: text,
            agentMode,
            planMode,
            background: false,
            agentIntent: planMode ? ("plan" as const) : ("build" as const),
            origin: "zero",
            ...(attachments.length > 0 ? { attachments } : {}),
          },
        },
        {
          onSuccess: (data) => {
            const plan = (data as { assistantMessage?: { plan?: Record<string, unknown> | null } })
              ?.assistantMessage?.plan;
            const tid =
              plan && typeof plan === "object" ? (plan.taskId as number | undefined) : undefined;
            if (tid) {
              setActiveTaskId(tid);
            } else {
              setPendingStartedAt(null);
            }
            void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
            void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
          },
          onError: () => {
            void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
            setPendingStartedAt(null);
          },
        },
      );
    },
    [prompt, images, isBusy, projectId, agentMode, planMode, sendMessage, queryClient],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        doSend();
      }
    },
    [doSend],
  );

  const currentMode = AGENT_MODES.find((m) => m.value === agentMode) ?? AGENT_MODES[2]!;

  return (
    <div className="flex flex-col h-full bg-zinc-950 min-w-0 overflow-hidden">
      {/* ── Thread ─────────────────────────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
        {/* Empty state */}
        {sortedMessages.length === 0 && !activeTaskId && !sendMessage.isPending && (
          <div className="flex flex-col items-center gap-4 pt-16 px-6 text-center">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              <DynamicAtom size={22} className="text-primary" animate={false} />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground mb-1">Zero Agent</p>
              <p className="text-xs text-muted-foreground max-w-[220px] leading-relaxed">
                Describe what to build, fix, or change. Attach screenshots to let Zero see your UI.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5 justify-center mt-1">
              {["Fix the bug in this file", "Add dark mode", "Refactor this component"].map((s) => (
                <button
                  key={s}
                  onClick={() => setPrompt(s)}
                  className="text-[10px] px-2.5 py-1 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Legacy fallback notice */}
        {!hasZeroOriginMessages && sortedMessages.length > 0 && (
          <div className="mx-3 mt-3 px-3 py-2 rounded-lg bg-muted/40 border border-border">
            <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
              Showing all messages. New conversations will be filtered to Zero only.
            </p>
          </div>
        )}

        {/* Session cards */}
        {sessions.map((session, si) => {
          const isCurrentSession = si === sessions.length - 1;
          const isExpanded = isCurrentSession || toggledSessions.has(session.id);

          return (
            <div key={session.id}>
              {!isCurrentSession && (
                <button
                  onClick={() => toggleSession(session.id)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 transition-colors group"
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
                    {!isExpanded && (
                      <p className="text-[10px] text-muted-foreground/30 truncate mt-0.5">
                        {session.items.find((it) => it.msg.role === "user")?.msg.content ?? ""}
                      </p>
                    )}
                  </div>
                  <span className="text-[9px] text-muted-foreground/30 shrink-0">
                    {session.items.length} msg{session.items.length !== 1 ? "s" : ""}
                  </span>
                </button>
              )}

              {isExpanded && (
                <div>
                  {session.items.map(({ msg, globalIdx }) => {
                    // Time-based version correlation: find versions created between
                    // this message and the next one (mirrors zero-agent-panel logic)
                    const msgTime = new Date(msg.createdAt).getTime();
                    const nextGlobalIdx = globalIdx + 1;
                    const nextTime =
                      nextGlobalIdx < sortedMessages.length
                        ? new Date(sortedMessages[nextGlobalIdx]!.createdAt).getTime()
                        : Infinity;
                    const checkpointsAfter = typedVersions.filter((v) => {
                      const vt = v.createdAt ? new Date(v.createdAt).getTime() : 0;
                      return vt > msgTime && vt < nextTime;
                    });
                    const versionAfter = checkpointsAfter[0] as ZeroVersion | undefined;

                    // Only show PlanCard for genuine plan-mode messages
                    // (exclude report/error/task-queued/task-done payloads)
                    const rawPlan = msg.plan as Record<string, unknown> | null | undefined;
                    const planPayloadKind =
                      rawPlan && typeof rawPlan === "object" ? rawPlan.kind : undefined;
                    const isPlanCard =
                      msg.planMode &&
                      msg.role !== "user" &&
                      planPayloadKind !== "report" &&
                      planPayloadKind !== "error" &&
                      planPayloadKind !== "task-queued" &&
                      planPayloadKind !== "task-done" &&
                      rawPlan != null;
                    const plan = isPlanCard ? (rawPlan as unknown as StructuredPlan) : null;

                    return (
                      <div key={msg.id} data-msg-id={msg.id}>
                        {msg.role === "user" ? (
                          <div className="flex justify-start px-3 py-1.5">
                            <div className="max-w-[85%] bg-muted/60 border border-border rounded-2xl rounded-tl-sm px-3 py-2 text-xs text-foreground leading-relaxed">
                              {msg.content}
                            </div>
                          </div>
                        ) : plan ? (
                          <div className="flex items-start justify-end gap-2 px-3 py-1.5">
                            <div className="flex-1 min-w-0">
                              <PlanCard
                                plan={plan}
                                projectId={projectId}
                                initialAgentMode={agentMode}
                                onBuild={(promptText, mode, _bg) => {
                                  setAgentMode(mode);
                                  savePersistedMode(mode);
                                  doSend(promptText);
                                }}
                                disabled={isBusy}
                                messageId={msg.id}
                              />
                            </div>
                            <div className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-primary/15 border border-primary/20 flex items-center justify-center">
                              <DynamicAtom size={12} className="text-primary" animate={false} />
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start justify-end gap-2 px-3 py-1.5">
                            <div className="max-w-[85%] bg-primary/8 border border-primary/15 rounded-2xl rounded-tr-sm px-3 py-2 text-xs text-foreground leading-relaxed">
                              <MarkdownMessage content={msg.content} />
                            </div>
                            <div className="shrink-0 mt-0.5 w-5 h-5 rounded-full bg-primary/15 border border-primary/20 flex items-center justify-center">
                              <DynamicAtom size={12} className="text-primary" animate={false} />
                            </div>
                          </div>
                        )}

                        {/* Inline tool events */}
                        {msg.role === "assistant" &&
                          msg.plan &&
                          activeTaskId &&
                          inlineBubbleMsgId === msg.id && (
                            <div className="px-3 pb-1">
                              <AgentThinkingBubble
                                projectId={projectId}
                                taskId={activeTaskId}
                                isAtBottom={true}
                                onDismiss={() => setActiveTaskId(null)}
                                onConnectionChange={handleSseConnectionChange}
                              />
                            </div>
                          )}

                        {/* Persisted tool events for completed tasks */}
                        {msg.role === "assistant" &&
                          msg.plan &&
                          (() => {
                            const plan2 = msg.plan as { taskId?: number };
                            const tid = plan2.taskId;
                            if (!tid || tid === activeTaskId) return null;
                            const t = typedTasks.find((x) => x.id === tid);
                            if (!t) return null;
                            return (
                              <div className="px-3 pb-1">
                                <PersistedToolEvents
                                  projectId={projectId}
                                  taskId={tid}
                                  taskStatus={t.status}
                                />
                              </div>
                            );
                          })()}

                        {/* Checkpoint marker */}
                        {versionAfter && (
                          <div className="flex items-center gap-2 py-2 px-3">
                            <div className="flex-1 h-px bg-border/30" />
                            <button
                              onClick={() => {
                                if (rollbackVersion.isPending) return;
                                rollbackVersion.mutate(
                                  { id: projectId, versionId: versionAfter.id },
                                  {
                                    onSuccess: () => {
                                      void queryClient.invalidateQueries({
                                        queryKey: getListProjectFilesQueryKey(projectId),
                                      });
                                      void queryClient.invalidateQueries({
                                        queryKey: getGetProjectQueryKey(projectId),
                                      });
                                    },
                                  },
                                );
                              }}
                              disabled={rollbackVersion.isPending}
                              className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-green-500/25 bg-green-500/5 text-green-400 text-[9px] font-medium hover:bg-green-500/10 transition-colors disabled:opacity-50 shrink-0"
                            >
                              Checkpoint saved
                            </button>
                            <div className="flex-1 h-px bg-border/30" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Fallback thinking bubble */}
        {activeTaskId && !activeTaskIsInThread && (
          <div className="px-3 py-2">
            <AgentThinkingBubble
              projectId={projectId}
              taskId={activeTaskId}
              isAtBottom={true}
              onDismiss={() => setActiveTaskId(null)}
              onConnectionChange={handleSseConnectionChange}
            />
          </div>
        )}

        {sendMessage.isPending && !activeTaskId && (
          <div className="flex justify-start px-3 py-1.5">
            <div className="bg-muted/60 border border-border rounded-xl px-3 py-2">
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}

        <div className="h-2" />
      </div>

      {/* ── Composer ───────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-border bg-zinc-950">
        {/* Pasted images preview */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2.5">
            {images.map((img) => (
              <div key={img.objectUrl} className="relative group">
                <img
                  src={img.objectUrl}
                  alt="attachment"
                  className={cn(
                    "h-14 w-14 rounded-lg object-cover border border-border",
                    img.uploading && "opacity-50",
                    img.error && "border-red-500/40 opacity-50",
                  )}
                />
                {img.uploading && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  </div>
                )}
                <button
                  onClick={() => removeImage(img.objectUrl)}
                  className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-zinc-800 border border-border flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="h-2.5 w-2.5 text-foreground" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Voice error */}
        {voiceError && (
          <div className="mx-3 mt-2 px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20">
            <p className="text-[10px] text-red-400">{voiceError}</p>
          </div>
        )}

        {/* Textarea */}
        <div className="px-3 pt-2.5 pb-1">
          <div
            className={cn(
              "flex flex-col rounded-xl border bg-muted/30 transition-colors",
              isListening ? "border-red-500/40" : "border-border focus-within:border-primary/40",
            )}
          >
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                isListening
                  ? "Listening…"
                  : images.length > 0
                    ? "Describe what you want done with these screenshots…"
                    : "Ask Zero to build, fix, or explain…"
              }
              rows={3}
              disabled={isBusy && !isListening}
              className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none resize-none leading-relaxed px-3 pt-2.5 pb-1 min-h-[52px] max-h-[180px]"
            />

            {/* Toolbar row */}
            <div className="flex items-center justify-between px-2 pb-2 pt-1 gap-1">
              <div className="flex items-center gap-1">
                {/* Mode selector */}
                <div className="relative" ref={modeMenuRef}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setShowModeMenu((v) => !v)}
                        className={cn(
                          "flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium border transition-colors",
                          getModeStyle(agentMode),
                        )}
                      >
                        {currentMode.label}
                        <ChevronDown className="h-2.5 w-2.5 opacity-60" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Select agent model</TooltipContent>
                  </Tooltip>
                  {showModeMenu && (
                    <div className="absolute bottom-full left-0 mb-1 z-50 bg-zinc-900 border border-border rounded-xl shadow-xl overflow-hidden min-w-[140px]">
                      {AGENT_MODES.map(({ value, label, credits }) => (
                        <button
                          key={value}
                          onClick={() => {
                            setAgentMode(value);
                            savePersistedMode(value);
                            setShowModeMenu(false);
                          }}
                          className={cn(
                            "w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-muted/60 transition-colors",
                            agentMode === value ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          <span className="font-medium">{label}</span>
                          <span className="text-[9px] opacity-50">{credits}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Plan toggle */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setPlanMode((v) => !v)}
                      className={cn(
                        "px-2 py-1 rounded-md text-[10px] font-medium border transition-colors",
                        planMode
                          ? "text-primary border-primary/30 bg-primary/10"
                          : "text-muted-foreground border-border hover:text-foreground",
                      )}
                    >
                      Plan
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Show a plan before building</TooltipContent>
                </Tooltip>

                {/* Select element */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 border border-transparent hover:border-border transition-colors"
                      title="Select element from preview"
                    >
                      <MousePointer2 className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Select element from preview</TooltipContent>
                </Tooltip>
              </div>

              <div className="flex items-center gap-1">
                {/* Add image */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => imageInputRef.current?.click()}
                      className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 border border-transparent hover:border-border transition-colors"
                    >
                      <ImagePlus className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Attach screenshot or image</TooltipContent>
                </Tooltip>

                {/* Attach file */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 border border-transparent hover:border-border transition-colors"
                    >
                      <Paperclip className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Attach file</TooltipContent>
                </Tooltip>

                {/* Voice */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => void startVoice()}
                      className={cn(
                        "flex items-center justify-center h-6 w-6 rounded-md border transition-colors",
                        isListening
                          ? "text-red-400 border-red-500/30 bg-red-500/10 animate-pulse"
                          : "text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/60 hover:border-border",
                      )}
                    >
                      {isListening ? <MicOff className="h-3 w-3" /> : <Mic className="h-3 w-3" />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{isListening ? "Stop recording" : "Voice input"}</TooltipContent>
                </Tooltip>

                {/* Send / Stop */}
                {isBusy && activeTaskId ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => {
                          void fetch(`/api/projects/${projectId}/tasks/${activeTaskId}/cancel`, {
                            method: "POST",
                          });
                        }}
                        className="flex items-center justify-center h-6 w-6 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors"
                      >
                        <Square className="h-2.5 w-2.5 fill-current" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Stop build</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => doSend()}
                        disabled={isBusy || (!prompt.trim() && images.length === 0)}
                        className="flex items-center justify-center h-6 w-6 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary/90 transition-colors"
                      >
                        <Send className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Send (⌘↩)</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
        </div>

        <p className="text-[9px] text-muted-foreground/35 text-center pb-2">
          ⌘↩ send · paste screenshots directly · voice input
        </p>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void handleImageFiles(files);
          e.target.value = "";
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          e.target.value = "";
        }}
      />
    </div>
  );
}
