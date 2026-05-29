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
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { UseOraChatReturn, UploadState } from "@/hooks/use-ora-chat";
import { DatasetResultCard } from "@/components/dataset-result-card";

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

interface OraPanelProps {
  chat: UseOraChatReturn;
}

function FileChip({
  uploadState,
  filename,
  uploadError,
  onClear,
  fileType,
  rowCount,
  colCount,
}: {
  uploadState: UploadState;
  filename?: string;
  uploadError: string | null;
  onClear: () => void;
  fileType?: string;
  rowCount?: number;
  colCount?: number;
}) {
  if (uploadState === "idle") return null;

  const isDataset = fileType === "csv" || fileType === "xlsx";

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-xl border px-3 py-2 text-xs mb-2",
        uploadState === "attached" &&
          "border-[hsl(265_85%_65%/0.4)] bg-[hsl(265_85%_65%/0.08)] text-foreground",
        uploadState === "uploading" && "border-border bg-muted/30 text-muted-foreground",
        uploadState === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      {uploadState === "uploading" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
      {uploadState === "attached" && (
        isDataset
          ? <Table2 className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          : <FileText className="h-3.5 w-3.5 shrink-0 text-[hsl(265_85%_65%)]" />
      )}
      {uploadState === "error" && <AlertCircle className="h-3.5 w-3.5 shrink-0" />}

      <span className="flex-1 truncate min-w-0">
        {uploadState === "uploading" && `Uploading ${filename ?? "file"}…`}
        {uploadState === "attached" && (
          <span className="flex flex-col gap-0.5">
            <span className="truncate">{filename ?? "File attached"}</span>
            {isDataset && rowCount !== undefined && colCount !== undefined && (
              <span className="text-[10px] text-muted-foreground">
                {rowCount.toLocaleString()} rows × {colCount} cols
              </span>
            )}
          </span>
        )}
        {uploadState === "error" && (uploadError ?? "Upload failed")}
      </span>

      <button
        type="button"
        onClick={onClear}
        className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
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
    <div
      className={cn(
        "relative rounded-2xl border bg-card shadow-xl overflow-hidden transition-all duration-500",
        "border-[hsl(265_85%_65%/0.3)]",
      )}
      style={{
        background: "linear-gradient(135deg, hsl(265 85% 65% / 0.04) 0%, transparent 60%)",
      }}
    >
      <div
        className="absolute inset-0 rounded-2xl pointer-events-none"
        style={{
          background: "linear-gradient(135deg, hsl(265 85% 65% / 0.15) 0%, transparent 50%)",
          mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
          maskComposite: "exclude",
          padding: "1px",
        }}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-[hsl(265_85%_65%/0.2)] bg-[hsl(265_85%_65%/0.05)]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[hsl(265_85%_65%/0.2)] border border-[hsl(265_85%_65%/0.3)]">
            <span className="text-sm font-bold text-[hsl(265_85%_65%)]">O</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-bold tracking-tight">Ora</span>
            <span className="text-[10px] text-muted-foreground font-medium border border-border rounded-full px-1.5 py-0.5">
              Free · No sign-in required
            </span>
          </div>
          {isLoading && (
            <div className="flex items-center gap-0.5 ml-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="block h-1.5 w-1.5 rounded-full bg-[hsl(265_85%_65%)] animate-pulse"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Language selector */}
        <div className="relative" ref={langMenuRef}>
          <button
            type="button"
            onClick={() => setShowLangMenu((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border border-border rounded-full px-2.5 py-1 hover:bg-muted/50 transition-colors"
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
        <div className="px-5 py-4">
          <p className="text-xs text-muted-foreground mb-3">
            Ask Ora anything about planning your app, strategy, or MustaFlow:
          </p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => handleChip(chip)}
                className="text-xs px-3 py-1.5 rounded-full border border-[hsl(265_85%_65%/0.3)] text-muted-foreground hover:text-foreground hover:border-[hsl(265_85%_65%/0.6)] hover:bg-[hsl(265_85%_65%/0.08)] transition-all"
              >
                {chip}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Message feed */}
      {hasMessages && (
        <div ref={feedRef} className="px-5 py-4 max-h-80 overflow-y-auto space-y-4 scroll-smooth">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start gap-2.5")}
            >
              {msg.role === "assistant" && (
                <div className="flex h-6 w-6 shrink-0 mt-0.5 items-center justify-center rounded-md bg-[hsl(265_85%_65%/0.2)] border border-[hsl(265_85%_65%/0.3)]">
                  <span className="text-[10px] font-bold text-[hsl(265_85%_65%)]">O</span>
                </div>
              )}
              <div className="max-w-[85%]">
                {msg.role === "user" ? (
                  <div className="bg-primary/15 border border-primary/20 text-sm rounded-2xl rounded-tr-sm px-3.5 py-2 text-foreground whitespace-pre-wrap break-words">
                    {msg.content}
                  </div>
                ) : msg.datasetResult ? (
                  <DatasetResultCard result={msg.datasetResult} />
                ) : (
                  <div className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap break-words">
                    {msg.content}
                  </div>
                )}
                {msg.role === "assistant" && msg.handoffCta && (
                  <div className="mt-3 rounded-xl border border-[hsl(265_85%_65%/0.3)] bg-[hsl(265_85%_65%/0.06)] p-3.5 backdrop-blur-sm">
                    <p className="text-xs text-muted-foreground mb-2">
                      Ready to build this with MustaFlow?
                    </p>
                    <button
                      type="button"
                      onClick={() => setLocation("/sign-up")}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-[hsl(265_85%_65%)] hover:underline"
                    >
                      Continue in the MustaFlow Builder
                      <span aria-hidden>→</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex items-start gap-2.5">
              <div className="flex h-6 w-6 shrink-0 mt-0.5 items-center justify-center rounded-md bg-[hsl(265_85%_65%/0.2)] border border-[hsl(265_85%_65%/0.3)]">
                <span className="text-[10px] font-bold text-[hsl(265_85%_65%)]">O</span>
              </div>
              <div className="flex items-center gap-1 pt-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="block h-2 w-2 rounded-full bg-[hsl(265_85%_65%/0.6)] animate-pulse"
                    style={{ animationDelay: `${i * 200}ms` }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-5 mb-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive flex items-start justify-between gap-2">
          <span>{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="shrink-0 opacity-60 hover:opacity-100"
          >
            ×
          </button>
        </div>
      )}

      {/* Input footer */}
      <div className="border-t border-[hsl(265_85%_65%/0.2)] bg-[hsl(265_85%_65%/0.03)] px-4 py-3">
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
            {/* File chip */}
            <FileChip
              uploadState={uploadState}
              filename={attachedFile?.filename}
              uploadError={uploadError}
              onClear={handleClearAttachment}
              fileType={attachedFile?.fileType}
              rowCount={attachedFile?.rowCount}
              colCount={attachedFile?.colCount}
            />

            <div className="flex items-end gap-2">
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt,.csv,.xlsx"
                className="sr-only"
                aria-hidden
                onChange={handleFileChange}
              />

              {/* Upload button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading || uploadState === "uploading" || atFileLimit}
                title={
                  atFileLimit
                    ? `File limit reached (${session?.fileCount ?? 3}/${session?.fileLimit ?? 3})`
                    : "Upload a PDF, DOCX, TXT, CSV, or XLSX file"
                }
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors",
                  uploadState === "attached"
                    ? "border-[hsl(265_85%_65%/0.5)] bg-[hsl(265_85%_65%/0.12)] text-[hsl(265_85%_65%)]"
                    : "border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted/40",
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
                className="flex-1 resize-none rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(265_85%_65%/0.5)] transition-all leading-snug"
                style={{ maxHeight: "96px" }}
                disabled={isLoading}
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim() || isLoading || uploadState === "uploading"}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[hsl(265_85%_65%)] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[hsl(265_85%_58%)] transition-colors shadow-sm"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center justify-between mt-2">
              <p className="text-[10px] text-muted-foreground/60">
                {uploadState === "attached"
                  ? "File attached — type your question and send"
                  : "Upload PDF, DOCX, TXT, CSV, or XLSX · Talk in any language"}
              </p>
              {session && (
                <span className="text-[10px] text-muted-foreground/60">
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
