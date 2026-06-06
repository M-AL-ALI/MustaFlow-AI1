import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { useUser } from "@clerk/react";
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
  Volume2,
  VolumeX,
  Trash2,
  Upload,
  FileSpreadsheet,
  Download,
  LogIn,
  Zap,
  Brain,
  Lock,
  Wand2,
  GitBranch,
  Plus,
  MoreHorizontal,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListKnowledgeQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { authFetch } from "@/lib/api-fetch";
import { OraMessageActions } from "@/components/ora/ora-message-actions";
import { OraExportMenu } from "@/components/ora/ora-export-menu";
import { OraUsageInline } from "@/components/ora-usage-inline";
import { OraMemorySaveChip } from "@/components/ora/ora-memory-save-chip";
import { OraMemoryManager } from "@/components/ora/ora-memory-manager";
import { saveOraMemory } from "@/lib/ora-memory-save";
import { getAutoSaveMemories, getReferenceSavedMemories } from "@/lib/ora-memory-settings";
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
import { OraImageChip } from "@/components/ora/ora-image-chip";
import { OraSourceCards } from "@/components/ora/ora-source-cards";

function downloadOraFile(file: GeneratedFile) {
  if (!file.fileData) return;
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
  "analyzing-image": "Analyzing image…",
};

interface OraPanelProps {
  chat: UseOraChatReturn;
  /**
   * "card" (default) — compact bounded card used in the landing-page embed.
   * "full" — full-height, centered single-column ChatGPT-style layout used on
   * the standalone /ora page.
   */
  layout?: "card" | "full";
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

export function OraPanel({ chat, layout = "card" }: OraPanelProps) {
  const isFull = layout === "full";
  const {
    messages,
    isLoading,
    error,
    atLimit,
    language,
    setLanguage,
    mode,
    setMode,
    sendMessage,
    generateFile,
    editInlineImage,
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
    sessionExpired,
    dismissSessionExpired,
    markMemorySaved,
  } = chat;

  const { isSignedIn } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tier, setTier] = useState("free");

  useEffect(() => {
    if (!isSignedIn) {
      setTier("free");
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        let res = await authFetch("/api/public-ai/session");
        if (res.status === 401) {
          res = await authFetch("/api/public-ai/session", { method: "POST" });
        }
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { tier?: string };
        if (!cancelled) setTier(data.tier ?? "free");
      } catch {
        if (!cancelled) setTier("free");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isSignedIn]);

  const deepAllowed = tier === "core" || tier === "wave";

  // Inline image editing: which editable image's edit box is open, and its draft
  // instruction text. Keyed by the image's generated_images id (unique per image).
  const [editingImageId, setEditingImageId] = useState<number | null>(null);
  const [editImageInstruction, setEditImageInstruction] = useState("");
  const submitImageEdit = useCallback(
    (imageId: number) => {
      const instruction = editImageInstruction.trim();
      if (!instruction || isLoading) return;
      setEditingImageId(null);
      setEditImageInstruction("");
      void editInlineImage(imageId, instruction);
    },
    [editImageInstruction, isLoading, editInlineImage],
  );

  // Persist a memory candidate, then mark its message saved so the inline chip
  // collapses and the transcript records the saved state. Shared by the manual
  // save chip and the opt-in auto-save effect below.
  const autoSaveInFlight = useRef<Set<string>>(new Set());
  const handleSaveMemory = useCallback(
    async (fact: string, content: string) => {
      await saveOraMemory(fact);
      markMemorySaved(fact, content);
      void queryClient.invalidateQueries({
        queryKey: getListKnowledgeQueryKey({ scope: "user", archived: false, limit: 100 }),
      });
    },
    [markMemorySaved, queryClient],
  );

  // Opt-in auto-save: when the user explicitly asked Ora to remember something
  // (high-confidence candidate) AND both the auto-save and reference-memories
  // preferences are on, save it without an extra click. Low-confidence
  // candidates always require a manual click.
  useEffect(() => {
    if (!isSignedIn) return;
    if (!getAutoSaveMemories() || !getReferenceSavedMemories()) return;
    messages.forEach((msg) => {
      const candidate = msg.memorySaveCandidate;
      if (
        msg.role === "assistant" &&
        candidate &&
        msg.memorySaveCandidateConfidence === "high" &&
        !msg.memorySaved
      ) {
        // Key the in-flight guard by content identity, not array index, so a
        // transcript edit/truncation mid-save can't collide with a stale index.
        const key = `${msg.content}\u0000${candidate}`;
        if (autoSaveInFlight.current.has(key)) return;
        autoSaveInFlight.current.add(key);
        handleSaveMemory(candidate, msg.content)
          .then(() => {
            toast({ title: "Saved to memory" });
          })
          .catch(() => {
            // Leave the candidate in place so the user can retry via the chip.
          })
          .finally(() => {
            autoSaveInFlight.current.delete(key);
          });
      }
    });
  }, [messages, isSignedIn, handleSaveMemory, toast]);

  const [input, setInput] = useState("");
  const [memoryManagerOpen, setMemoryManagerOpen] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState<FileFormat | null>(null);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null);
  const [editingFromIdx, setEditingFromIdx] = useState<number | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [, setLocation] = useLocation();
  const feedRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const prevMsgCountRef = useRef(0);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const headerMenuRef = useRef<HTMLDivElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasMessages = messages.length > 0;

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
  const handleWhisperTranscript = useCallback((text: string) => {
    if (voiceConvActiveRef.current) {
      void sendMessageRef.current(text);
    }
  }, []);

