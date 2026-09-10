import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { X, ArrowUp, Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useBrainstormChat,
  useBrainstormResolve,
  useCreateProject,
  getListProjectsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { authFetch } from "@/lib/api-fetch";
import type { InlineSurfaceActivityUpdate } from "@/pages/projects/components/inline-activity-stream";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface BrainstormPanelProps {
  onClose: () => void;
  /** Project surface to create under. Defaults to 'builder'. */
  mode?: "builder" | "developer";
  /** Called with the new project id after creation. Defaults to navigating to /projects/:id. */
  onCreated?: (projectId: number) => void;
  /**
   * When provided the panel operates in "workspace" mode: instead of offering
   * to create a new project it calls this callback with the resolved prompt so
   * the caller can seed it into the composer.  The "Create project" step is
   * skipped entirely.
   *
   * The second argument is the full brainstorm conversation history (excluding
   * the AI opening message) so the caller can forward it to the builder as
   * supplementary context.
   */
  onResolved?: (prompt: string, messages: Message[], action: "plan" | "build") => void;
  /**
   * When provided the conversation is persisted to localStorage keyed by this
   * project ID so re-opening the panel restores the thread.
   */
  projectId?: number;
  /**
   * Optional manual storage key for persistence, takes precedence over projectId.
   * Useful for panels without a project (e.g. dev-home "Discuss first").
   */
  storageKey?: string;
  /** Pre-fill the composer with this text on mount (e.g. seeded from the landing page). */
  initialInput?: string;
  /** Mirrors the real brainstorm request state into the workspace thread. */
  onActivityChange?: (update: InlineSurfaceActivityUpdate) => void;
}

const OPENING_MESSAGE_CONTENT =
  "What are you thinking of building? Tell me as much or as little as you'd like and I'll help shape it.";

const OPENING_MESSAGE: Message = {
  role: "assistant",
  content: OPENING_MESSAGE_CONTENT,
};

function isOpeningMessage(m: Message) {
  return m.role === "assistant" && m.content === OPENING_MESSAGE_CONTENT;
}

function resolveStorageKey(projectId?: number, storageKey?: string) {
  if (storageKey) return storageKey;
  if (projectId) return `brainstorm_messages_${projectId}`;
  return null;
}

function loadPersistedState(effectiveKey: string | null): {
  messages: Message[];
  buildIntent: boolean;
} {
  if (!effectiveKey) return { messages: [OPENING_MESSAGE], buildIntent: false };
  try {
    const raw = localStorage.getItem(effectiveKey);
    if (!raw) return { messages: [OPENING_MESSAGE], buildIntent: false };
    const parsed = JSON.parse(raw) as { messages?: Message[]; buildIntent?: boolean };
    const messages =
      Array.isArray(parsed.messages) && parsed.messages.length > 0
        ? parsed.messages
        : [OPENING_MESSAGE];
    return { messages, buildIntent: parsed.buildIntent ?? false };
  } catch {
    return { messages: [OPENING_MESSAGE], buildIntent: false };
  }
}

function savePersistedState(effectiveKey: string, messages: Message[], buildIntent: boolean) {
  try {
    localStorage.setItem(effectiveKey, JSON.stringify({ messages, buildIntent }));
  } catch {
    /* ignore quota errors */
  }
}

function clearPersistedState(effectiveKey: string) {
  try {
    localStorage.removeItem(effectiveKey);
  } catch {
    /* ignore */
  }
}

/** A project or storage-scope change starts a separate state and mutation lifecycle. */
export function BrainstormPanel(props: BrainstormPanelProps) {
  const scope = JSON.stringify([
    props.projectId ?? null,
    resolveStorageKey(props.projectId, props.storageKey),
  ]);
  return <BrainstormPanelSession key={scope} {...props} />;
}

function BrainstormPanelSession({
  onClose,
  mode,
  onCreated,
  onResolved,
  projectId,
  storageKey,
  initialInput,
  onActivityChange,
}: BrainstormPanelProps) {
  const [visible, setVisible] = useState(false);

  const effectiveKey = resolveStorageKey(projectId, storageKey);
  const initialState = loadPersistedState(effectiveKey);
  const [messages, setMessages] = useState<Message[]>(initialState.messages);
  const [input, setInput] = useState(initialInput ?? "");
  const [buildIntent, setBuildIntent] = useState(initialState.buildIntent);
  const [pulseIntent, setPulseIntent] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [failedChat, setFailedChat] = useState<Message[] | null>(null);
  const requestEpoch = useRef(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const chatMutation = useBrainstormChat();
  const resolveMutation = useBrainstormResolve();
  const createProject = useCreateProject();

  const userTurns = messages.filter((m) => m.role === "user").length;
  const showBuildButton = userTurns >= 2 || buildIntent;
  const isFetching = chatMutation.isPending;
  const isBusy = isFetching || resolveMutation.isPending || isCreating;
  const inputTooLong = input.trim().length > 2000;
  useEffect(
    () => () => {
      requestEpoch.current += 1;
    },
    [effectiveKey, projectId],
  );

  const hasConversation =
    messages.length > 1 || (messages.length === 1 && !isOpeningMessage(messages[0]));

  // Mount animation: 0 → visible
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isFetching]);

  // One-shot pulse when buildIntent first fires
  useEffect(() => {
    if (!buildIntent) return;
    setPulseIntent(true);
    const t = setTimeout(() => setPulseIntent(false), 1000);
    return () => clearTimeout(t);
  }, [buildIntent]);

  // Persist to localStorage whenever messages or buildIntent change
  useEffect(() => {
    if (!effectiveKey) return;
    savePersistedState(effectiveKey, messages, buildIntent);
  }, [effectiveKey, messages, buildIntent]);

  const handleStartFresh = useCallback(() => {
    requestEpoch.current += 1;
    setRequestError(null);
    setFailedChat(null);
    setMessages([OPENING_MESSAGE]);
    setBuildIntent(false);
    setInput("");
    if (effectiveKey) clearPersistedState(effectiveKey);
  }, [effectiveKey]);

  const requestChat = useCallback(
    (chatMessages: Message[]) => {
      const epoch = ++requestEpoch.current;
      setRequestError(null);
      setFailedChat(null);
      onActivityChange?.({ status: "running", label: "Brainstorming" });
      chatMutation.mutate(
        {
          data: {
            messages: chatMessages,
            ...(projectId ? { projectId } : {}),
            beginnerMode: mode !== "developer",
          },
        },
        {
          onSuccess: (data) => {
            if (epoch !== requestEpoch.current) return;
            setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
            if (data.buildIntent) setBuildIntent(true);
            onActivityChange?.({ status: "completed", label: "Brainstormed the idea" });
          },
          onError: () => {
            if (epoch !== requestEpoch.current) return;
            setFailedChat(chatMessages);
            setRequestError("Brainstorming could not finish. Your message is kept. Try again.");
            onActivityChange?.({ status: "failed", label: "Brainstorming needs a retry" });
          },
        },
      );
    },
    [chatMutation, projectId, mode, onActivityChange],
  );

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || isBusy || inputTooLong) return;
    const chatMessages = messages.filter((m) => !isOpeningMessage(m));
    if (chatMessages.length + 2 > 30) {
      setRequestError(
        "This brainstorm has reached its message limit. Retry the last reply, turn it into a plan, or start fresh.",
      );
      return;
    }
    setInput("");
    setTimeout(() => inputRef.current?.focus(), 0);
    setMessages([...messages, { role: "user", content: text }]);
    requestChat([...chatMessages, { role: "user", content: text }]);
  }, [input, isBusy, inputTooLong, messages, requestChat]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handoffResolvedSpec = useCallback(
    (data: {
      name: string;
      prompt: string;
      kind: "web" | "mobile-cross";
      action: "plan" | "build";
      brainstormContext: Message[];
    }) => {
      if (onResolved) {
        if (effectiveKey) clearPersistedState(effectiveKey);
        onResolved(data.prompt, data.brainstormContext, data.action);
        onClose();
        return;
      }

      setIsCreating(true);
      createProject.mutate(
        {
          data: {
            name: data.name,
            description: data.prompt,
            kind: data.kind,
            ...(mode ? { mode } : {}),
          },
        },
        {
          onSuccess: async (project) => {
            try {
              const response = await authFetch(`/api/projects/${project.id}/messages`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                  content: data.prompt,
                  agentMode: "eco",
                  planMode: data.action === "plan",
                  background: false,
                  agentIdentity: data.action === "plan" ? "planning" : "main",
                  agentIntent: data.action,
                  brainstormContext: data.brainstormContext,
                }),
              });
              if (!response.ok) throw new Error("Brainstorm handoff failed");
              if (effectiveKey) clearPersistedState(effectiveKey);
              void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
              if (onCreated) {
                onCreated(project.id);
              } else {
                setLocation(`/projects/${project.id}`);
              }
            } catch {
              toast({
                title: "Project created, but the handoff failed",
                description: "Open the project and retry your plan or build request.",
                variant: "destructive",
              });
              setLocation(`/projects/${project.id}`);
            }
          },
          onError: () => {
            toast({
              title: "Something went wrong",
              description: "Could not create your project — try again.",
              variant: "destructive",
            });
            setIsCreating(false);
          },
        },
      );
    },
    [
      createProject,
      effectiveKey,
      mode,
      onClose,
      onCreated,
      onResolved,
      queryClient,
      setLocation,
      toast,
    ],
  );

  const handleExit = useCallback(
    (action: "plan" | "build") => {
      if (isBusy) return;
      const epoch = ++requestEpoch.current;
      setRequestError(null);
      setFailedChat(null);
      onActivityChange?.({ status: "running", label: "Preparing the project brief" });
      const chatMessages = messages.filter((m) => !isOpeningMessage(m));
      resolveMutation.mutate(
        {
          data: {
            messages: chatMessages,
            action,
            ...(projectId ? { projectId } : {}),
            beginnerMode: mode !== "developer",
          },
        },
        {
          onSuccess: (data) => {
            if (epoch !== requestEpoch.current) return;
            onActivityChange?.({ status: "completed", label: "Prepared the project brief" });
            handoffResolvedSpec(data);
          },
          onError: () => {
            if (epoch !== requestEpoch.current) return;
            setRequestError("Your brief could not be prepared. Your conversation is kept.");
            onActivityChange?.({ status: "failed", label: "Project brief needs a retry" });
            toast({
              title: "Something went wrong",
              description: "Could not resolve your project spec — try again.",
              variant: "destructive",
            });
          },
        },
      );
    },
    [
      resolveMutation,
      isBusy,
      onActivityChange,
      messages,
      projectId,
      mode,
      handoffResolvedSpec,
      toast,
    ],
  );

  return (
    <div
      className={cn(
        "w-full transition-opacity duration-200 ease-out",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        role="region"
        aria-label="Brainstorm panel"
        className="flex max-h-[min(460px,80dvh)] flex-col rounded-2xl border border-border bg-card shadow-sm overflow-y-auto mt-2"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
          <span className="text-xs font-semibold text-foreground">Brainstorm your idea</span>
          <div className="flex items-center gap-1">
            {hasConversation && (
              <button
                type="button"
                disabled={isBusy}
                onClick={handleStartFresh}
                title="Start fresh"
                className="h-6 flex items-center gap-1 px-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors text-xs"
              >
                <RotateCcw className="h-3 w-3" />
                Start fresh
              </button>
            )}
            <button
              type="button"
              aria-label="Close brainstorm"
              onClick={onClose}
              className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Message thread */}
        <div
          ref={scrollRef}
          role="log"
          aria-label="Brainstorm conversation"
          aria-live="polite"
          className="min-h-0 shrink overflow-y-auto px-4 py-3 space-y-3"
          style={{ maxHeight: "300px" }}
        >
          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}
            >
              <div
                dir="auto"
                className={cn(
                  "max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed",
                  msg.role === "user"
                    ? "bg-foreground text-background"
                    : "bg-muted text-foreground",
                )}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {isFetching && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-xl px-3 py-2 flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          )}
        </div>

        {requestError && (
          <div
            role="alert"
            className="shrink-0 mx-4 mb-3 rounded-lg border border-border p-3 text-sm"
          >
            <p>{requestError}</p>
            {failedChat && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  if (!isBusy) requestChat(failedChat);
                }}
                className="mt-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium"
              >
                Try again
              </button>
            )}
          </div>
        )}
        {inputTooLong && (
          <p role="alert" className="shrink-0 px-4 pb-2 text-sm text-muted-foreground">
            Brainstorm messages can contain up to 2,000 characters. Shorten this message to send it.
          </p>
        )}
        {/* Brainstorm exits — the following plan/build request is the billable handoff. */}
        {showBuildButton && (
          <div className="grid shrink-0 grid-cols-2 gap-2 px-4 pb-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={() => handleExit("plan")}
              disabled={resolveMutation.isPending || isFetching || isCreating}
              className="flex items-center justify-center rounded-lg border border-border bg-background hover:bg-muted disabled:opacity-60 transition-colors px-3 py-2 text-sm font-medium"
            >
              Turn into plan
            </button>
            <button
              type="button"
              onClick={() => handleExit("build")}
              disabled={resolveMutation.isPending || isFetching || isCreating}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors px-3 py-2 text-sm font-medium",
                pulseIntent && "animate-pulse",
              )}
            >
              {resolveMutation.isPending || isCreating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Preparing…
                </>
              ) : (
                "Build this"
              )}
            </button>
          </div>
        )}

        {/* Input bar */}
        <div className="flex shrink-0 items-end gap-2 px-3 pb-3 pt-2 border-t border-border">
          <textarea
            ref={inputRef}
            aria-label="Brainstorm message"
            dir="auto"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Tell me more..."
            rows={1}
            disabled={isBusy}
            className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none min-h-[28px] max-h-[72px] overflow-y-auto"
          />
          <button
            type="button"
            aria-label="Send brainstorm message"
            onClick={sendMessage}
            disabled={isBusy || inputTooLong || !input.trim()}
            className={cn(
              "h-8 w-8 flex items-center justify-center rounded-lg transition-colors shrink-0",
              input.trim()
                ? "bg-foreground text-background hover:bg-foreground/80"
                : "bg-muted text-muted-foreground cursor-not-allowed",
            )}
          >
            {isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
