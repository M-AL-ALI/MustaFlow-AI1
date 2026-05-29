import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useUser } from "@clerk/react";
import { useLocation } from "wouter";
import {
  X,
  Send,
  Globe,
  ChevronDown,
  Paperclip,
  FileText,
  Table2,
  AlertCircle,
  Loader2,
  Volume2,
  VolumeX,
  Trash2,
} from "lucide-react";
import { OraMessageActions } from "@/components/ora/ora-message-actions";
import { cn } from "@/lib/utils";
import type { UseOraChatReturn, UploadState, AttachedFile } from "@/hooks/use-ora-chat";
import { useOraVoice } from "@/hooks/use-ora-voice";
import {
  OraVoiceModeButton,
  OraVoiceLiveArea,
  OraDictationButton,
  OraVoiceConvPanel,
} from "@/components/ora/ora-voice-mode-button";
import { DatasetResultCard } from "@/components/dataset-result-card";
import { DynamicAtom, type AtomState } from "@/components/ora/dynamic-atom";
import { hasBuildIntent } from "@/components/ora/build-intent";
import { OraImageChip } from "@/components/ora/ora-image-chip";
import { OraHandoffCard } from "@/components/ora/ora-handoff-card";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

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
  "analyzing-image": "Analyzing image…",
};