  const whisperConv = useWhisperRecorder(handleWhisperTranscript, () => languageRef.current);
  const whisperState = whisperConv.state;
  const whisperSupported = whisperConv.isSupported;
  const startWhisperRecording = whisperConv.startRecording;
  const cancelWhisperRecording = whisperConv.cancelRecording;

  // Auto-clear the transcript-ready hint after 5 s (dictation mode only)
  useEffect(() => {
    if (!voiceReady) return;
    const t = setTimeout(() => setVoiceReady(false), 5000);
    return () => clearTimeout(t);
  }, [voiceReady]);

  const voiceErrorMsg =
    voice.voiceState === "permission_denied"
      ? "Microphone access was denied. Enable it in your browser settings to use voice input."
      : voice.voiceState === "error"
        ? "Voice recognition failed. Please try again or type your message."
        : null;

  // ─── Voice Conversation Mode effects ──────────────────────────────────────

  // Auto-TTS: speak each new Ora reply when voice conv mode is active.
  // Uses speakTextForce so it works regardless of the user's TTS toggle preference —
  // Voice Conversation Mode has its own mute control (voiceConvTtsMuted).
  useEffect(() => {
    if (!voiceConvActive || voiceConvTtsMuted || isLoading) return;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;
    if (lastMsg.content === lastConvAssistantMsgRef.current) return;
    lastConvAssistantMsgRef.current = lastMsg.content;
    voiceRef.current.speakTextForce(lastMsg.content, languageRef.current);
  }, [messages, isLoading, voiceConvActive, voiceConvTtsMuted]);

  // Conversation cycling: track when Ora finishes speaking so the automatic
  // listener can resume.
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

  useEffect(() => {
    if (!voiceConvActive) {
      cancelWhisperRecording();
      return;
    }
    if (!whisperSupported) return;
    if (isLoading || voice.voiceState === "speaking") return;
    if (whisperState !== "idle") return;

    const t = window.setTimeout(() => {
      void startWhisperRecording({ autoStop: true });
    }, 250);
    return () => window.clearTimeout(t);
  }, [
    cancelWhisperRecording,
    isLoading,
    startWhisperRecording,
    voice.voiceState,
    voiceConvActive,
    whisperState,
    whisperSupported,
  ]);

  // ─── Derived state ────────────────────────────────────────────────────────

