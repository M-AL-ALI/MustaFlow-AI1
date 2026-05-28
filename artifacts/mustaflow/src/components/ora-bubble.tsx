import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import {
  X, Send, Globe, ChevronDown, MessageSquare,
  Paperclip, FileText, AlertCircle, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { UseOraChatReturn, UploadState } from "@/hooks/use-ora-chat";

const LANGUAGES = [
  { value: "auto", label: "Auto Detect" },
  { value: "en", label: "English" },
  { value: "ar", label: "Arabic" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
];

interface OraBubbleProps {
  chat: UseOraChatReturn;
}

function FileChip({
  uploadState,
  filename,
  uploadError,
  onClear,
}: {
  uploadState: UploadState;
  filename?: string;
  uploadError: string | null;
  onClear: () => void;
}) {
  if (uploadState === "idle") return null;

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[11px] mb-2",
        uploadState === "attached" &&
          "border-[hsl(265_85%_65%/0.4)] bg-[hsl(265_85%_65%/0.08)] text-foreground",
        uploadState === "uploading" &&
          "border-border bg-muted/30 text-muted-foreground",
        uploadState === "error" &&
          "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      {uploadState === "uploading" && (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      )}
      {uploadState === "attached" && (
        <FileText className="h-3 w-3 shrink-0 text-[hsl(265_85%_65%)]" />
      )}
      {uploadState === "error" && (
        <AlertCircle className="h-3 w-3 shrink-0" />
      )}

      <span className="flex-1 truncate min-w-0">
        {uploadState === "uploading" && `Uploading ${filename ?? "file"}…`}
        {uploadState === "attached" && (filename ?? "File attached")}
        {uploadState === "error" && (uploadError ?? "Upload failed")}
      </span>

      <button
        type="button"
        onClick={onClear}
        className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
        aria-label="Remove attachment"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function OraBubblePortal({ chat }: OraBubbleProps) {
  const {
    messages, isLoading, error, atLimit, language, setLanguage,
    sendMessage, clearError,
    uploadFile, clearAttachment,
    attachedFile, uploadState, uploadError, clearUploadError,
    session,
  } = chat;

  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [, setLocation] = useLocation();
  const feedRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const langMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const atFileLimit = (session?.fileCount ?? 0) >= (session?.fileLimit ?? 3);

  useEffect(() => {
    if (open && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages, isLoading, open]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 80)}px`;
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

  useEffect(() => {
    if (!open) return;
    function handleEscape(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open]);

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
    <>
      {/* Floating pill button */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg border transition-all duration-200 text-sm font-semibold",
            open
              ? "bg-[hsl(265_85%_65%)] text-white border-[hsl(265_85%_58%)]"
              : "bg-card border-[hsl(265_85%_65%/0.4)] text-foreground hover:bg-[hsl(265_85%_65%/0.1)]",
          )}
          aria-label={open ? "Close Ora" : "Ask Ora"}
        >
          {open ? (
            <X className="h-4 w-4" />
          ) : (
            <MessageSquare className="h-4 w-4 text-[hsl(265_85%_65%)]" />
          )}
          Ask Ora
        </button>
      </div>

      {/* Drawer */}
      {open && (
        <>
          {/* Backdrop on mobile */}
          <div
            className="fixed inset-0 z-40 bg-background/50 backdrop-blur-sm sm:hidden"
            onClick={() => setOpen(false)}
          />
          <div
            className={cn(
              "fixed z-50 bg-card border-l border-border shadow-2xl flex flex-col",
              "bottom-0 right-0 w-full sm:w-96 sm:max-w-[92vw]",
              "sm:top-0 sm:rounded-tl-3xl sm:rounded-bl-3xl sm:border-y sm:border-l sm:border-r-0",
              "rounded-t-3xl sm:rounded-t-none border-t border-x sm:border-x-0",
              "max-h-[80vh] sm:max-h-screen sm:h-full",
            )}
          >
            {/* Drawer header */}
            <div className="flex items-center justify-between px-4 py-3.5 border-b border-border bg-[hsl(265_85%_65%/0.05)] shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[hsl(265_85%_65%/0.2)] border border-[hsl(265_85%_65%/0.3)]">
                  <span className="text-sm font-bold text-[hsl(265_85%_65%)]">O</span>
                </div>
                <div>
                  <span className="text-sm font-bold tracking-tight">Ora</span>
                  <span className="ml-1.5 text-[10px] text-muted-foreground">
                    Free · No sign-in
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
              <div className="flex items-center gap-2">
                {/* Language selector */}
                <div className="relative" ref={langMenuRef}>
                  <button
                    type="button"
                    onClick={() => setShowLangMenu((v) => !v)}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded-full px-2 py-1 hover:bg-muted/50 transition-colors"
                  >
                    <Globe className="h-3 w-3" />
                    {currentLangLabel}
                    <ChevronDown className="h-2.5 w-2.5" />
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
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Message feed */}
            <div ref={feedRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scroll-smooth">
              {messages.length === 0 && !isLoading && (
                <div className="text-center py-8">
                  <div className="flex h-12 w-12 mx-auto mb-3 items-center justify-center rounded-2xl bg-[hsl(265_85%_65%/0.15)] border border-[hsl(265_85%_65%/0.3)]">
                    <span className="text-xl font-bold text-[hsl(265_85%_65%)]">O</span>
                  </div>
                  <p className="text-sm font-medium mb-1">Hi, I'm Ora</p>
                  <p className="text-xs text-muted-foreground max-w-[220px] mx-auto">
                    Your free AI consultant. Ask me anything about app planning, strategy, or
                    MustaFlow. You can also upload a PDF, DOCX, or TXT for analysis.
                  </p>
                </div>
              )}
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex",
                    msg.role === "user" ? "justify-end" : "justify-start gap-2",
                  )}
                >
                  {msg.role === "assistant" && (
                    <div className="flex h-5 w-5 shrink-0 mt-0.5 items-center justify-center rounded-md bg-[hsl(265_85%_65%/0.2)] border border-[hsl(265_85%_65%/0.3)]">
                      <span className="text-[9px] font-bold text-[hsl(265_85%_65%)]">O</span>
                    </div>
                  )}
                  <div className="max-w-[85%]">
                    {msg.role === "user" ? (
                      <div className="bg-primary/15 border border-primary/20 text-sm rounded-2xl rounded-tr-sm px-3 py-2 text-foreground whitespace-pre-wrap break-words">
                        {msg.content}
                      </div>
                    ) : (
                      <div className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap break-words">
                        {msg.content}
                      </div>
                    )}
                    {msg.role === "assistant" && msg.handoffCta && (
                      <div className="mt-2.5 rounded-xl border border-[hsl(265_85%_65%/0.3)] bg-[hsl(265_85%_65%/0.06)] p-3">
                        <p className="text-xs text-muted-foreground mb-1.5">Ready to build this?</p>
                        <button
                          type="button"
                          onClick={() => setLocation("/sign-up")}
                          className="text-xs font-semibold text-[hsl(265_85%_65%)] hover:underline"
                        >
                          Continue in the MustaFlow Builder →
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {isLoading && (
                <div className="flex items-start gap-2">
                  <div className="flex h-5 w-5 shrink-0 mt-0.5 items-center justify-center rounded-md bg-[hsl(265_85%_65%/0.2)] border border-[hsl(265_85%_65%/0.3)]">
                    <span className="text-[9px] font-bold text-[hsl(265_85%_65%)]">O</span>
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

            {/* Error */}
            {error && (
              <div className="mx-4 mb-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive flex items-start justify-between gap-2 shrink-0">
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
            <div className="border-t border-border px-4 py-3 shrink-0 bg-[hsl(265_85%_65%/0.03)]">
              {atLimit ? (
                <div className="text-center py-1">
                  <p className="text-xs text-muted-foreground">
                    Session limit reached.{" "}
                    <button
                      type="button"
                      onClick={() => setLocation("/sign-up")}
                      className="text-[hsl(265_85%_65%)] hover:underline"
                    >
                      Sign up for unlimited
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
                  />

                  <div className="flex items-end gap-2">
                    {/* Hidden file input */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.docx,.txt"
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
                          : "Upload a PDF, DOCX, or TXT file"
                      }
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border transition-colors",
                        uploadState === "attached"
                          ? "border-[hsl(265_85%_65%/0.5)] bg-[hsl(265_85%_65%/0.12)] text-[hsl(265_85%_65%)]"
                          : "border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted/40",
                        (isLoading || uploadState === "uploading" || atFileLimit) &&
                          "opacity-40 cursor-not-allowed",
                      )}
                    >
                      <Paperclip className="h-3.5 w-3.5" />
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
                      className="flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(265_85%_65%/0.5)] transition-all leading-snug"
                      style={{ maxHeight: "80px" }}
                      disabled={isLoading}
                    />
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!input.trim() || isLoading || uploadState === "uploading"}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[hsl(265_85%_65%)] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[hsl(265_85%_58%)] transition-colors shadow-sm"
                    >
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {session && (
                    <p className="text-[10px] text-muted-foreground/60 mt-1.5 text-right">
                      {session.msgLimit - session.msgCount} messages left
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

export function OraBubble({ chat }: OraBubbleProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) return null;
  return createPortal(<OraBubblePortal chat={chat} />, document.body);
}
