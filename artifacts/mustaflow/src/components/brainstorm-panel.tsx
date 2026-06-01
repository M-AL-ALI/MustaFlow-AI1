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
  onResolved?: (prompt: string, messages: Message[]) => void;
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

export function BrainstormPanel({
  onClose,
  mode,
  onCreated,
  onResolved,
  projectId,
  storageKey,
  initialInput,
}: BrainstormPanelProps) {
  const [visible, setVisible] = useState(false);

  const effectiveKey = resolveStorageKey(projectId, storageKey);
  const initialState = loadPersistedState(effectiveKey);
  const [messages, setMessages] = useState<Message[]>(initialState.messages);
  const [input, setInput] = useState(initialInput ?? "");
  const [buildIntent, setBuildIntent] = useState(initialState.buildIntent);
  const [pulseIntent, setPulseIntent] = useState(false);
  const [resolvedSpec, setResolvedSpec] = useState<{
    name: string;
    prompt: string;
    kind: "web" | "mobile-cross";
  } | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
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
    setMessages([OPENING_MESSAGE]);
    setBuildIntent(false);
    setResolvedSpec(null);
    setInput("");
    if (effectiveKey) clearPersistedState(effectiveKey);
  }, [effectiveKey]);

  const sendMessage = useCallback(() => {
    const text = input.trim();
    if (!text || chatMutation.isPending) return;
    setInput("");
    setTimeout(() => inputRef.current?.focus(), 0);

    const chatMessages = messages.filter((m) => !isOpeningMessage(m));
    const newMessages: Message[] = [...messages, { role: "user", content: text }];
    setMessages(newMessages);

    chatMutation.mutate(
      {
        data: {
          messages: [...chatMessages, { role: "user", content: text }],
        },
      },
      {
        onSuccess: (data) => {
          setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
          if (data.buildIntent) setBuildIntent(true);
        },
        onError: () => {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: "Sorry, I had trouble connecting. Please try again.",
            },
          ]);
        },
      },
    );
  }, [input, chatMutation, messages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleBuildIt = useCallback(() => {
    if (resolveMutation.isPending || chatMutation.isPending) return;
    const chatMessages = messages.filter((m) => !isOpeningMessage(m));
    resolveMutation.mutate(
      { data: { messages: chatMessages } },
      {
        onSuccess: (data) => {
          setResolvedSpec(data);
        },
        onError: () => {
          toast({
            title: "Something went wrong",
            description: "Could not resolve your project spec — try again.",
            variant: "destructive",
          });
        },
      },
    );
  }, [resolveMutation, chatMutation.isPending, messages, toast]);

  const handleCreateProject = useCallback(() => {
    if (!resolvedSpec || isCreating) return;
    const name = (nameRef.current?.textContent ?? "").trim() || resolvedSpec.name;
    setIsCreating(true);
    const brainstormMessages = messages.filter((m) => m !== OPENING_MESSAGE);
    createProject.mutate(
      {
        data: {
          name,
          description: resolvedSpec.prompt,
          kind: resolvedSpec.kind,
          initialPrompt: resolvedSpec.prompt,
          ...(mode ? { mode } : {}),
          ...(brainstormMessages.length > 0 ? { brainstormContext: brainstormMessages } : {}),
        },
      },
      {
        onSuccess: (project) => {
          if (effectiveKey) clearPersistedState(effectiveKey);
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          if (onCreated) {
            onCreated(project.id);
          } else {
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
  }, [
    resolvedSpec,
    isCreating,
    createProject,
    queryClient,
    setLocation,
    toast,
    mode,
    onCreated,
    effectiveKey,
    messages,
  ]);

  return (
    <div
      className={cn(
        "w-full overflow-hidden transition-all duration-200 ease-out",
        visible ? "max-h-[460px] opacity-100" : "max-h-0 opacity-0",
      )}
    >
      <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden mt-2">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
          <span className="text-xs font-semibold text-foreground">Brainstorm your idea</span>
          <div className="flex items-center gap-1">
            {hasConversation && (
              <button
                onClick={handleStartFresh}
                title="Start fresh"
                className="h-6 flex items-center gap-1 px-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors text-xs"
              >
                <RotateCcw className="h-3 w-3" />
                Start fresh
              </button>
            )}
            <button
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
          className="overflow-y-auto px-4 py-3 space-y-3"
          style={{ maxHeight: "300px" }}
        >
          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed",
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

        {/* Resolved spec + create / use-prompt form */}
        {resolvedSpec && (
          <div className="px-4 py-3 border-t border-border bg-muted/20 space-y-3">
            {onResolved ? (
              <>
                <p className="text-xs text-muted-foreground line-clamp-3">{resolvedSpec.prompt}</p>
                <button
                  onClick={() => {
                    if (effectiveKey) clearPersistedState(effectiveKey);
                    const chatMessages = messages.filter((m) => !isOpeningMessage(m));
                    onResolved(resolvedSpec.prompt, chatMessages);
                    onClose();
                  }}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors px-3 py-2 text-sm font-medium"
                >
                  Use this prompt
                </button>
              </>
            ) : (
              <>
                <div className="text-xs text-muted-foreground">
                  Project name:{" "}
                  <span
                    ref={nameRef}
                    contentEditable
                    suppressContentEditableWarning
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        (e.currentTarget as HTMLElement).blur();
                      }
                    }}
                    className="font-semibold text-foreground border-b border-dashed border-border outline-none focus:border-primary px-0.5"
                  >
                    {resolvedSpec.name}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">{resolvedSpec.prompt}</p>
                <button
                  onClick={handleCreateProject}
                  disabled={isCreating}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors px-3 py-2 text-sm font-medium"
                >
                  {isCreating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Creating project...
                    </>
                  ) : (
                    "Create project"
                  )}
                </button>
              </>
            )}
          </div>
        )}

        {/* Build it button */}
        {showBuildButton && !resolvedSpec && (
          <div className="px-4 pb-2 pt-1 border-t border-border">
            <button
              onClick={handleBuildIt}
              disabled={resolveMutation.isPending || isFetching}
              className={cn(
                "w-full flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors px-3 py-2 text-sm font-medium",
                pulseIntent && "animate-pulse",
              )}
            >
              {resolveMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Preparing project...
                </>
              ) : (
                "Build it"
              )}
            </button>
          </div>
        )}

        {/* Input bar — hidden once resolved */}
        {!resolvedSpec && (
          <div className="flex items-end gap-2 px-3 pb-3 pt-2 border-t border-border">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tell me more..."
              rows={1}
              disabled={isFetching}
              className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none min-h-[28px] max-h-[72px] overflow-y-auto"
            />
            <button
              onClick={sendMessage}
              disabled={isFetching || !input.trim()}
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
        )}
      </div>
    </div>
  );
}