  // Uploads are unlimited for signed-in users — only anonymous visitors hit the
  // per-session upload caps. Daily image-generation quota is enforced server-side
  // (429 + upgrade prompt), not by disabling the upload affordance.
  const atFileLimit = !isSignedIn && (session?.fileCount ?? 0) >= (session?.fileLimit ?? 3);
  const atImageLimit = !isSignedIn && (session?.imageCount ?? 0) >= (session?.imageLimit ?? 2);
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
  }, [messages, isLoading]);

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
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 96)}px`;
    }
  }, [input]);

  useEffect(() => {
    if (!showPlusMenu) return;
    function handleClickOutside(e: MouseEvent) {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setShowPlusMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showPlusMenu]);

  useEffect(() => {
    if (!showHeaderMenu) return;
    function handleClickOutside(e: MouseEvent) {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) {
        setShowHeaderMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showHeaderMenu]);

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
    setTimeout(() => textareaRef.current?.focus(), 0);
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

  const handleChip = (chip: string) => {
    if (isLoading || atLimit) return;
    void sendMessage(chip);
  };

  const handleEditMessage = useCallback((text: string, fromIndex?: number) => {
    if (fromIndex !== undefined) setEditingFromIdx(fromIndex);
    setInput(text);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(text.length, text.length);
    }, 40);
  }, []);

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
    void voiceRef.current.prepareVoicePlayback();
    voiceRef.current.stopListening();
    voiceRef.current.stopSpeaking();
    setInput("");
    setVoiceReady(false);
    wasConvSpeakingRef.current = false;
    lastConvAssistantMsgRef.current = null;
    setVoiceConvActive(true);
    voiceConvActiveRef.current = true;
    // Whisper push-to-talk: don't auto-start listening — user holds the button.
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

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className={cn(
        "relative flex flex-col",
        isFull
          ? "h-full min-h-0 bg-background"
          : "rounded-2xl border border-border/60 bg-card shadow-lg max-h-[70dvh] transition-all duration-500",
      )}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag-and-drop overlay */}
      {isDragOver && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-[hsl(265_85%_65%/0.7)] bg-card/90 backdrop-blur-sm pointer-events-none"
          aria-hidden
        >
          <div className="flex flex-col items-center gap-2 text-[hsl(265_85%_65%)]">
            <Upload className="h-8 w-8" />
            <span className="text-sm font-medium">Drop image or file to upload</span>
            <span className="text-xs text-muted-foreground">
              PNG, JPG, WEBP · PDF, DOCX, TXT · CSV, XLSX
            </span>
          </div>
        </div>
      )}
      {/* Header */}
      <div
        className={cn(
          "flex items-center justify-between px-4 py-3 border-b border-border/50",
          isFull && "sticky top-0 z-20 bg-background/85 backdrop-blur pl-14 pr-14",
        )}
      >
        <div className="flex items-center gap-2.5">
          <DynamicAtom state={atomState} size={28} />
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight">Ora</span>
            {!isSignedIn && (
              <span className="text-[10px] text-muted-foreground/70 font-medium border border-border/50 rounded-full px-1.5 py-0.5">
                Free · No sign-in required
              </span>
            )}
          </div>
          {oraStatus !== "idle" && (
            <span className="text-[11px] text-muted-foreground animate-pulse">
              {STATUS_LABELS[oraStatus]}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {/* Voice Conversation Mode — Talk with Ora (premium orb in header) */}
          {(voice.isSupported || whisperConv.isSupported) && (
            <OraVoiceModeButton
              voiceState={
                voiceConvActive && !(voice.voiceState === "unsupported" && whisperConv.isSupported)
                  ? voice.voiceState
                  : "idle"
              }
              isSupported={voice.isSupported || whisperConv.isSupported}
              active={voiceConvActive}
              onStart={handleEnterVoiceConvMode}
              onStop={handleExitVoiceConvMode}
              disabled={!voiceConvActive && isLoading}
              size="md"
            />
          )}

          {/* Export conversation (contextual — only with messages) */}
          {hasMessages && (
            <OraExportMenu
              source={{ kind: "conversation", messages }}
              disabled={isLoading}
              variant="header"
            />
          )}

          {/* Overflow menu — consolidates language, voice responses, memory, and
              clear so the header stays calm (ChatGPT/Codex style). */}
          <div className="relative" ref={headerMenuRef}>
            <button
              type="button"
              onClick={() => setShowHeaderMenu((v) => !v)}
              title="More options"
              aria-label="More options"
              aria-haspopup="menu"
              aria-expanded={showHeaderMenu}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
                showHeaderMenu
                  ? "text-foreground bg-muted/50"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {showHeaderMenu && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-1.5 z-50 min-w-[200px] bg-popover border border-border rounded-xl shadow-xl py-1"
              >
                {/* Language */}
                <p className="px-3 pt-1.5 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Language
                </p>
                {LANGUAGES.map((l) => (
                  <button
                    key={l.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={language === l.value}
                    onClick={() => {
                      setLanguage(l.value);
                      setShowHeaderMenu(false);
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors flex items-center gap-2"
                  >
                    <Globe
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        language === l.value
                          ? "text-[hsl(265_85%_65%)]"
                          : "text-muted-foreground/60",
                      )}
                    />
                    <span
                      className={cn(
                        "flex-1",
                        language === l.value && "text-[hsl(265_85%_65%)] font-medium",
                      )}
                    >
                      {l.label}
                    </span>
                  </button>
                ))}

                {(voice.isSpeechSynthesisSupported || isSignedIn || hasMessages) && (
                  <div className="my-1 h-px bg-border/60" />
                )}

                {/* Voice responses (TTS) */}
                {voice.isSpeechSynthesisSupported && (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={voice.isTtsEnabled}
                    onClick={() => {
                      voice.toggleTts();
                      setShowHeaderMenu(false);
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors flex items-center gap-2"
                  >
                    {voice.isTtsEnabled ? (
                      <Volume2 className="h-3.5 w-3.5 shrink-0 text-[hsl(265_85%_65%)]" />
                    ) : (
                      <VolumeX className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                    )}
                    <span className="flex-1">
                      {voice.isTtsEnabled ? "Voice responses on" : "Voice responses off"}
                    </span>
                  </button>
                )}

                {/* Memory manager */}
                {isSignedIn && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMemoryManagerOpen(true);
                      setShowHeaderMenu(false);
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors flex items-center gap-2"
                  >
                    <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                    <span className="flex-1">Ora memory</span>
                  </button>
                )}

                {/* Clear conversation */}
                {hasMessages && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={isLoading}
                    onClick={() => {
                      void clearConversation();
                      setShowHeaderMenu(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 text-destructive hover:bg-destructive/10",
                      isLoading && "opacity-40 cursor-not-allowed",
                    )}
                  >
                    <Trash2 className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1">Clear conversation</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Empty state — shown before first message */}
      {!hasMessages &&
        (isFull ? (
          /* Full layout: centered greeting that fills the available space */
          <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center px-4 py-8">
            <div className="w-full max-w-3xl mx-auto text-center">
              <div className="flex justify-center mb-5">
                <DynamicAtom state={atomState} size={52} />
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
                Hi, I&apos;m <span className="text-[hsl(265_85%_65%)]">Ora</span>
              </h1>
              <p className="text-sm text-muted-foreground mt-2.5 max-w-md mx-auto leading-relaxed">
                Ask anything, think things through, or get work done — planning, strategy, files,
                images, and more, all in one chat.
              </p>
              <div className="mt-7 flex flex-wrap justify-center gap-2">
                {EXAMPLE_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => handleChip(chip)}
                    className="text-xs px-3.5 py-2 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-[hsl(265_85%_65%/0.5)] hover:bg-[hsl(265_85%_65%/0.07)] transition-all"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
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
        ))}

      {/* Message feed — `flex-1 min-h-0 overflow-y-auto` directly on the scroll
           element so the flex algorithm assigns it a real height before overflow
           kicks in. Jump-to-latest uses `sticky` so it anchors to the bottom of
           the *visible* scroll area rather than the bottom of all content. */}
      <div
        className={cn(
          "relative flex-1 min-h-0 overflow-y-auto scroll-smooth",
          !hasMessages && "hidden",
        )}
        ref={feedRef}
        onScroll={handleFeedScroll}
      >
        <div
          className={cn(
            "px-4 py-4",
            isFull ? "max-w-3xl mx-auto w-full space-y-6 pt-6 pb-8" : "space-y-5",
          )}
        >
          {messages.map((msg, i) => {
            const isLastMessage = i === messages.length - 1;
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
                  msg.role === "user" ? "justify-end" : "justify-start gap-2.5",
                )}
              >
                {msg.role === "assistant" && (
                  <DynamicAtom state="idle" size={24} className="shrink-0 mt-0.5" />
                )}
                <div
                  className={cn(
                    msg.role === "user" ? "max-w-[85%]" : isFull ? "flex-1 min-w-0" : "max-w-[85%]",
                  )}
                >
                  {msg.role === "user" ? (
                    <div
                      dir="auto"
                      className={cn(
                        "bg-muted/60 rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-foreground whitespace-pre-wrap break-words leading-relaxed",
                        isFull ? "text-[15px]" : "text-sm",
                      )}
                    >
                      {msg.content}
                    </div>
                  ) : msg.datasetResult ? (
                    <DatasetResultCard result={msg.datasetResult} />
                  ) : (
                    <div
                      dir="auto"
                      className={cn(
                        "leading-relaxed whitespace-pre-wrap break-words",
                        isFull ? "text-[15px] text-foreground/90" : "text-sm text-foreground/85",
                      )}
                    >
                      {msg.content}
                    </div>
                  )}

                  {msg.imageUrl && (
                    <div className="mt-2 w-full max-w-sm">
                      <img
                        src={msg.imageUrl}
                        alt="Generated by Ora"
                        className="w-full rounded-xl border border-border/60"
                        loading="lazy"
                      />
                      {msg.editInstruction && (
                        <p className="mt-1 flex items-start gap-1 text-[11px] text-muted-foreground break-words">
                          <GitBranch className="h-3 w-3 shrink-0 mt-px" />
                          <span>
                            Edited from original
                            <span className="italic"> — &ldquo;{msg.editInstruction}&rdquo;</span>
                          </span>
                        </p>
                      )}
                      {msg.imageId != null && isSignedIn && (
                        <div className="mt-2">
                          {editingImageId === msg.imageId ? (
                            <div className="flex flex-col gap-2">
                              <input
                                type="text"
                                dir="auto"
                                autoFocus
                                value={editImageInstruction}
                                onChange={(e) => setEditImageInstruction(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    submitImageEdit(msg.imageId!);
                                  } else if (e.key === "Escape") {
                                    setEditingImageId(null);
                                    setEditImageInstruction("");
                                  }
                                }}
                                placeholder="Describe the change, e.g. make the sky purple"
                                disabled={isLoading}
                                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(265_85%_65%)] disabled:opacity-60"
                              />
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => submitImageEdit(msg.imageId!)}
                                  disabled={isLoading || !editImageInstruction.trim()}
                                  className="inline-flex items-center gap-1.5 rounded-lg bg-[hsl(265_85%_65%)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[hsl(265_85%_60%)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                  {isLoading ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Wand2 className="h-3.5 w-3.5" />
                                  )}
                                  Apply edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingImageId(null);
                                    setEditImageInstruction("");
                                  }}
                                  disabled={isLoading}
                                  className="rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingImageId(msg.imageId!);
                                setEditImageInstruction("");
                              }}
                              disabled={isLoading}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs font-medium text-foreground/80 hover:bg-muted/60 hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              <Wand2 className="h-3.5 w-3.5" />
                              Edit
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {msg.generatedFile &&
                    (msg.generatedFile.fileData ? (
                      <button
                        type="button"
                        onClick={() => downloadOraFile(msg.generatedFile!)}
                        className="mt-2 w-full text-left group flex items-center gap-3 rounded-xl border border-[hsl(265_85%_65%/0.35)] bg-[hsl(265_85%_65%/0.06)] hover:bg-[hsl(265_85%_65%/0.12)] hover:border-[hsl(265_85%_65%/0.55)] px-3.5 py-3 transition-all cursor-pointer"
                      >
                        <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-lg bg-[hsl(265_85%_65%/0.15)]">
                          <FileSpreadsheet className="h-4.5 w-4.5 text-[hsl(265_85%_65%)]" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold truncate text-foreground">
                            {msg.generatedFile.fileName}
                          </p>
                          <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                            {msg.generatedFile.format.toUpperCase()} · Click to download
                          </p>
                        </div>
                        <Download className="h-4 w-4 text-[hsl(265_85%_65%)] shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" />
                      </button>
                    ) : (
                      // Reloaded message: the base64 bytes are not stored, so the
                      // file is no longer downloadable. Render a non-interactive
                      // card instead of a dead download button.
                      <div className="mt-2 w-full flex items-center gap-3 rounded-xl border border-border/60 bg-muted/20 px-3.5 py-3">
                        <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-lg bg-muted/40">
                          <FileSpreadsheet className="h-4.5 w-4.5 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold truncate text-muted-foreground">
                            {msg.generatedFile.fileName}
                          </p>
                          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                            {msg.generatedFile.format.toUpperCase()} · Regenerate to download
                          </p>
                        </div>
                      </div>
                    ))}

                  {msg.role === "assistant" &&
                    Array.isArray(msg.sources) &&
                    msg.sources.length > 0 && <OraSourceCards sources={msg.sources} />}

                  {msg.role === "assistant" &&
                    isSignedIn &&
                    (msg.memorySaveCandidate || msg.memorySaved) && (
                      <OraMemorySaveChip
                        fact={msg.memorySaveCandidate ?? ""}
                        saved={Boolean(msg.memorySaved)}
                        sensitive={Boolean(msg.memorySaveCandidateSensitive)}
                        onSave={() => handleSaveMemory(msg.memorySaveCandidate ?? "", msg.content)}
                      />
                    )}

                  {msg.editedFrom && (
                    <p className="text-[10px] text-muted-foreground/50 mt-0.5 text-right pr-1">
                      Edited from earlier message
                    </p>
                  )}

                  <OraMessageActions
                    message={msg}
                    isLatestAssistant={isLatestAssistant}
                    onEdit={msg.role === "user" ? (text) => handleEditMessage(text, i) : undefined}
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
                    onReadAloud={
                      msg.role === "assistant" && voice.isSpeechSynthesisSupported
                        ? (text) => voice.speakText(text, language)
                        : undefined
                    }
                    isTtsAvailable={voice.isSpeechSynthesisSupported && voice.isTtsEnabled}
                    hasAttachment={msg.hadAttachment ?? false}
                  />

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

      {/* Footer — banners + composer. In full mode this is a full-width bar with a
          centered max-w-3xl column so the composer aligns with the message thread. */}
      <div className={cn("shrink-0", isFull && "border-t border-border/40 bg-background")}>
        <div className={cn(isFull && "mx-auto w-full max-w-3xl")}>
          {/* Error */}
          {error && (
            <div className="mx-4 mb-3 mt-3 rounded-xl border border-destructive/25 bg-destructive/8 px-3.5 py-2.5 text-xs text-destructive flex items-start justify-between gap-2">
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

          {/* Session-expired nudge — only shown to guests whose anonymous session timed out */}
          {sessionExpired && !isSignedIn && (
            <div className="mx-4 mb-3 rounded-xl border border-amber-500/30 bg-amber-500/8 px-3.5 py-2.5 text-xs flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0">
                <LogIn className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                <span className="text-amber-800 dark:text-amber-300 leading-snug">
                  Your session expired — your conversation is still visible, but will be lost when
                  you leave.{" "}
                  <button
                    type="button"
                    onClick={() => setLocation("/sign-up")}
                    className="font-medium underline underline-offset-2 hover:no-underline"
                  >
                    Sign in to save it permanently.
                  </button>
                </span>
              </div>
              <button
                type="button"
                onClick={dismissSessionExpired}
                className="shrink-0 opacity-60 hover:opacity-100 transition-opacity mt-0.5"
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5 text-amber-700 dark:text-amber-400" />
              </button>
            </div>
          )}

          {/* Editing indicator */}
          {editingFromIdx !== null && (
            <div className="mx-4 mb-1 flex items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
              <span>Editing earlier message — reply will be added to conversation</span>
              <button
                type="button"
                onClick={() => {
                  setEditingFromIdx(null);
                  setInput("");
                  setTimeout(() => textareaRef.current?.focus(), 0);
                }}
                className="shrink-0 opacity-60 hover:opacity-100"
                aria-label="Cancel edit"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Composer — pb uses safe-area-inset-bottom so iPhone home bar never clips input */}
          <div
            className={cn("px-4 pt-3 shrink-0", isFull ? "pt-2" : "border-t border-border/40")}
            style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 12px)" }}
          >
            {atLimit ? (
              <div className="text-center py-2">
                <p className="text-xs text-muted-foreground">
                  {isSignedIn ? (
                    <>
                      You&apos;ve used your message allowance for this window.{" "}
                      <button
                        type="button"
                        onClick={() => setLocation("/pricing")}
                        className="text-[hsl(265_85%_65%)] hover:underline"
                      >
                        Upgrade for a higher limit
                      </button>
                    </>
                  ) : (
                    <>
                      Session limit reached.{" "}
                      <button
                        type="button"
                        onClick={() => setLocation("/sign-up")}
                        className="text-[hsl(265_85%_65%)] hover:underline"
                      >
                        Sign up for unlimited conversations
                      </button>
                    </>
                  )}
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
                  /* ─── Voice Conversation Mode panel ─────────────────────────── */
                  <OraVoiceConvPanel
                    voiceState={
                      voice.voiceState === "unsupported" && whisperConv.isSupported
                        ? "idle"
                        : voice.voiceState
                    }
                    interimTranscript={voice.interimTranscript}
                    isLoading={isLoading}
                    isTtsMuted={voiceConvTtsMuted}
                    onToggleTtsMute={() => setVoiceConvTtsMuted((v) => !v)}
                    onExit={handleExitVoiceConvMode}
                    onInterrupt={() => voiceRef.current.stopSpeaking()}
                    size="md"
                    whisperState={whisperConv.state}
                    whisperSupported={whisperConv.isSupported}
                    whisperError={whisperConv.error}
                    onWhisperStart={whisperConv.startRecording}
                    onWhisperStop={whisperConv.stopRecording}
                    onWhisperCancel={whisperConv.cancelRecording}
                  />
                ) : (
                  /* ─── Normal dictation + text input ─────────────────────────── */
                  <>
                    {/* Voice live area — dictation feedback only */}
                    <OraVoiceLiveArea
                      voiceState={voice.voiceState}
                      interimTranscript={voice.interimTranscript}
                      voiceReady={voiceReady}
                      voiceErrorMsg={voiceErrorMsg}
                      size="md"
                    />

                    {/* Selected format chip */}
                    {selectedFormat && (
                      <div className="flex items-center gap-2 rounded-xl border border-[hsl(265_85%_65%/0.35)] bg-[hsl(265_85%_65%/0.07)] px-3 py-2 text-xs mb-2">
                        <FileSpreadsheet className="h-3.5 w-3.5 text-[hsl(265_85%_65%)] shrink-0" />
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
                          <X className="h-3.5 w-3.5" />
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
                      {/* Instant vs Deep Thinking toggle */}
                      <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/40 p-0.5">
                        <button
                          type="button"
                          onClick={() => setMode("instant")}
                          title="Instant — fast everyday replies"
                          aria-pressed={mode === "instant"}
                          className={cn(
                            "flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors",
                            mode === "instant"
                              ? "bg-background text-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Zap className="h-3 w-3" />
                          Instant
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (deepAllowed) {
                              setMode("deep");
                            } else {
                              setLocation("/ora/settings");
                            }
                          }}
                          title={
                            deepAllowed
                              ? "Deep Thinking — slower, step-by-step reasoning"
                              : "Deep Thinking is available with an Ora Core Pack or Deep Wave plan"
                          }
                          aria-pressed={mode === "deep" && deepAllowed}
                          className={cn(
                            "flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors",
                            mode === "deep" && deepAllowed
                              ? "bg-background text-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground",
                            !deepAllowed && "opacity-70",
                          )}
                        >
                          {deepAllowed ? (
                            <Brain className="h-3 w-3" />
                          ) : (
                            <Lock className="h-3 w-3" />
                          )}
                          Deep
                        </button>
                      </div>

                      {/* Overflow "+" menu — collapses upload + generate-file into one
                          control to keep the composer clean (ChatGPT/Codex style). */}
                      <div className="relative shrink-0" ref={plusMenuRef}>
                        <button
                          type="button"
                          onClick={() => setShowPlusMenu((v) => !v)}
                          disabled={isLoading}
                          title="Add attachment or generate a file"
                          aria-label="Add attachment or generate a file"
                          aria-haspopup="menu"
                          aria-expanded={showPlusMenu}
                          className={cn(
                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
                            uploadState === "attached" || selectedFormat
                              ? "text-[hsl(265_85%_65%)] bg-[hsl(265_85%_65%/0.12)]"
                              : "text-muted-foreground hover:text-foreground",
                            isLoading && "opacity-40 cursor-not-allowed",
                          )}
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                        {showPlusMenu && (
                          <div
                            role="menu"
                            className="absolute bottom-full mb-1.5 left-0 z-50 bg-popover border border-border rounded-xl shadow-xl py-1 min-w-[200px]"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              disabled={isLoading || uploadState === "uploading" || atAllLimits}
                              onClick={() => {
                                setShowPlusMenu(false);
                                fileInputRef.current?.click();
                              }}
                              className={cn(
                                "w-full text-left px-3 py-2 text-xs hover:bg-muted/50 transition-colors flex items-center gap-2",
                                (isLoading || uploadState === "uploading" || atAllLimits) &&
                                  "opacity-40 cursor-not-allowed",
                              )}
                            >
                              <Paperclip className="h-3.5 w-3.5 shrink-0" />
                              <span className="flex-1">
                                {atAllLimits ? "Upload limit reached" : "Upload image or file"}
                              </span>
                            </button>
                            <div className="my-1 h-px bg-border/60" />
                            <p className="px-3 pt-1 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                              Generate file
                            </p>
                            {FILE_FORMAT_OPTIONS.map((opt) => (
                              <button
                                key={opt.value}
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setSelectedFormat(opt.value);
                                  setShowPlusMenu(false);
                                  textareaRef.current?.focus();
                                }}
                                className={cn(
                                  "w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors flex items-center justify-between gap-2",
                                  selectedFormat === opt.value &&
                                    "text-[hsl(265_85%_65%)] font-medium",
                                )}
                              >
                                <span className="flex items-center gap-2">
                                  <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" />
                                  {opt.label}
                                </span>
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
                        size="md"
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
                        className="flex-1 resize-none bg-transparent py-1.5 text-sm placeholder:text-muted-foreground/60 focus:outline-none leading-snug"
                        style={{ maxHeight: "96px" }}
                        disabled={isLoading}
                        onPaste={handlePaste}
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

                    {input.length >= 2000 && (
                      <p className="text-[10px] text-amber-500 dark:text-amber-400 mt-1.5">
                        {input.length.toLocaleString()} chars · {input.split("\n").length} lines —
                        very long messages may reduce response quality
                      </p>
                    )}

                    <div className="flex items-center justify-between mt-2">
                      {dropError ? (
                        <p className="text-[10px] text-destructive">{dropError}</p>
                      ) : language === "ar" ? (
                        <p className="text-[10px] text-muted-foreground/50">
                          Arabic voice depends on your browser — review the transcript before
                          sending
                        </p>
                      ) : (
                        <p className="text-[10px] text-muted-foreground/50">
                          Upload or drag images, PDF, DOCX, CSV, XLSX ·{" "}
                          {voice.isSupported || whisperConv.isSupported
                            ? "Voice or type in any language"
                            : "Voice unavailable on this browser — typing still works"}
                        </p>
                      )}
                      {session && !isSignedIn && (
                        <span className="text-[10px] text-muted-foreground/50 shrink-0 ml-2">
                          {session.msgLimit - session.msgCount} messages left
                        </span>
                      )}
                      <OraUsageInline session={session} isSignedIn={isSignedIn} />
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <OraMemoryManager open={memoryManagerOpen} onOpenChange={setMemoryManagerOpen} />
    </div>
  );
}