interface OraBubbleProps {
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
        "flex items-start gap-2 rounded-xl border px-2.5 py-1.5 text-[11px] mb-2",
        uploadState === "attached" &&
          "border-[hsl(265_85%_65%/0.35)] bg-[hsl(265_85%_65%/0.07)] text-foreground",
        uploadState === "uploading" && "border-border bg-muted/30 text-muted-foreground",
        uploadState === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      <div className="shrink-0 mt-0.5">
        {uploadState === "uploading" && <Loader2 className="h-3 w-3 animate-spin" />}
        {uploadState === "attached" &&
          (isDataset ? (
            <Table2 className="h-3 w-3 text-[hsl(265_85%_65%)]" />
          ) : (
            <FileText className="h-3 w-3 text-[hsl(265_85%_65%)]" />
          ))}
        {uploadState === "error" && <AlertCircle className="h-3 w-3" />}
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
              <span className="inline-flex items-center rounded-full bg-[hsl(265_85%_65%/0.12)] px-1.5 py-0.5 text-[9px] text-[hsl(265_85%_65%)]">
                {file.rowCount.toLocaleString()} rows
              </span>
            )}
            {file.colCount != null && (
              <span className="inline-flex items-center rounded-full bg-[hsl(265_85%_65%/0.12)] px-1.5 py-0.5 text-[9px] text-[hsl(265_85%_65%)]">
                {file.colCount} cols
              </span>
            )}
            {file.truncated && (
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-600 dark:text-amber-400">
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
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

function OraBubblePortal({ chat }: OraBubbleProps) {
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
    clearConversation,
  } = chat;

  const { isSignedIn } = useUser();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);
  const [handoffDismissed, setHandoffDismissed] = useState(false);
  const [editingFromIdx, setEditingFromIdx] = useState<number | null>(null);
  const [, setLocation] = useLocation();
  const feedRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const langMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Resize (desktop only) ────────────────────────────────────────────────
  const [panelWidth, setPanelWidth] = useState(() => {
    try {
      const v = localStorage.getItem("ora_bubble_width");
      return v ? Math.max(320, Math.min(720, Number(v))) : 384;
    } catch {
      return 384;
    }
  });
  const [isResizing, setIsResizing] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 640px)");
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // ─── Voice ────────────────────────────────────────────────────────────────
  // Two distinct modes share one SpeechRecognition instance:
  //   A. Normal dictation — transcript lands in the textarea; user presses Send.
  //   B. Voice Conversation Mode — auto-sends transcript, auto-speaks Ora's
  //      reply, then restarts listening for a continuous voice conversation.

  const [voiceReady, setVoiceReady] = useState(false);
  const [voiceConvActive, setVoiceConvActive] = useState(false);
  const [voiceConvTtsMuted, setVoiceConvTtsMuted] = useState(false);

  // Stable refs — always current, so effects and callbacks never go stale
  const voiceConvActiveRef = useRef(false);
  const wasConvSpeakingRef = useRef(false);
  const lastConvAssistantMsgRef = useRef<string | null>(null);
  const languageRef = useRef(language);
  const sendMessageRef = useRef(sendMessage);

  voiceConvActiveRef.current = voiceConvActive;
  languageRef.current = language;
  sendMessageRef.current = sendMessage;

  const handleVoiceTranscript = useCallback((text: string) => {
    if (voiceConvActiveRef.current) {
      // Voice Conversation Mode: auto-send — no textarea review step
      void sendMessageRef.current(text);
    } else {
      // Normal dictation: put transcript in textarea for user review
      setInput(text);
      setVoiceReady(true);
      setTimeout(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(text.length, text.length);
      }, 40);
    }
  }, []);

  const voice = useOraVoice(handleVoiceTranscript);

  // Stable ref to the voice hook (avoids adding the whole hook to effect deps)
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // Auto-clear the transcript-ready hint after 5 s (dictation mode only)
  useEffect(() => {
    if (!voiceReady) return;
    const t = setTimeout(() => setVoiceReady(false), 5000);
    return () => clearTimeout(t);
  }, [voiceReady]);

  const voiceErrorMsg =
    voice.voiceState === "permission_denied"
      ? "Microphone access was denied. Enable it in your browser settings or type your message."
      : voice.voiceState === "error"
        ? "Voice recognition failed. Please try again or type your message."
        : null;

  // ─── Voice Conversation Mode effects ──────────────────────────────────────

  // Auto-TTS: speak each new Ora reply when voice conv mode is active.
  // Uses speakTextForce so it works regardless of the user's TTS toggle preference —
  // Voice Conversation Mode has its own mute control (voiceConvTtsMuted).
  useEffect(() => {
    if (!voiceConvActive || voiceConvTtsMuted || isLoading) return;
    if (!voiceRef.current.isSpeechSynthesisSupported) return;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;
    if (lastMsg.content === lastConvAssistantMsgRef.current) return;
    lastConvAssistantMsgRef.current = lastMsg.content;
    voiceRef.current.speakTextForce(lastMsg.content, languageRef.current);
  }, [messages, isLoading, voiceConvActive, voiceConvTtsMuted]);

  // Conversation cycling: after Ora finishes speaking, restart listening
  useEffect(() => {
    if (!voiceConvActive) return;
    if (voice.voiceState === "speaking") {
      wasConvSpeakingRef.current = true;
      return;
    }
    if (!(voice.voiceState === "idle" && wasConvSpeakingRef.current && !isLoading)) return;
    wasConvSpeakingRef.current = false;
    const tid = setTimeout(() => {
      if (voiceConvActiveRef.current) {
        voiceRef.current.startListening(languageRef.current);
      }
    }, 350);
    return () => clearTimeout(tid);
  }, [voice.voiceState, voiceConvActive, isLoading]);

  // ─── Derived state ────────────────────────────────────────────────────────

  const atFileLimit = (session?.fileCount ?? 0) >= (session?.fileLimit ?? 3);
  const atImageLimit = (session?.imageCount ?? 0) >= (session?.imageLimit ?? 2);
  const atAllLimits = atFileLimit && atImageLimit;

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
              : oraStatus === "analyzing" || oraStatus === "analyzing-image"
                ? "analyzing"
                : "idle";

  // ─── Effects ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (open && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [messages, isLoading, open]);

  // Revoke object URL when it changes (to free memory)
  useEffect(() => {
    return () => {
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    };
  }, [previewObjectUrl]);

  // Revoke preview URL when attachment is cleared after successful send
  useEffect(() => {
    if (!attachedFile && previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      setPreviewObjectUrl(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachedFile]);

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

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading || atLimit || uploadState === "uploading") return;
    setInput("");
    const editedFrom = editingFromIdx !== null ? true : undefined;
    setEditingFromIdx(null);
    void sendMessage(text, editedFrom ? { editedFrom: true } : undefined);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Typing while Ora speaks → cancel TTS immediately
    if (voice.voiceState === "speaking") {
      voice.stopSpeaking();
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleEditMessage = useCallback((text: string, fromIndex?: number) => {
    if (fromIndex !== undefined) setEditingFromIdx(fromIndex);
    setInput(text);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(text.length, text.length);
    }, 40);
  }, []);

  const handleContinueInBuilder = useCallback(async () => {
    try {
      const safeMessages = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .filter((m) => !m.datasetResult)
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 300) }));
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${BASE}/api/public-ai/handoff/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ messages: safeMessages }),
      });
      if (!res.ok) throw new Error("Could not create handoff");
      const { token } = (await res.json()) as { token: string };
      setLocation(
        isSignedIn
          ? `/projects?handoff=${encodeURIComponent(token)}`
          : `/sign-up?handoff=${encodeURIComponent(token)}`,
      );
    } catch {
      setLocation("/sign-up");
    }
  }, [messages, isSignedIn, setLocation]);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
        setPreviewObjectUrl(URL.createObjectURL(file));
      } else if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
        setPreviewObjectUrl(null);
      }
      void uploadFile(file);
    },
    [uploadFile, previewObjectUrl],
  );

  const handleClearAttachment = useCallback(() => {
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      setPreviewObjectUrl(null);
    }
    clearAttachment();
    clearUploadError();
  }, [clearAttachment, clearUploadError, previewObjectUrl]);

  const handleEnterVoiceConvMode = useCallback(() => {
    voiceRef.current.stopListening();
    voiceRef.current.stopSpeaking();
    setInput("");
    setVoiceReady(false);
    wasConvSpeakingRef.current = false;
    lastConvAssistantMsgRef.current = null;
    setVoiceConvActive(true);
    voiceConvActiveRef.current = true;
    setTimeout(() => voiceRef.current.startListening(languageRef.current), 150);
  }, []);

  const handleExitVoiceConvMode = useCallback(() => {
    setVoiceConvActive(false);
    voiceConvActiveRef.current = false;
    wasConvSpeakingRef.current = false;
    voiceRef.current.stopListening();
    voiceRef.current.stopSpeaking();
  }, []);

  const handleResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidthRef.current;
    setIsResizing(true);

    const onMove = (me: PointerEvent) => {
      // Dragging left = increasing width (panel is on the right edge)
      const newWidth = Math.max(320, Math.min(720, startWidth + startX - me.clientX));
      setPanelWidth(newWidth);
    };

    const onUp = () => {
      setIsResizing(false);
      try { localStorage.setItem("ora_bubble_width", String(panelWidthRef.current)); } catch { /* ignore */ }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const currentLangLabel = LANGUAGES.find((l) => l.value === language)?.label ?? "Auto Detect";

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Floating trigger button */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex items-center gap-2.5 px-4 py-2.5 rounded-full shadow-lg border transition-all duration-200 text-sm font-semibold",
            open
              ? "bg-[hsl(265_85%_65%)] text-white border-[hsl(265_85%_58%)]"
              : "bg-card border-border/60 text-foreground hover:border-[hsl(265_85%_65%/0.4)] hover:bg-[hsl(265_85%_65%/0.07)]",
          )}
          aria-label={open ? "Close Ora" : "Ask Ora"}
        >
          {open ? (
            <X className="h-4 w-4" />
          ) : (
            <DynamicAtom state={isLoading ? atomState : "idle"} size={18} />
          )}
          Ask Ora
        </button>
      </div>

      {/* Backdrop on mobile — always mounted, fades in/out */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-background/50 backdrop-blur-sm sm:hidden transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0 pointer-events-none",
        )}
        onClick={() => setOpen(false)}
      />

      {/* Drawer — always mounted; slides in from right (desktop) or up (mobile) */}
      <div
        className={cn(
          "fixed z-50 bg-card border-border/50 shadow-2xl flex flex-col",
          "bottom-0 right-0 w-full",
          "sm:top-0 sm:rounded-tl-3xl sm:rounded-bl-3xl sm:border-y sm:border-l sm:border-r-0",
          "rounded-t-3xl sm:rounded-t-none border-t border-x sm:border-x-0",
          "max-h-[80vh] sm:max-h-screen sm:h-full",
          "border",
          !isResizing && "transition-transform duration-300 ease-in-out",
          open
            ? "translate-y-0 sm:translate-x-0"
            : "translate-y-full sm:translate-y-0 sm:translate-x-full pointer-events-none",
        )}
        style={isDesktop ? { width: `${panelWidth}px` } : undefined}
      >
        {/* Resize handle — desktop only, left edge drag */}
        <div
          className="absolute left-0 top-0 h-full w-2 cursor-col-resize hidden sm:flex items-center justify-center group z-10"
          onPointerDown={handleResizePointerDown}
          title="Drag to resize"
          aria-hidden
        >
          <div className="h-10 w-0.5 rounded-full bg-border/50 group-hover:bg-[hsl(265_85%_65%/0.7)] transition-colors duration-150" />
        </div>
            {/* Drawer header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 shrink-0">
              <div className="flex items-center gap-2.5">
                <DynamicAtom state={atomState} size={26} />
                <div>
                  <span className="text-sm font-semibold tracking-tight">Ora</span>
                  <span className="ml-1.5 text-[10px] text-muted-foreground/70">
                    Free · No sign-in
                  </span>
                </div>
                {oraStatus !== "idle" && (
                  <span className="text-[11px] text-muted-foreground animate-pulse">
                    {STATUS_LABELS[oraStatus]}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Voice Conversation Mode — Talk with Ora (premium orb in header) */}
                {voice.isSupported && (
                  <OraVoiceModeButton
                    voiceState={voiceConvActive ? voice.voiceState : "idle"}
                    isSupported={voice.isSupported}
                    onStart={handleEnterVoiceConvMode}
                    onStop={handleExitVoiceConvMode}
                    disabled={!voiceConvActive && isLoading}
                    size="sm"
                  />
                )}

                {/* TTS toggle */}
                {voice.isSpeechSynthesisSupported && (
                  <button
                    type="button"
                    onClick={voice.toggleTts}
                    title={
                      voice.isTtsEnabled ? "Disable voice responses" : "Enable voice responses"
                    }
                    aria-label={
                      voice.isTtsEnabled ? "Disable voice responses" : "Enable voice responses"
                    }
                    className={cn(
                      "flex items-center justify-center h-6 w-6 rounded-lg transition-colors",
                      voice.isTtsEnabled
                        ? "text-[hsl(265_85%_65%)] hover:text-[hsl(265_85%_55%)]"
                        : "text-muted-foreground/40 hover:text-muted-foreground",
                    )}
                  >
                    {voice.isTtsEnabled ? (
                      <Volume2 className="h-3.5 w-3.5" />
                    ) : (
                      <VolumeX className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}

                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void clearConversation()}
                    disabled={isLoading}
                    title="Clear conversation"
                    className="p-1 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}

                {/* Language selector */}
                <div className="relative" ref={langMenuRef}>
                  <button
                    type="button"
                    onClick={() => setShowLangMenu((v) => !v)}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground border border-border/50 rounded-full px-2 py-1 hover:bg-muted/40 transition-colors"
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
                  className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Message feed */}
            <div ref={feedRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-5 scroll-smooth">
              {messages.length === 0 && !isLoading && (
                <div className="text-center py-8">
                  <DynamicAtom state="idle" size={48} className="mx-auto mb-3" />
                  <p className="text-sm font-medium mb-1">Hi, I&apos;m Ora</p>
                  <p className="text-xs text-muted-foreground max-w-[220px] mx-auto leading-relaxed">
                    Your free AI consultant. Ask me anything about app planning, strategy, or
                    MustaFlow. Upload a PDF, DOCX, TXT, CSV, or XLSX for analysis.
                  </p>
                </div>
              )}
              {messages.map((msg, i) => {
                const isLastMessage = i === messages.length - 1;
                const prevUserMsg =
                  i > 0
                    ? messages
                        .slice(0, i)
                        .reverse()
                        .find((m) => m.role === "user")
                    : null;
                const showHandoffCard =
                  msg.role === "assistant" &&
                  isLastMessage &&
                  !isLoading &&
                  prevUserMsg != null &&
                  hasBuildIntent(prevUserMsg.content, msg.content) &&
                  !handoffDismissed &&
                  !voiceConvActive;
                const showSuggestions =
                  msg.role === "assistant" &&
                  isLastMessage &&
                  !isLoading &&
                  Array.isArray(msg.suggestions) &&
                  msg.suggestions.length > 0;

                const isLatestAssistant = msg.role === "assistant" && isLastMessage && !isLoading;

                return (
                  <div
                    key={i}
                    className={cn(
                      "flex group",
                      msg.role === "user" ? "justify-end" : "justify-start gap-2",
                    )}
                  >
                    {msg.role === "assistant" && (
                      <DynamicAtom state="idle" size={20} className="shrink-0 mt-0.5" />
                    )}
                    <div className="max-w-[85%]">
                      {msg.role === "user" ? (
                        <div className="bg-muted/60 text-sm rounded-2xl rounded-tr-sm px-3 py-2 text-foreground whitespace-pre-wrap break-words leading-relaxed">
                          {msg.content}
                        </div>
                      ) : msg.datasetResult ? (
                        <DatasetResultCard result={msg.datasetResult} />
                      ) : (
                        <div className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap break-words">
                          {msg.content}
                        </div>
                      )}

                      {msg.editedFrom && (
                        <p className="text-[10px] text-muted-foreground/50 mt-0.5 text-right pr-1">
                          Edited from earlier message
                        </p>
                      )}

                      <OraMessageActions
                        message={msg}
                        isLatestAssistant={isLatestAssistant}
                        onEdit={
                          msg.role === "user" ? (text) => handleEditMessage(text, i) : undefined
                        }
                        onRegenerate={
                          isLatestAssistant
                            ? (() => {
                                const prevUser = messages
                                  .slice(0, i)
                                  .reverse()
                                  .find((m) => m.role === "user");
                                return prevUser
                                  ? () => void sendMessage(prevUser.content, { truncateTo: i })
                                  : undefined;
                              })()
                            : undefined
                        }
                        onContinueInBuilder={
                          isLatestAssistant && msg.handoffCta
                            ? () => void handleContinueInBuilder()
                            : undefined
                        }
                        onReadAloud={
                          msg.role === "assistant" && voice.isSpeechSynthesisSupported
                            ? (text) => voice.speakText(text, language)
                            : undefined
                        }
                        isTtsAvailable={voice.isSpeechSynthesisSupported && voice.isTtsEnabled}
                        hasAttachment={msg.hadAttachment ?? false}
                      />

                      {showHandoffCard && (
                        <OraHandoffCard
                          messages={messages}
                          onDismiss={() => setHandoffDismissed(true)}
                        />
                      )}
                      {showSuggestions && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {msg.suggestions!.map((suggestion, si) => (
                            <button
                              key={si}
                              type="button"
                              onClick={() => {
                                if (!isLoading && !atLimit) void sendMessage(suggestion);
                              }}
                              disabled={isLoading || atLimit}
                              className="text-xs px-2.5 py-1.5 rounded-full border border-[hsl(265_85%_65%/0.3)] text-muted-foreground hover:text-foreground hover:border-[hsl(265_85%_65%/0.6)] hover:bg-[hsl(265_85%_65%/0.07)] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
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
              {/* Editing indicator */}
              {editingFromIdx !== null && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                  <span>Editing earlier message — reply will be added to conversation</span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingFromIdx(null);
                      setInput("");
                    }}
                    className="shrink-0 opacity-60 hover:opacity-100"
                    aria-label="Cancel edit"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )}

              {isLoading && (
                <div className="flex items-start gap-2">
                  <DynamicAtom state={atomState} size={20} className="shrink-0 mt-0.5" />
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

            {/* Error */}
            {error && (
              <div className="mx-4 mb-2 rounded-xl border border-destructive/25 bg-destructive/8 px-3 py-2 text-xs text-destructive flex items-start justify-between gap-2 shrink-0">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={clearError}
                  className="shrink-0 opacity-60 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            {/* Composer */}
            <div className="border-t border-border/40 px-4 py-3 shrink-0">
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
                  {attachedFile?.isImage || previewObjectUrl !== null ? (
                    <OraImageChip
                      uploadState={uploadState}
                      uploadError={uploadError}
                      filename={attachedFile?.filename}
                      sizeBytes={attachedFile?.sizeBytes}
                      width={attachedFile?.width}
                      height={attachedFile?.height}
                      previewObjectUrl={previewObjectUrl}
                      onClear={handleClearAttachment}
                    />
                  ) : (
                    <DatasetChip
                      file={attachedFile}
                      uploadState={uploadState}
                      uploadError={uploadError}
                      onClear={handleClearAttachment}
                      fileType={attachedFile?.fileType}
                    />
                  )}

                  {voiceConvActive ? (
                    /* ─── Voice Conversation Mode panel ─────────────────── */
                    <OraVoiceConvPanel
                      voiceState={voice.voiceState}
                      interimTranscript={voice.interimTranscript}
                      isLoading={isLoading}
                      isTtsMuted={voiceConvTtsMuted}
                      onToggleTtsMute={() => setVoiceConvTtsMuted((v) => !v)}
                      onExit={handleExitVoiceConvMode}
                      onInterrupt={() => voiceRef.current.stopSpeaking()}
                      size="sm"
                    />
                  ) : (
                    /* ─── Normal dictation + text input ─────────────────── */
                    <>
                      {/* Voice live area — dictation feedback only */}
                      <OraVoiceLiveArea
                        voiceState={voice.voiceState}
                        interimTranscript={voice.interimTranscript}
                        voiceReady={voiceReady}
                        voiceErrorMsg={voiceErrorMsg}
                        size="sm"
                      />

                      {/* Unified input bar */}
                      <div className="flex items-end gap-2 rounded-xl border border-border/60 bg-background/60 px-2 py-1.5 focus-within:border-[hsl(265_85%_65%/0.4)] focus-within:ring-1 focus-within:ring-[hsl(265_85%_65%/0.15)] transition-all">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".pdf,.docx,.txt,.csv,.xlsx,.png,.jpg,.jpeg,.webp"
                          className="sr-only"
                          aria-hidden
                          onChange={handleFileChange}
                        />
                        {/* Attachment button */}
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={isLoading || uploadState === "uploading" || atAllLimits}
                          title={
                            atAllLimits
                              ? "Upload limit reached for this session"
                              : "Upload images, PDF, DOCX, TXT, CSV, XLSX"
                          }
                          className={cn(
                            "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition-colors",
                            uploadState === "attached"
                              ? "text-[hsl(265_85%_65%)]"
                              : "text-muted-foreground hover:text-foreground",
                            (isLoading || uploadState === "uploading" || atAllLimits) &&
                              "opacity-40 cursor-not-allowed",
                          )}
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                        </button>

                        {/* Dictation button — speech-to-text only; transcript lands in textarea */}
                        <OraDictationButton
                          voiceState={voice.voiceState}
                          isSupported={voice.isSupported}
                          onStart={() => voice.startListening(language)}
                          onStop={() => voice.stopListening()}
                          disabled={isLoading || atLimit}
                          size="sm"
                        />

                        <textarea
                          ref={textareaRef}
                          value={input}
                          onChange={(e) => {
                            setInput(e.target.value);
                            if (voiceReady) setVoiceReady(false);
                          }}
                          onKeyDown={handleKeyDown}
                          placeholder={
                            uploadState === "attached"
                              ? attachedFile?.isImage
                                ? `Ask about ${attachedFile.filename ?? "this image"}…`
                                : `Ask about ${attachedFile?.filename ?? "this file"}…`
                              : "Ask Ora anything…"
                          }
                          rows={1}
                          className="flex-1 resize-none bg-transparent py-1 text-sm placeholder:text-muted-foreground/60 focus:outline-none leading-snug"
                          style={{ maxHeight: "80px" }}
                          disabled={isLoading}
                        />
                        <button
                          type="button"
                          onClick={handleSend}
                          disabled={!input.trim() || isLoading || uploadState === "uploading"}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[hsl(265_85%_65%)] text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[hsl(265_85%_58%)] transition-colors"
                        >
                          <Send className="h-3 w-3" />
                        </button>
                      </div>

                      <div className="flex items-center justify-between mt-1.5">
                        <p className="text-[9px] text-muted-foreground/50">
                          Upload images, PDF, DOCX, CSV, XLSX ·{" "}
                          {voice.isSupported
                            ? "Voice or type in any language"
                            : "Voice unavailable on this browser — typing still works"}
                        </p>
                        {session && (
                          <span className="text-[9px] text-muted-foreground/50">
                            {session.msgLimit - session.msgCount} left
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
      </div>
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
