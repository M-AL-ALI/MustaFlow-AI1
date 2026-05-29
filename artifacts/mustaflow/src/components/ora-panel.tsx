import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { useLocation } from "wouter";
import {
  Send,
  Globe,
  ChevronDown,
  Paperclip,
  FileText,
  Table2,
  AlertCircle,
  Loader2,
  X,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { UseOraChatReturn, UploadState, AttachedFile } from "@/hooks/use-ora-chat";
import { DatasetResultCard } from "@/components/dataset-result-card";
import { DynamicAtom, type AtomState } from "@/components/ora/dynamic-atom";
import { hasBuildIntent } from "@/components/ora/build-intent";

const EXAMPLE_CHIPS = [
  "Plan an app idea",
  "Find the root cause of a problem",
  "Can MustaFlow build X?",
  "Help me think through a strategy",
  "What can I build with MustaFlow?",
  "Analyze a business idea",
];

const LANGUAGES = [
  { value: "auto", label: "Auto Detect" },
  { value: "en", label: "English" },
  { value: "ar", label: "Arabic" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
];

const STATUS_LABELS: Record<string, string> = {
  thinking: "Thinking…",
  replying: "Replying…",
  uploading: "Uploading…",
  reading: "Reading document…",
  analyzing: "Analyzing dataset…",
};

interface OraPanelProps {
  chat: UseOraChatReturn;
}

function DatasetChip({
  file,
  uploadState,
  uploadError,
  onClear,
  fileType,
}: {
  file: AttachedFile | null;
  uploadState: UploadState;
  uploadError: string | null;
  onClear: () => void;
  fileType?: string;
}) {
  if (uploadState === "idle") return null;

  const isDataset = fileType === "csv" || fileType === "xlsx";

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-xs mb-2",
        uploadState === "attached" &&
          "border-[hsl(265_85%_65%/0.35)] bg-[hsl(265_85%_65%/0.07)] text-foreground",
        uploadState === "uploading" && "border-border bg-muted/30 text-muted-foreground",
        uploadState === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      <div className="shrink-0 mt-0.5">
        {uploadState === "uploading" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {uploadState === "attached" &&
          (isDataset ? (
            <Table2 className="h-3.5 w-3.5 text-[hsl(265_85%_65%)]" />
          ) : (
            <FileText className="h-3.5 w-3.5 text-[hsl(265_85%_65%)]" />
          ))}
        {uploadState === "error" && <AlertCircle className="h-3.5 w-3.5" />}
      </div>

      <div className="flex-1 min-w-0">
        <span className="truncate block">
          {uploadState === "uploading" && `Uploading ${file?.filename ?? "file"}…`}
          {uploadState === "attached" && (file?.filename ?? "File attached")}
          {uploadState === "error" && (uploadError ?? "Upload failed")}
        </span>

        {uploadState === "attached" && file && isDataset && (file.rowCount || file.colCount) && (
          <div className="flex flex-wrap gap-1 mt-1">
            {file.rowCount != null && (
              <span className="inline-flex items-center rounded-full bg-[hsl(265_85%_65%/0.12)] px-1.5 py-0.5 text-[10px] text-[hsl(265_85%_65%)]">
                {file.rowCount.toLocaleString()} rows
              </span>
            )}
            {file.colCount != null && (
              <span className="inline-flex items-center rounded-full bg-[hsl(265_85%_65%/0.12)] px-1.5 py-0.5 text-[10px] text-[hsl(265_85%_65%)]">
                {file.colCount} cols
              </span>
            )}
            {file.truncated && (
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                Sampled
              </span>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onClear}
        className="shrink-0 opacity-50 hover:opacity-100 transition-opacity mt-0.5"
        aria-label="Remove attachment"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function OraPanel({ chat }: OraPanelProps) {
  const {
    messages,
    isLoading,
    error,
    atLimit,
    language,
    setLanguage,
    sendMessage,
    clearError,
    uploadFile,
    clearAttachment,
    attachedFile,
    uploadState,
    uploadError,
    clearUploadError,
    session,
    oraStatus,
  } = chat;

  const [input, setInput] = useState("");
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [, setLocation] = useLocation();
  const feedRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const langMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasMessages = messages.length > 0;

  const atFileLimit = (session?.fileCount ?? 0) >= (session?.fileLimit ?? 3);

  const atomState: AtomState =
    oraStatus === "idle"
      ? "idle"
      : oraStatus === "thinking"
        ? "thinking"
        : oraStatus === "replying"
          ? "replying"
          : oraStatus === "uploading"
            ? "uploading"
            : oraStatus === "reading"
              ? "reading"
              : oraStatus === "analyzing"
                ? "analyzing"
                : "idle";

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 96)}px`;
    }
  }, [input]);

  useEffect(() => {
    if (!showLangMenu) return;
    function handleClickOutside(e: MouseEvent) {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setShowLangMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showLangMenu]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading || atLimit || uploadState === "uploading") return;
    setInput("");
    void sendMessage(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChip = (chip: string) => {
    if (isLoading || atLimit) return;
    void sendMessage(chip);
  };

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";
      void uploadFile(file);
    },
    [uploadFile],
  );

  const handleClearAttachment = useCallback(() => {
    clearAttachment();
    clearUploadError();
  }, [clearAttachment, clearUploadError]);

  const currentLangLabel = LANGUAGES.find((l) => l.value === language)?.label ?? "Auto Detect";

  return (
    <div className="relative rounded-2xl border border-border/60 bg-card shadow-lg overflow-hidden transition-all duration-500">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2.5">
          <DynamicAtom state={atomState} size={28} />
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight">Ora</span>
            <span className="text-[10px] text-muted-foreground/70 font-medium border border-border/50 rounded-full px-1.5 py-0.5">
              Free · No sign-in required
            </span>
          </div>
          {oraStatus !== "idle" && (
            <span className="text-[11px] text-muted-foreground animate-pulse">
              {STATUS_LABELS[oraStatus]}
            </span>
          )}
        </div>

        {/* Language selector */}
        <div className="relative" ref={langMenuRef}>
          <button
            type="button"
            onClick={() => setShowLangMenu((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border border-border/50 rounded-full px-2.5 py-1 hover:bg-muted/40 transition-colors"
          >
            <Globe className="h-3 w-3" />
            {currentLangLabel}
            <ChevronDown className="h-3 w-3" />
          </button>
          {showLangMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 min-w-[120px] bg-popover border border-border rounded-xl shadow-lg py-1">
              {LANGUAGES.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  onClick={() => {
                    setLanguage(l.value);
                    setShowLangMenu(false);
                  }}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors",
                    language === l.value && "text-[hsl(265_85%_65%)] font-medium",
                  )}
                >
                  {l.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Example chips — shown before first message */}
      {!hasMessages && (
        <div className="px-4 py-4">
          <p className="text-xs text-muted-foreground mb-3">
            Ask Ora anything about planning your app, strategy, or MustaFlow:
          </p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => handleChip(chip)}
                className="text-xs px-3 py-1.5 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-[hsl(265_85%_65%/0.5)] hover:bg-[hsl(265_85%_65%/0.07)] transition-all"
              >
                {chip}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Message feed */}
      {hasMessages && (
        <div ref={feedRef} className="px-4 py-4 max-h-80 overflow-y-auto space-y-5 scroll-smooth">
          {messages.map((msg, i) => {
            const isLastMessage = i === messages.length - 1;
            const prevUserMsg =
              i > 0
                ? messages
                    .slice(0, i)
                    .reverse()
                    .find((m) => m.role === "user")
                : null;
            const showCta =
              msg.role === "assistant" &&
              prevUserMsg != null &&
              hasBuildIntent(prevUserMsg.content, msg.content);
            const showSuggestions =
              msg.role === "assistant" &&
              isLastMessage &&
              !isLoading &&
              Array.isArray(msg.suggestions) &&
              msg.suggestions.length > 0;

            return (
              <div
                key={i}
                className={cn(
                  "flex",
                  msg.role === "user" ? "justify-end" : "justify-start gap-2.5",
                )}
              >
                {msg.role === "assistant" && (
                  <DynamicAtom state="idle" size={24} className="shrink-0 mt-0.5" />
                )}
                <div className="max-w-[85%]">
                  {msg.role === "user" ? (
                    <div className="bg-muted/60 text-sm rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-foreground whitespace-pre-wrap break-words leading-relaxed">
                      {msg.content}
                    </div>
                  ) : msg.datasetResult ? (
                    <DatasetResultCard result={msg.datasetResult} />
                  ) : (
                    <div className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap break-words">
                      {msg.content}
                    </div>
                  )}
                  {showCta && (
                    <button
                      type="button"
                      onClick={() => setLocation("/sign-up")}
                      className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[hsl(265_85%_65%)] hover:text-[hsl(265_85%_55%)] transition-colors group"
                    >
                      Turn this into a project
                      <ArrowRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
                    </button>
                  )}
                  {showSuggestions && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {msg.suggestions!.map((suggestion, si) => (
                        <button
                          key={si}
                          type="button"
                          onClick={() => handleChip(suggestion)}
                          disabled={isLoading || atLimit}
                          className="text-xs px-3 py-1.5 rounded-full border border-[hsl(265_85%_65%/0.3)] text-muted-foreground hover:text-foreground hover:border-[hsl(265_85%_65%/0.6)] hover:bg-[hsl(265_85%_65%/0.07)] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Loading state */}
          {isLoading && (
            <div className="flex items-start gap-2.5">
              <DynamicAtom state={atomState} size={24} className="shrink-0 mt-0.5" />
              <div className="flex flex-col gap-1 pt-0.5">
                <div className="flex items-center gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="block h-1.5 w-1.5 rounded-full bg-[hsl(265_85%_65%/0.5)] animate-pulse"
                      style={{ animationDelay: `${i * 200}ms` }}
                    />
                  ))}
                </div>
                {oraStatus !== "idle" && (
                  <span className="text-[11px] text-muted-foreground">
                    Ora · {STATUS_LABELS[oraStatus]}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-4 mb-3 rounded-xl border border-destructive/25 bg-destructive/8 px-3.5 py-2.5 text-xs text-destructive flex items-start justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="shrink-0 opacity-60 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-border/40 px-4 py-3">
        {atLimit ? (
          <div className="text-center py-2">
            <p className="text-xs text-muted-foreground">
              Session limit reached.{" "}
              <button
                type="button"
                onClick={() => setLocation("/sign-up")}
                className="text-[hsl(265_85%_65%)] hover:underline"
              >
                Sign up for unlimited conversations
              </button>
            </p>
          </div>
        ) : (
          <>
            <DatasetChip
              file={attachedFile}
              uploadState={uploadState}
              uploadError={uploadError}
              onClear={handleClearAttachment}
              fileType={attachedFile?.fileType}
            />

            {/* Unified input bar */}
            <div className="flex items-end gap-2 rounded-xl border border-border/60 bg-background/60 px-2 py-1.5 focus-within:border-[hsl(265_85%_65%/0.4)] focus-within:ring-1 focus-within:ring-[hsl(265_85%_65%/0.15)] transition-all">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt,.csv,.xlsx"
                className="sr-only"
                aria-hidden
                onChange={handleFileChange}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading || uploadState === "uploading" || atFileLimit}
                title={
                  atFileLimit
                    ? `File limit reached (${session?.fileCount ?? 3}/${session?.fileLimit ?? 3})`
                    : "Upload PDF, DOCX, TXT, CSV, XLSX"
                }
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
                  uploadState === "attached"
                    ? "text-[hsl(265_85%_65%)]"
                    : "text-muted-foreground hover:text-foreground",
                  (isLoading || uploadState === "uploading" || atFileLimit) &&
                    "opacity-40 cursor-not-allowed",
                )}
              >
                <Paperclip className="h-4 w-4" />
              </button>

              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  uploadState === "attached"
                    ? `Ask about ${attachedFile?.filename ?? "this file"}…`
                    : "Ask Ora anything…"
                }
                rows={1}
                className="flex-1 resize-none bg-transparent py-1.5 text-sm placeholder:text-muted-foreground/60 focus:outline-none leading-snug"
                style={{ maxHeight: "96px" }}
                disabled={isLoading}
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim() || isLoading || uploadState === "uploading"}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[hsl(265_85%_65%)] text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[hsl(265_85%_58%)] transition-colors"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex items-center justify-between mt-2">
              <p className="text-[10px] text-muted-foreground/50">
                Upload PDF, DOCX, TXT, CSV, XLSX · Talk in any language
              </p>
              {session && (
                <span className="text-[10px] text-muted-foreground/50">
                  {session.msgLimit - session.msgCount} messages left
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
