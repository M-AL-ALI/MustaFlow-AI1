import { useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { X, ArrowUp, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCreateProject } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListProjectsQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface BrainstormPanelProps {
  onClose: () => void;
}

const OPENING_MESSAGE: Message = {
  role: "assistant",
  content:
    "What are you thinking of building? Tell me as much or as little as you'd like and I'll help shape it.",
};

export function BrainstormPanel({ onClose }: BrainstormPanelProps) {
  const [messages, setMessages] = useState<Message[]>([OPENING_MESSAGE]);
  const [input, setInput] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [buildIntent, setBuildIntent] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [resolvedSpec, setResolvedSpec] = useState<{
    name: string;
    prompt: string;
    kind: "web" | "mobile-cross";
  } | null>(null);
  const [editableName, setEditableName] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const { toast } = useToast();

  const userTurns = messages.filter((m) => m.role === "user").length;
  const showBuildButton = userTurns >= 2 || buildIntent;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isFetching]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isFetching) return;
    setInput("");

    const newMessages: Message[] = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    setIsFetching(true);

    try {
      const res = await fetch("/api/brainstorm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages.filter((m) => m !== OPENING_MESSAGE) }),
      });

      if (!res.ok) throw new Error("request failed");

      const data = (await res.json()) as { reply: string; buildIntent: boolean };
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
      if (data.buildIntent) setBuildIntent(true);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, I had trouble connecting. Please try again." },
      ]);
    } finally {
      setIsFetching(false);
    }
  }, [input, isFetching, messages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const handleBuildIt = useCallback(async () => {
    if (isResolving || isFetching) return;
    setIsResolving(true);

    const chatMessages = messages.filter((m) => m !== OPENING_MESSAGE);
    try {
      const res = await fetch("/api/brainstorm/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: chatMessages }),
      });

      if (!res.ok) throw new Error("resolve failed");

      const data = (await res.json()) as {
        name: string;
        prompt: string;
        kind: "web" | "mobile-cross";
      };
      setResolvedSpec(data);
      setEditableName(data.name);
    } catch {
      toast({
        title: "Something went wrong",
        description: "Could not resolve your project spec — try again.",
        variant: "destructive",
      });
    } finally {
      setIsResolving(false);
    }
  }, [isResolving, isFetching, messages, toast]);

  const handleCreateProject = useCallback(() => {
    if (!resolvedSpec || isCreating) return;
    const name = (nameRef.current?.textContent ?? editableName).trim() || resolvedSpec.name;
    setIsCreating(true);
    createProject.mutate(
      {
        data: {
          name,
          description: resolvedSpec.prompt,
          kind: resolvedSpec.kind,
          initialPrompt: resolvedSpec.prompt,
        },
      },
      {
        onSuccess: (project) => {
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          setLocation(`/projects/${project.id}`);
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
  }, [resolvedSpec, isCreating, editableName, createProject, queryClient, setLocation, toast]);

  return (
    <div
      className="w-full overflow-hidden transition-all duration-200 ease-out"
      style={{ maxHeight: "460px" }}
    >
      <div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden mt-2">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
          <span className="text-xs font-semibold text-foreground">Brainstorm your idea</span>
          <button
            onClick={onClose}
            className="h-6 w-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
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

        {/* Resolved spec + create form */}
        {resolvedSpec && (
          <div className="px-4 py-3 border-t border-border bg-muted/20 space-y-3">
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
          </div>
        )}

        {/* Build it button */}
        {showBuildButton && !resolvedSpec && (
          <div className="px-4 pb-2 pt-1 border-t border-border">
            <button
              onClick={() => void handleBuildIt()}
              disabled={isResolving || isFetching}
              className={cn(
                "w-full flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors px-3 py-2 text-sm font-medium",
                buildIntent && !isResolving && "animate-pulse",
              )}
            >
              {isResolving ? (
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

        {/* Input bar */}
        {!resolvedSpec && (
          <div className="flex items-end gap-2 px-3 pb-3 pt-2 border-t border-border">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tell me more..."
              rows={1}
              disabled={isFetching}
              className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none min-h-[28px] max-h-[72px] overflow-y-auto"
            />
            <button
              onClick={() => void sendMessage()}
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
