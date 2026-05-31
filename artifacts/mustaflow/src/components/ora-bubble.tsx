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
  Upload,
  MoreHorizontal,
  FileSpreadsheet,
  Download,
} from "lucide-react";
import { OraMessageActions } from "@/components/ora/ora-message-actions";
import { OraExportMenu } from "@/components/ora/ora-export-menu";
import { cn } from "@/lib/utils";
import type {
  UseOraChatReturn,
  UploadState,
  AttachedFile,
  FileFormat,
  GeneratedFile,
} from "@/hooks/use-ora-chat";
import { useOraVoice } from "@/hooks/use-ora-voice";
import { useWhisperRecorder } from "@/hooks/use-whisper-recorder";
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

function downloadOraFile(file: GeneratedFile) {
  const byteChars = atob(file.fileData);
  const byteNums = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
  const blob = new Blob([byteNums], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Revoke after a delay so the browser has time to start the download
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 2000);
}

const FILE_FORMAT_OPTIONS: { value: FileFormat; label: string; ext: string }[] = [
  { value: "csv", label: "CSV Spreadsheet", ext: ".csv" },
  { value: "xlsx", label: "Excel (.xlsx)", ext: ".xlsx" },
  { value: "docx", label: "Word Document", ext: ".docx" },
  { value: "pdf", label: "PDF Document", ext: ".pdf" },
  { value: "pptx", label: "PowerPoint (.pptx)", ext: ".pptx" },
];

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const ACCEPTED_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".txt",
  ".csv",
  ".xlsx",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
]);

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
    generateFile,
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
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const [selectedFormat, setSelectedFormat] = useState<FileFormat | null>(null);
  const [showFormatMenu, setShowFormatMenu] = useState(false);
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);
  const [handoffDismissed, setHandoffDismissed] = useState(false);
  const [editingFromIdx, setEditingFromIdx] = useState<number | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [, setLocation] = useLocation();
  const feedRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevMsgCountRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const langMenuRef = useRef<HTMLDivElement>(null);
  const voicePickerRef = useRef<HTMLDivElement>(null);
  const formatMenuRef = useRef<HTMLDivElement>(null);
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

  // ─── Whisper push-to-talk (voice conv mode) ────────────────────────────────
  // When voice conv mode is active, Whisper AI transcribes the audio and
  // auto-sends — same path as the Web Speech API onFinalTranscript.
  const handleWhisperTranscript = useCallback((text: string) => {
    if (voiceConvActiveRef.current) {
      void sendMessageRef.current(text);
    }
  }, []);

  const whisperConv = useWhisperRecorder(handleWhisperTranscript, () => languageRef.current);

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

  // Conversation cycling: track when Ora finishes speaking so the UI can
  // re-show the push-to-talk button. No auto-start listening — Whisper mode
  // is push-to-talk: the user holds the "Hold to speak" button themselves.
  useEffect(() => {
    if (!voiceConvActive) return;
    if (voice.voiceState === "speaking") {
      wasConvSpeakingRef.current = true;
      return;
    }
    if (voice.voiceState === "idle" && wasConvSpeakingRef.current) {
      wasConvSpeakingRef.current = false;
    }
  }, [voice.voiceState, voiceConvActive]);

  // ─── Derived state ────────────────────────────────────────────────────────

  const atFileLimit = (session?.fileCount ?? 0) >= (session?.fileLimit ?? 3);
  const atImageLimit = (session?.imageCount ?? 0) >= (session?.imageLimit ?? 2);
  const atAllLimits = atFileLimit || atImageLimit;

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

  const handleFeedScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = nearBottom;
    setShowJumpToLatest(!nearBottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
    atBottomRef.current = true;
    setShowJumpToLatest(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const el = feedRef.current;
    if (!el) return;
    const newCount = messages.length;
    const countChanged = newCount !== prevMsgCountRef.current;
    prevMsgCountRef.current = newCount;
    if (countChanged || atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
      setShowJumpToLatest(false);
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
    if (!showVoicePicker) return;
    function handleClickOutside(e: MouseEvent) {
      if (voicePickerRef.current && !voicePickerRef.current.contains(e.target as Node)) {
        setShowVoicePicker(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showVoicePicker]);

  useEffect(() => {
    if (!showOverflowMenu) return;
    function handleClickOutside(e: MouseEvent) {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setShowOverflowMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showOverflowMenu]);

  useEffect(() => {
    if (!open) return;
    function handleEscape(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open]);

  useEffect(() => {
    if (!showFormatMenu) return;
    function handleClickOutside(e: MouseEvent) {
      if (formatMenuRef.current && !formatMenuRef.current.contains(e.target as Node)) {
        setShowFormatMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showFormatMenu]);

  // Auto-clear drop error after 4 s
  useEffect(() => {
    if (!dropError) return;
    const t = setTimeout(() => setDropError(null), 4000);
    return () => clearTimeout(t);
  }, [dropError]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  // Shared file dispatch for drag-and-drop and clipboard paste
  const handleDropFile = useCallback(
    (file: File) => {
      if (uploadState === "uploading") return;
      if (uploadState === "attached" || attachedFile) {
        setDropError("Remove the current attachment before uploading another.");
        return;
      }
      if (atAllLimits) {
        setDropError("Upload limit reached for this session.");
        return;
      }
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
      if (!ACCEPTED_EXTENSIONS.has(ext)) {
        setDropError(`"${file.name.slice(0, 40)}" is not a supported file type.`);
        return;
      }
      if (IMAGE_EXTENSIONS.has(ext)) {
        if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
        setPreviewObjectUrl(URL.createObjectURL(file));
      } else if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
        setPreviewObjectUrl(null);
      }
      void uploadFile(file);
    },
    [uploadFile, uploadState, attachedFile, atAllLimits, previewObjectUrl],
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (atAllLimits || uploadState === "uploading") return;
      setIsDragOver(true);
    },
    [atAllLimits, uploadState],
  );
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if ((e.currentTarget as Node).contains(e.relatedTarget as Node)) return;
    setIsDragOver(false);
  }, []);
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (!file) return;
      handleDropFile(file);
    },
    [handleDropFile],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData.items);
      const imgItem = items.find((it) => it.kind === "file" && it.type.startsWith("image/"));
      if (!imgItem) return; // fall through to normal text paste
      e.preventDefault();
      const raw = imgItem.getAsFile();
      if (!raw) return;
      const ext = raw.type === "image/png" ? ".png" : raw.type === "image/webp" ? ".webp" : ".jpg";
      handleDropFile(new File([raw], `pasted-image${ext}`, { type: raw.type }));
    },
    [handleDropFile],
  );

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading || atLimit || uploadState === "uploading") return;
    setInput("");
    if (selectedFormat) {
      const fmt = selectedFormat;
      setSelectedFormat(null);
      void generateFile(text, fmt);
    } else {
      const editedFrom = editingFromIdx !== null ? true : undefined;
      setEditingFromIdx(null);
      void sendMessage(text, editedFrom ? { editedFrom: true } : undefined);
    }
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
    // Whisper push-to-talk: don't auto-start the Web Speech API listener here.
    // The user starts recording by holding the "Hold to speak" button.
  }, []);

  const handleExitVoiceConvMode = useCallback(() => {
    setVoiceConvActive(false);
    voiceConvActiveRef.current = false;
    wasConvSpeakingRef.current = false;
    voiceRef.current.stopListening();
    voiceRef.current.stopSpeaking();
    whisperConv.cancelRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      try {
        localStorage.setItem("ora_bubble_width", String(panelWidthRef.current));
      } catch {
        /* ignore */
      }
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
      {/* Floating trigger button — hidden on mobile while drawer is open (drawer header X handles close) */}
      <div
        className={cn(
          "fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3",
          open && "hidden sm:flex",
        )}
      >
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
          "fixed inset-0 z-40 bg-black/50 sm:hidden",
          "transition-opacity ease-[cubic-bezier(0.32,0.72,0,1)]",
          open ? "opacity-100 duration-[350ms]" : "opacity-0 duration-200 pointer-events-none",
        )}
        onClick={() => setOpen(false)}
        aria-hidden
      />

      {/* Drawer — always mounted; slides in from right (desktop) or up (mobile) */}
      <div
        className={cn(
          "fixed z-50 bg-card border-border/50 flex flex-col",
          "bottom-0 right-0 w-full",
          "sm:top-0 sm:rounded-tl-3xl sm:rounded-bl-3xl sm:border-y sm:border-l sm:border-r-0",
          "rounded-t-3xl sm:rounded-t-none border-t border-x sm:border-x-0",
          "max-h-[85dvh] sm:max-h-screen sm:h-full",
          "border",
          !isResizing && [
            "transition-[transform,box-shadow] ease-[cubic-bezier(0.32,0.72,0,1)]",
            open ? "duration-[350ms]" : "duration-[250ms]",
          ],
          open
            ? "translate-y-0 sm:translate-x-0 shadow-2xl"
            : "translate-y-full sm:translate-y-0 sm:translate-x-full shadow-none pointer-events-none",
        )}
        style={
          isDesktop
            ? {
                width: `${panelWidth}px`,
                transition: isResizing
                  ? undefined
                  : `transform ${open ? "350ms" : "250ms"} cubic-bezier(0.32,0.72,0,1), box-shadow ${open ? "350ms" : "250ms"} cubic-bezier(0.32,0.72,0,1), width 350ms cubic-bezier(0.32,0.72,0,1)`,
              }
            : undefined
        }
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag-and-drop overlay */}
        {isDragOver && (
          <div
            className="absolute inset-0 z-[60] flex items-center justify-center border-2 border-dashed border-[hsl(265_85%_65%/0.7)] bg-card/90 backdrop-blur-sm pointer-events-none"
            aria-hidden
          >
            <div className="flex flex-col items-center gap-2 text-[hsl(265_85%_65%)]">
              <Upload className="h-7 w-7" />
              <span className="text-sm font-medium">Drop image or file to upload</span>
              <span className="text-xs text-muted-foreground">
                PNG, JPG, WEBP · PDF, DOCX, PPTX, TXT · CSV, XLSX
              </span>
            </div>
          </div>
        )}
        {/* Resize handle — desktop only, left edge drag */}
        <div
          className={cn(
            "absolute left-0 top-0 h-full w-2 cursor-col-resize hidden sm:flex items-center justify-center group z-10",
            "transition-opacity ease-[cubic-bezier(0.32,0.72,0,1)]",
            open ? "opacity-100 duration-[350ms] delay-100" : "opacity-0 duration-[150ms]",
          )}
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
              <span className="ml-1.5 text-[10px] text-muted-foreground/70">Free · No sign-in</span>
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
                title={voice.isTtsEnabled ? "Disable voice responses" : "Enable voice responses"}
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

            {/* Voice picker — desktop only (hidden on mobile to save header space) */}
            {voice.isSpeechSynthesisSupported && voice.availableVoices.length > 0 && (
              <div className="relative hidden sm:block" ref={voicePickerRef}>
                <button
                  type="button"
                  onClick={() => setShowVoicePicker((v) => !v)}
                  title="Change voice"
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground border border-border/50 rounded-full px-2 py-1 hover:bg-muted/40 transition-colors"
                >
                  {(() => {
                    const v = voice.availableVoices.find(
                      (v) => v.voiceURI === voice.selectedVoiceURI,
                    );
                    return v ? v.name.split(" ")[0] : "Voice";
                  })()}
                  <ChevronDown className="h-2.5 w-2.5" />
                </button>
                {showVoicePicker && (
                  <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-xl shadow-xl py-1 min-w-[200px] max-h-64 overflow-y-auto">
                    <p className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Select voice
                    </p>
                    {voice.availableVoices.map((v) => (
                      <button
                        key={v.voiceURI}
                        type="button"
                        onClick={() => {
                          voice.setVoiceURI(v.voiceURI);
                          setShowVoicePicker(false);
                        }}
                        className={cn(
                          "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors flex items-center justify-between gap-2",
                          v.voiceURI === voice.selectedVoiceURI &&
                            "text-[hsl(265_85%_65%)] font-medium",
                        )}
                      >
                        <span className="truncate">{v.name}</span>
                        <span className="text-[10px] text-muted-foreground/60 shrink-0">
                          {v.lang}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Export + trash — inline on desktop, collapsed into ⋯ on mobile */}
            {messages.length > 0 && (
              <>
                {/* Desktop: show inline */}
                <div className="hidden sm:flex items-center gap-2">
                  <OraExportMenu
                    source={{ kind: "conversation", messages }}
                    disabled={isLoading}
                    variant="header"
                  />
                  <button
                    type="button"
                    onClick={() => void clearConversation()}
                    disabled={isLoading}
                    title="Clear conversation"
                    className="p-1 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Mobile: ⋯ overflow menu */}
                <div className="relative sm:hidden" ref={overflowMenuRef}>
                  <button
                    type="button"
                    onClick={() => setShowOverflowMenu((v) => !v)}
                    title="More options"
                    className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                  {showOverflowMenu && (
                    <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-xl shadow-lg py-1 min-w-[140px]">
                      <OraExportMenu
                        source={{ kind: "conversation", messages }}
                        disabled={isLoading}
                        variant="header"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          void clearConversation();
                          setShowOverflowMenu(false);
                        }}
                        disabled={isLoading}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Clear conversation
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Language selector — icon-only on mobile, label on desktop */}
            <div className="relative" ref={langMenuRef}>
              <button
                type="button"
                onClick={() => setShowLangMenu((v) => !v)}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground border border-border/50 rounded-full px-2 py-1 hover:bg-muted/40 transition-colors"
                title={currentLangLabel}
              >
                <Globe className="h-3 w-3" />
                <span className="hidden sm:inline">{currentLangLabel}</span>
                <ChevronDown className="hidden sm:inline h-2.5 w-2.5" />
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

        {/* Message feed — overflow-y-auto sits directly on the flex-1 min-h-0
             element so the flex algorithm constrains its height first, then
             overflow clips at that boundary. Putting h-full on a child inside
             a flex-1 wrapper does NOT work when the flex container only has
             max-height (not an explicit height), which the mobile drawer uses.
             Content is wrapped in an inner padding div; the jump button uses
             sticky so it stays pinned to the visible bottom of the scroll area. */}
        <div
          ref={feedRef}
          onScroll={handleFeedScroll}
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain scroll-smooth"
        >
          <div className="px-4 py-4 space-y-5">
            {messages.length === 0 && !isLoading && (
              <div className="text-center py-8">
                <DynamicAtom state="idle" size={48} className="mx-auto mb-3" />
                <p className="text-sm font-medium mb-1">Hi, I&apos;m Ora</p>
                <p className="text-xs text-muted-foreground max-w-[220px] mx-auto leading-relaxed">
                  Your free AI consultant. Ask me anything about app planning, strategy, or
                  MustaFlow. Upload a PDF, DOCX, PPTX, TXT, CSV, or XLSX for analysis.
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
                      <div
                        dir="auto"
                        className="bg-muted/60 text-sm rounded-2xl rounded-tr-sm px-3 py-2 text-foreground whitespace-pre-wrap break-words leading-relaxed"
                      >
                        {msg.content}
                      </div>
                    ) : msg.datasetResult ? (
                      <DatasetResultCard result={msg.datasetResult} />
                    ) : (
                      <div
                        dir="auto"
                        className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap break-words"
                      >
                        {msg.content}
                      </div>
                    )}

                    {msg.generatedFile && (
                      <button
                        type="button"
                        onClick={() => downloadOraFile(msg.generatedFile!)}
                        className="mt-2 w-full text-left group flex items-center gap-2.5 rounded-xl border border-[hsl(265_85%_65%/0.35)] bg-[hsl(265_85%_65%/0.06)] hover:bg-[hsl(265_85%_65%/0.12)] hover:border-[hsl(265_85%_65%/0.55)] px-3 py-2.5 transition-all cursor-pointer"
                      >
                        <div className="shrink-0 flex h-8 w-8 items-center justify-center rounded-lg bg-[hsl(265_85%_65%/0.15)]">
                          <FileSpreadsheet className="h-4 w-4 text-[hsl(265_85%_65%)]" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] font-semibold truncate text-foreground">
                            {msg.generatedFile.fileName}
                          </p>
                          <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                            {msg.generatedFile.format.toUpperCase()} · Click to download
                          </p>
                        </div>
                        <Download className="h-3.5 w-3.5 text-[hsl(265_85%_65%)] shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" />
                      </button>
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
          {showJumpToLatest && (
            <div className="sticky bottom-2 flex justify-end pr-3 z-10">
              <button
                type="button"
                onClick={jumpToLatest}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-card border border-border/60 text-[11px] text-muted-foreground hover:text-foreground shadow-sm hover:shadow-md transition-all"
              >
                <ChevronDown className="h-3 w-3" />
                Latest
              </button>
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

        {/* Composer — pb uses safe-area-inset-bottom so the iPhone home indicator
             never clips the input area. Falls back to 12 px on non-notched devices. */}
        <div
          className="border-t border-border/40 px-4 pt-3 shrink-0"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 12px)" }}
        >
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
                  whisperState={whisperConv.state}
                  whisperSupported={whisperConv.isSupported}
                  whisperError={whisperConv.error}
                  onWhisperStart={whisperConv.startRecording}
                  onWhisperStop={whisperConv.stopRecording}
                  onWhisperCancel={whisperConv.cancelRecording}
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

                  {/* Selected format chip */}
                  {selectedFormat && (
                    <div className="flex items-center gap-2 rounded-xl border border-[hsl(265_85%_65%/0.35)] bg-[hsl(265_85%_65%/0.07)] px-3 py-2 text-xs mb-2">
                      <FileSpreadsheet className="h-3 w-3 text-[hsl(265_85%_65%)] shrink-0" />
                      <span className="flex-1 text-foreground">
                        Generate:{" "}
                        {FILE_FORMAT_OPTIONS.find((f) => f.value === selectedFormat)?.label}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedFormat(null)}
                        className="shrink-0 opacity-50 hover:opacity-100 transition-opacity"
                        aria-label="Cancel file generation"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )}

                  {/* Unified input bar */}
                  <div className="flex items-end gap-2 rounded-xl border border-border/60 bg-background/60 px-2 py-1.5 focus-within:border-[hsl(265_85%_65%/0.4)] focus-within:ring-1 focus-within:ring-[hsl(265_85%_65%/0.15)] transition-all">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.docx,.txt,.csv,.xlsx,.pptx,.png,.jpg,.jpeg,.webp"
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
                          : "Upload image or file (PNG, JPG, WEBP, PDF, DOCX, PPTX, TXT, CSV, XLSX)"
                      }
                      aria-label={atAllLimits ? "Upload limit reached" : "Upload image or file"}
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

                    {/* Generate file button */}
                    <div className="relative shrink-0" ref={formatMenuRef}>
                      <button
                        type="button"
                        onClick={() => setShowFormatMenu((v) => !v)}
                        disabled={isLoading}
                        title="Generate a file (CSV, Excel, Word, PDF)"
                        aria-label="Generate file"
                        className={cn(
                          "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition-colors",
                          selectedFormat
                            ? "text-[hsl(265_85%_65%)] bg-[hsl(265_85%_65%/0.12)]"
                            : "text-muted-foreground hover:text-foreground",
                          isLoading && "opacity-40 cursor-not-allowed",
                        )}
                      >
                        <FileSpreadsheet className="h-3.5 w-3.5" />
                      </button>
                      {showFormatMenu && (
                        <div className="absolute bottom-full mb-1.5 left-0 z-50 bg-popover border border-border rounded-xl shadow-xl py-1 min-w-[155px]">
                          <p className="px-3 pt-1.5 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                            Generate file
                          </p>
                          {FILE_FORMAT_OPTIONS.map((opt) => (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => {
                                setSelectedFormat(opt.value);
                                setShowFormatMenu(false);
                                textareaRef.current?.focus();
                              }}
                              className={cn(
                                "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors flex items-center justify-between gap-2",
                                selectedFormat === opt.value &&
                                  "text-[hsl(265_85%_65%)] font-medium",
                              )}
                            >
                              <span>{opt.label}</span>
                              <span className="text-[10px] text-muted-foreground/60 shrink-0">
                                {opt.ext}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

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
                        selectedFormat
                          ? `Describe the ${FILE_FORMAT_OPTIONS.find((f) => f.value === selectedFormat)?.label} you want…`
                          : uploadState === "attached"
                            ? attachedFile?.isImage
                              ? `Ask about ${attachedFile.filename ?? "this image"}…`
                              : `Ask about ${attachedFile?.filename ?? "this file"}…`
                            : "Ask Ora anything…"
                      }
                      rows={1}
                      dir="auto"
                      className="flex-1 resize-none bg-transparent py-1 text-sm placeholder:text-muted-foreground/60 focus:outline-none leading-snug"
                      style={{ maxHeight: "80px" }}
                      disabled={isLoading}
                      onPaste={handlePaste}
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
                    {dropError ? (
                      <p className="text-[9px] text-destructive">{dropError}</p>
                    ) : language === "ar" ? (
                      <p className="text-[9px] text-muted-foreground/50">
                        Arabic voice depends on your browser — review before sending
                      </p>
                    ) : (
                      <p className="text-[9px] text-muted-foreground/50">
                        Upload or drag images, PDF, DOCX, CSV, XLSX ·{" "}
                        {voice.isSupported
                          ? "Voice or type in any language"
                          : "Voice unavailable on this browser — typing still works"}
                      </p>
                    )}
                    {session && (
                      <span className="text-[9px] text-muted-foreground/50 shrink-0 ml-1.5">
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
