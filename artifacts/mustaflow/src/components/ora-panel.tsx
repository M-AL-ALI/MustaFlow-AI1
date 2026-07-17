import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useUser } from "@clerk/react";
import { useLocation } from "wouter";
import {
  Send,
  Globe,
  ChevronDown,
  Paperclip,
  FileText,
  Table2,
  Image as ImageIcon,
  AlertCircle,
  Loader2,
  X,
  Volume2,
  VolumeX,
  Trash2,
  Upload,
  FileSpreadsheet,
  Download,
  ExternalLink,
  LogIn,
  Zap,
  Brain,
  Lock,
  Wand2,
  GitBranch,
  Plus,
  MoreHorizontal,
  Ghost,
  RotateCcw,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { ORA_MEMORIES_QUERY_KEY, MemoryFullError } from "@/lib/ora-memories";
import { useToast } from "@/hooks/use-toast";
import { authFetch } from "@/lib/api-fetch";
import { OraMessageActions } from "@/components/ora/ora-message-actions";
import { OraExportMenu } from "@/components/ora/ora-export-menu";
import { OraUsageInline } from "@/components/ora-usage-inline";
import { OraMemorySaveChip } from "@/components/ora/ora-memory-save-chip";
import { OraMemoriesUsedChip } from "@/components/ora/ora-memories-used-chip";
import { OraDocumentMemoryChip } from "@/components/ora/ora-document-memory-chip";
import { OraMemoryManager } from "@/components/ora/ora-memory-manager";
import { saveOraMemory } from "@/lib/ora-memory-save";
import { useOraConversationsOptional } from "@/hooks/ora-conversations-context";
import {
  getAutoSaveMemories,
  getReferenceSavedMemories,
  getAskBeforeSensitive,
} from "@/lib/ora-memory-settings";
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
import { useOraRealtimeVoice } from "@/hooks/use-ora-realtime-voice";
import {
  OraVoiceModeButton,
  OraVoiceLiveArea,
  OraDictationButton,
  OraVoiceConvPanel,
  mapRealtimeToVoiceState,
} from "@/components/ora/ora-voice-mode-button";
import { DatasetResultCard } from "@/components/dataset-result-card";
import { DynamicAtom, type AtomState } from "@/components/ora/dynamic-atom";
import { OraImageChip } from "@/components/ora/ora-image-chip";
import { OraSourceCards } from "@/components/ora/ora-source-cards";
import { OraImageGallery, OraVideoCards } from "@/components/ora/ora-media-cards";
import { OraRichText } from "@/components/ora/ora-rich-text";
import { OraVoiceTip } from "@/components/ora/ora-voice-tip";

function downloadOraFile(file: GeneratedFile) {
  if (!file.fileData) return;
  const byteChars = atob(file.fileData);
  const byteNums = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
  const blob = new Blob([byteNums], {
    type: file.format === "pdf" ? "application/octet-stream" : file.mimeType,
  });
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

function viewOraFile(file: GeneratedFile) {
  if (!file.fileData) return;
  const byteChars = atob(file.fileData);
  const byteNums = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
  const blob = new Blob([byteNums], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

// Download a durable library asset by id (reloaded messages drop the inline
// bytes but keep the asset id). authFetch attaches the bearer token so the
// owner-scoped /download route authorizes the request.
async function downloadOraAssetById(assetId: number, fileName: string) {
  const res = await authFetch(`/api/ora/assets/${assetId}/download?download=1`);
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 2000);
}

async function viewOraAssetById(assetId: number) {
  const res = await authFetch(`/api/ora/assets/${assetId}/download`);
  if (!res.ok) return;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

function GeneratedFileCard({
  file,
  onRevise,
}: {
  file: GeneratedFile;
  onRevise?: (file: GeneratedFile) => void;
}) {
  const isPdf = file.format === "pdf";

  if (isPdf && (file.fileData || file.assetId != null)) {
    return (
      <div className="mt-2 w-full flex items-center gap-3 rounded-xl border border-[hsl(var(--ora-accent-hsl)/0.35)] bg-[hsl(var(--ora-accent-hsl)/0.06)] px-3.5 py-3">
        <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-lg bg-[hsl(var(--ora-accent-hsl)/0.15)]">
          <FileText className="h-4.5 w-4.5 text-[hsl(var(--ora-accent-hsl))]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold truncate text-foreground">{file.fileName}</p>
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">PDF · View or download</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => (file.fileData ? viewOraFile(file) : viewOraAssetById(file.assetId!))}
            className="inline-flex items-center gap-1 rounded-lg border border-[hsl(var(--ora-accent-hsl)/0.25)] bg-background/70 px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-[hsl(var(--ora-accent-hsl)/0.1)]"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            View
          </button>
          <button
            type="button"
            onClick={() =>
              file.fileData
                ? downloadOraFile(file)
                : downloadOraAssetById(file.assetId!, file.fileName)
            }
            className="inline-flex items-center gap-1 rounded-lg bg-[hsl(var(--ora-accent-hsl))] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
          {onRevise && (
            <button
              type="button"
              onClick={() => onRevise(file)}
              className="inline-flex items-center gap-1 rounded-lg border border-[hsl(var(--ora-accent-hsl)/0.25)] bg-background/70 px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-[hsl(var(--ora-accent-hsl)/0.1)]"
            >
              <Wand2 className="h-3.5 w-3.5" />
              Revise
            </button>
          )}
        </div>
      </div>
    );
  }

  if (file.fileData || file.assetId != null) {
    return (
      <div className="mt-2 w-full flex items-center gap-3 rounded-xl border border-[hsl(var(--ora-accent-hsl)/0.35)] bg-[hsl(var(--ora-accent-hsl)/0.06)] px-3.5 py-3">
        <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-lg bg-[hsl(var(--ora-accent-hsl)/0.15)]">
          <FileSpreadsheet className="h-4.5 w-4.5 text-[hsl(var(--ora-accent-hsl))]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold truncate text-foreground">{file.fileName}</p>
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">
            {file.format.toUpperCase()} · Click to download
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() =>
              file.fileData
                ? downloadOraFile(file)
                : downloadOraAssetById(file.assetId!, file.fileName)
            }
            className="inline-flex items-center gap-1 rounded-lg bg-[hsl(var(--ora-accent-hsl))] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
          {onRevise && (
            <button
              type="button"
              onClick={() => onRevise(file)}
              className="inline-flex items-center gap-1 rounded-lg border border-[hsl(var(--ora-accent-hsl)/0.25)] bg-background/70 px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-[hsl(var(--ora-accent-hsl)/0.1)]"
            >
              <Wand2 className="h-3.5 w-3.5" />
              Revise
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 w-full flex items-center gap-3 rounded-xl border border-border/60 bg-muted/20 px-3.5 py-3">
      <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-lg bg-muted/40">
        <FileSpreadsheet className="h-4.5 w-4.5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold truncate text-muted-foreground">{file.fileName}</p>
        <p className="text-[10px] text-muted-foreground/60 mt-0.5">
          {file.format.toUpperCase()} · Regenerate to download
        </p>
      </div>
      {onRevise && (
        <button
          type="button"
          onClick={() => onRevise(file)}
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/70 px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted/60"
        >
          <Wand2 className="h-3.5 w-3.5" />
          Revise
        </button>
      )}
    </div>
  );
}

function formatOraImageMeta(meta?: {
  kind: string;
  aspectRatio: string;
  style: string;
  quality: string;
}): string[] {
  if (!meta) return [];
  const quality =
    meta.quality === "high" ? "High quality" : meta.quality === "draft" ? "Draft" : "Standard";
  const style = meta.style ? `${meta.style} style` : "";
  const kind = meta.kind ? meta.kind.replace(/_/g, " ") : "";
  return [quality, meta.aspectRatio, style, kind].filter(Boolean);
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

// Plan accent expressed as raw HSL channels (no `hsl(...)` wrapper) so it can be
// dropped into a CSS custom property and reused with arbitrary opacity, e.g.
// `hsl(var(--ora-accent-hsl) / 0.5)`.
function oraAccentHsl(tier: string): string {
  if (tier === "core") return "217 90% 60%";
  if (tier === "wave") return "35 85% 60%";
  return "265 85% 65%";
}

function oraAccentColor(tier: string): string {
  return `hsl(${oraAccentHsl(tier)})`;
}

function oraTierLabel(tier: string): string {
  if (tier === "core") return "Core Pack";
  if (tier === "wave") return "Deep Wave";
  return "Free";
}

function OraTierBadge({ tier }: { tier: string }) {
  const color = oraAccentColor(tier);
  return (
    <span
      className="inline-flex items-center text-[10px] font-medium rounded-full px-1.5 py-0.5"
      style={{
        color,
        border: `1px solid ${color.replace(")", " / 0.4)")}`,
        backgroundColor: color.replace(")", " / 0.08)"),
      }}
    >
      {oraTierLabel(tier)}
    </span>
  );
}

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
          "border-[hsl(var(--ora-accent-hsl)/0.35)] bg-[hsl(var(--ora-accent-hsl)/0.07)] text-foreground",
        uploadState === "uploading" && "border-border bg-muted/30 text-muted-foreground",
        uploadState === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      <div className="shrink-0 mt-0.5">
        {uploadState === "uploading" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {uploadState === "attached" &&
          (isDataset ? (
            <Table2 className="h-3.5 w-3.5 text-[hsl(var(--ora-accent-hsl))]" />
          ) : (
            <FileText className="h-3.5 w-3.5 text-[hsl(var(--ora-accent-hsl))]" />
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
              <span className="inline-flex items-center rounded-full bg-[hsl(var(--ora-accent-hsl)/0.12)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--ora-accent-hsl))]">
                {file.rowCount.toLocaleString()} rows
              </span>
            )}
            {file.colCount != null && (
              <span className="inline-flex items-center rounded-full bg-[hsl(var(--ora-accent-hsl)/0.12)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--ora-accent-hsl))]">
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
    retryLastMessage,
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
    markDocumentMemorySaved,
    temporary,
    setTemporary,
    appendVoiceMessage,
    getRealtimeContext,
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
  // Anchor saved memories to the current Ora project when the chat is inside one,
  // so they persist across that project's conversations; otherwise save at the
  // user level. Prefer the conversation's own project over the active route.
  const oraConv = useOraConversationsOptional();
  const saveOraProjectId =
    oraConv?.conversations.find((c) => c.id === oraConv.currentConversationId)?.projectId ??
    oraConv?.activeProjectId ??
    null;
  const handleSaveMemory = useCallback(
    async (fact: string, content: string) => {
      try {
        const supersededTitles = await saveOraMemory(fact, saveOraProjectId);
        markMemorySaved(fact, content, supersededTitles);
        void queryClient.invalidateQueries({ queryKey: ORA_MEMORIES_QUERY_KEY });
      } catch (err) {
        // Surface the capacity limit with a clear, actionable message; the
        // candidate stays in place so the user can manage memories and retry.
        if (err instanceof MemoryFullError) {
          toast({
            title: "Memory full",
            description: err.message,
            variant: "destructive",
          });
        }
        throw err;
      }
    },
    [markMemorySaved, queryClient, saveOraProjectId, toast],
  );

  // Save-by-default auto-save: when the auto-save and reference-memories
  // preferences are on, save ANY durable memory candidate Ora detects (any
  // confidence) without an extra click. Sensitive candidates are still gated by
  // the ask-before-sensitive safeguard — those keep the inline chip so the user
  // saves them deliberately. Temporary ("incognito") chats never auto-save.
  useEffect(() => {
    if (!isSignedIn) return;
    if (temporary) return;
    if (!getAutoSaveMemories() || !getReferenceSavedMemories()) return;
    const askBeforeSensitive = getAskBeforeSensitive();
    messages.forEach((msg) => {
      const candidate = msg.memorySaveCandidate;
      const sensitiveGated = msg.memorySaveCandidateSensitive === true && askBeforeSensitive;
      if (msg.role === "assistant" && candidate && !sensitiveGated && !msg.memorySaved) {
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
  }, [messages, isSignedIn, handleSaveMemory, toast, temporary]);

  const [input, setInput] = useState("");
  const [memoryManagerOpen, setMemoryManagerOpen] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState<FileFormat | null>(null);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
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
  const modeMenuRef = useRef<HTMLDivElement>(null);
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
  // Which voice transport is driving Voice Conversation Mode: "realtime" is the
  // GA OpenAI Realtime API over WebRTC (primary); "fallback" is the legacy
  // whisper -> chat -> TTS loop, used only when realtime cannot start.
  const [voiceTransport, setVoiceTransport] = useState<"realtime" | "fallback">("realtime");
  const [fallbackNoticeDismissed, setFallbackNoticeDismissed] = useState(false);

  // Stable refs — always current, so effects and callbacks never go stale
  const voiceConvActiveRef = useRef(false);
  const voiceTransportRef = useRef<"realtime" | "fallback">("realtime");
  const wasConvSpeakingRef = useRef(false);
  const lastSpokenAssistantMsgRef = useRef<string | null>(null);
  // Whether the auto-speak effect has armed for the currently loaded transcript.
  // Reset whenever messages clear (new chat / conversation switch) so a freshly
  // loaded history or a restored "Voice responses on" preference seeds the dedup
  // ref to the existing last reply instead of replaying it.
  const autoSpeakArmedRef = useRef(false);
  const languageRef = useRef(language);
  const sendMessageRef = useRef(sendMessage);
  const appendVoiceMessageRef = useRef(appendVoiceMessage);
  const getRealtimeContextRef = useRef(getRealtimeContext);

  voiceConvActiveRef.current = voiceConvActive;
  voiceTransportRef.current = voiceTransport;
  languageRef.current = language;
  sendMessageRef.current = sendMessage;
  appendVoiceMessageRef.current = appendVoiceMessage;
  getRealtimeContextRef.current = getRealtimeContext;

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

  // ─── Realtime "Talk to Ora" (GA OpenAI Realtime over WebRTC) ───────────────
  // The model speaks its own audio and reports both sides' transcripts over the
  // data channel. We mirror each finalized turn into the existing conversation
  // history WITHOUT a /chat round-trip (the spend cap was already metered at
  // mint time). This never calls sendMessage, so it cannot double-respond.
  const handleRealtimeUserTranscript = useCallback((text: string) => {
    appendVoiceMessageRef.current("user", text);
  }, []);
  const handleRealtimeAssistantTranscript = useCallback((text: string) => {
    appendVoiceMessageRef.current("assistant", text);
  }, []);
  // Late realtime failure (the connection dropped after start() already
  // succeeded). The start()-false branch in handleEnterVoiceConvMode only covers
  // failures BEFORE the session is established, so without this the user would be
  // stuck in the realtime view with a banner but no working transport. Flip to
  // the legacy whisper -> chat -> tts loop, which the automatic listener effect
  // starts once voiceTransport becomes "fallback".
  const handleRealtimeFallback = useCallback(() => {
    if (!voiceConvActiveRef.current) return;
    if (voiceTransportRef.current !== "realtime") return;
    setVoiceTransport("fallback");
    voiceTransportRef.current = "fallback";
    void voiceRef.current.prepareVoicePlayback();
  }, []);

  const realtime = useOraRealtimeVoice({
    onUserTranscript: handleRealtimeUserTranscript,
    onAssistantTranscript: handleRealtimeAssistantTranscript,
    onFallback: handleRealtimeFallback,
  });
  const realtimeRef = useRef(realtime);
  realtimeRef.current = realtime;

  const realtimeActive = voiceConvActive && voiceTransport === "realtime";
  // Connection-quality dot for the live-voice button. Only meaningful while a
  // realtime call is active (or reconnecting); mirrors the mobile status dot.
  const networkQuality = realtime.networkQuality;
  const showQualityDot = realtimeActive || (voiceConvActive && networkQuality === "reconnecting");
  const qualityDot =
    networkQuality === "good"
      ? { color: "#3fb950", label: "Live voice connection is stable", pulse: false }
      : networkQuality === "degraded"
        ? { color: "#f0a742", label: "Live voice connection is unstable", pulse: true }
        : networkQuality === "reconnecting"
          ? { color: "#f0a742", label: "Reconnecting live voice…", pulse: true }
          : { color: "#8b949e", label: "Using basic voice mode", pulse: false };
  const fallbackNotice =
    voiceConvActive && voiceTransport === "fallback" && !fallbackNoticeDismissed
      ? (realtime.fallbackReason ??
        "Live voice is unavailable right now. Using standard voice mode instead.")
      : null;

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

  // Auto-TTS: speak each new Ora reply when spoken replies should play.
  // In Voice Conversation Mode this is gated by its own mute control; in normal
  // typing mode it is gated by the user's "Voice responses" toggle (isTtsEnabled).
  // Always uses speakTextForce (server TTS) so replies use the high-quality voice.
  useEffect(() => {
    // Re-arm on an empty transcript (new chat / conversation switch / clear).
    if (messages.length === 0) {
      autoSpeakArmedRef.current = false;
      return;
    }
    const lastMsgIndex = messages.length - 1;
    const lastMsg = messages[lastMsgIndex];
    // First observation of a non-empty transcript: seed the dedup ref to the
    // existing last reply so a loaded history or restored preference never
    // replays an old answer. Only replies that arrive afterwards are spoken.
    if (!autoSpeakArmedRef.current) {
      autoSpeakArmedRef.current = true;
      lastSpokenAssistantMsgRef.current =
        lastMsg?.role === "assistant" ? `${lastMsgIndex}:${lastMsg.content}` : null;
      return;
    }
    // Realtime transport speaks its own audio — never double-speak via server
    // TTS. Keep the dedup ref current so exiting to typing mode (with "Voice
    // responses" on) won't replay a realtime turn.
    if (realtimeActive) {
      lastSpokenAssistantMsgRef.current =
        lastMsg?.role === "assistant" ? `${lastMsgIndex}:${lastMsg.content}` : null;
      return;
    }
    const shouldSpeak = voiceConvActive ? !voiceConvTtsMuted : voice.isTtsEnabled;
    if (!shouldSpeak) return;
    if (!lastMsg || lastMsg.role !== "assistant") return;
    const playbackKey = `${lastMsgIndex}:${lastMsg.content}`;
    if (playbackKey === lastSpokenAssistantMsgRef.current) return;
    lastSpokenAssistantMsgRef.current = playbackKey;
    voiceRef.current.speakTextForce(lastMsg.content, languageRef.current);
  }, [messages, voiceConvActive, voiceConvTtsMuted, voice.isTtsEnabled, realtimeActive]);

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
    // Realtime transport keeps the mic live itself — never run the legacy
    // record/transcribe loop alongside it.
    if (voiceTransport === "realtime") {
      cancelWhisperRecording();
      return;
    }
    if (!whisperSupported) return;
    if (isLoading || voice.voiceState === "speaking") return;
    if (whisperState !== "idle") return;
    // If the user denied mic permission, do NOT auto-restart — that would
    // create an infinite retry loop hitting the permission API every ~3.25 s.
    // Wait for the user to explicitly tap Retry.
    if (whisperConv.isPermissionDenied) return;

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
    voiceTransport,
    whisperConv.isPermissionDenied,
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

  // True once the in-flight streaming reply has produced visible text. Used to
  // hide the pending "thinking/replying" indicator so the dots aren't shown
  // alongside the streaming bubble once text starts flowing.
  const lastMessage = messages[messages.length - 1];
  const isStreamingWithContent =
    lastMessage?.role === "assistant" &&
    lastMessage.isStreaming === true &&
    lastMessage.content.trim().length > 0;

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
    if (!showModeMenu) return;
    function handleClickOutside(e: MouseEvent) {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setShowModeMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showModeMenu]);

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

  const handleReviseGeneratedFile = useCallback((file: GeneratedFile) => {
    const revisionPrompt = `Revise the ${file.format.toUpperCase()} file "${file.fileName}": `;
    setSelectedFormat(file.format);
    setInput(revisionPrompt);
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(revisionPrompt.length, revisionPrompt.length);
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
    voiceRef.current.stopListening();
    voiceRef.current.stopSpeaking();
    setInput("");
    setVoiceReady(false);
    setVoiceConvTtsMuted(false);
    setFallbackNoticeDismissed(false);
    wasConvSpeakingRef.current = false;
    const lastMsgIndex = messages.length - 1;
    const lastMsg = messages[lastMsgIndex];
    lastSpokenAssistantMsgRef.current =
      lastMsg?.role === "assistant" ? `${lastMsgIndex}:${lastMsg.content}` : null;
    // Default to the realtime transport; fall back to the legacy loop only if it
    // cannot start.
    setVoiceTransport("realtime");
    voiceTransportRef.current = "realtime";
    setVoiceConvActive(true);
    voiceConvActiveRef.current = true;

    const ctx = { ...getRealtimeContextRef.current() };
    void realtimeRef.current.start(ctx).then((ok) => {
      // The user may have already exited while the connection was negotiating.
      if (!voiceConvActiveRef.current) return;
      if (!ok) {
        // Realtime failed — switch to the legacy whisper -> chat -> tts loop.
        // Unlock browser audio inside this (now-resolved) gesture chain; the
        // automatic listener effect starts Whisper once transport flips.
        setVoiceTransport("fallback");
        voiceTransportRef.current = "fallback";
        void voiceRef.current.prepareVoicePlayback();
      }
    });
  }, [messages]);

  const handleExitVoiceConvMode = useCallback(() => {
    setVoiceConvActive(false);
    voiceConvActiveRef.current = false;
    wasConvSpeakingRef.current = false;
    realtimeRef.current.stop();
    voiceRef.current.stopListening();
    voiceRef.current.stopSpeaking();
    voiceRef.current.clearTtsFailed();
    whisperConv.cancelRecording();
    // Reset transport for the next session.
    setVoiceTransport("realtime");
    voiceTransportRef.current = "realtime";
    setFallbackNoticeDismissed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleVoiceConvTtsMute = useCallback(() => {
    // Realtime: mute only Ora's audio output (the data channel keeps running).
    if (voiceTransportRef.current === "realtime") {
      realtimeRef.current.toggleMute();
      return;
    }
    setVoiceConvTtsMuted((prev) => {
      const next = !prev;
      if (next) {
        voiceRef.current.stopSpeaking();
      } else {
        void voiceRef.current.prepareVoicePlayback();
      }
      return next;
    });
  }, []);

  const handleDismissFallbackNotice = useCallback(() => {
    setFallbackNoticeDismissed(true);
  }, []);

  // "Voice responses" toggle (normal typing mode). When enabling, unlock browser
  // audio inside this click gesture and seed the dedup ref to the current last
  // reply so only FUTURE replies are auto-spoken (never the existing answer).
  const handleToggleVoiceResponses = useCallback(() => {
    const enabling = !voiceRef.current.isTtsEnabled;
    if (enabling) {
      void voiceRef.current.prepareVoicePlayback();
      const lastMsgIndex = messages.length - 1;
      const lastMsg = messages[lastMsgIndex];
      lastSpokenAssistantMsgRef.current =
        lastMsg?.role === "assistant" ? `${lastMsgIndex}:${lastMsg.content}` : null;
    } else {
      voiceRef.current.stopSpeaking();
    }
    voiceRef.current.toggleTts();
  }, [messages]);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className={cn(
        "relative flex flex-col",
        isFull
          ? "h-full min-h-0 bg-background"
          : "rounded-2xl border border-border/60 bg-card shadow-lg max-h-[70dvh] transition-all duration-500",
      )}
      style={{ ["--ora-accent-hsl"]: oraAccentHsl(tier) } as CSSProperties}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag-and-drop overlay */}
      {isDragOver && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-[hsl(var(--ora-accent-hsl)/0.7)] bg-card/90 backdrop-blur-sm pointer-events-none"
          aria-hidden
        >
          <div className="flex flex-col items-center gap-2 text-[hsl(var(--ora-accent-hsl))]">
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
          <DynamicAtom state={atomState} size={28} accentColor={oraAccentColor(tier)} />
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight">Ora</span>
            {isSignedIn && <OraTierBadge tier={tier} />}
            {!isSignedIn && (
              <span className="text-[10px] text-muted-foreground/70 font-medium border border-border/50 rounded-full px-1.5 py-0.5">
                Free · No sign-in required
              </span>
            )}
            {temporary && (
              <span
                className="inline-flex items-center gap-1 text-[10px] text-[hsl(var(--ora-accent-hsl))] font-medium border border-[hsl(var(--ora-accent-hsl)/0.4)] bg-[hsl(var(--ora-accent-hsl)/0.08)] rounded-full px-1.5 py-0.5"
                title="Temporary chat — nothing is saved to memory or history"
              >
                <Ghost className="h-3 w-3" />
                Temporary
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
          {/* Live-voice connection-quality dot (mirrors mobile status dot) */}
          {showQualityDot && (
            <span
              className="flex items-center"
              title={qualityDot.label}
              aria-label={qualityDot.label}
            >
              <span
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  qualityDot.pulse && "animate-pulse",
                )}
                style={{ backgroundColor: qualityDot.color }}
              />
            </span>
          )}

          {/* Voice Conversation Mode — Talk with Ora (premium orb in header) */}
          {(realtime.isSupported || voice.isSupported || whisperConv.isSupported) && (
            <OraVoiceModeButton
              voiceState={
                realtimeActive
                  ? mapRealtimeToVoiceState(realtime.state)
                  : voiceConvActive &&
                      !(voice.voiceState === "unsupported" && whisperConv.isSupported)
                    ? voice.voiceState
                    : "idle"
              }
              isSupported={realtime.isSupported || voice.isSupported || whisperConv.isSupported}
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
                          ? "text-[hsl(var(--ora-accent-hsl))]"
                          : "text-muted-foreground/60",
                      )}
                    />
                    <span
                      className={cn(
                        "flex-1",
                        language === l.value && "text-[hsl(var(--ora-accent-hsl))] font-medium",
                      )}
                    >
                      {l.label}
                    </span>
                  </button>
                ))}

                <div className="my-1 h-px bg-border/60" />

                {/* Voice responses (TTS) */}
                {voice.isSpeechSynthesisSupported ? (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={voice.isTtsEnabled}
                    onClick={() => {
                      handleToggleVoiceResponses();
                      setShowHeaderMenu(false);
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors flex items-center gap-2"
                  >
                    {voice.isTtsEnabled ? (
                      <Volume2 className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--ora-accent-hsl))]" />
                    ) : (
                      <VolumeX className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                    )}
                    <span className="flex-1">
                      {voice.isTtsEnabled ? "Voice responses on" : "Voice responses off"}
                    </span>
                  </button>
                ) : (
                  <div
                    role="menuitem"
                    aria-disabled="true"
                    className="w-full px-3 py-1.5 text-xs text-muted-foreground/60 flex items-start gap-2 cursor-default"
                  >
                    <VolumeX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                    <span className="flex-1 leading-snug">
                      Spoken replies aren&apos;t available in this browser. You can still read
                      Ora&apos;s answers.
                    </span>
                  </div>
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

                {/* Temporary (incognito) chat */}
                {isSignedIn && (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={temporary}
                    onClick={() => {
                      setTemporary(!temporary);
                      setShowHeaderMenu(false);
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors flex items-center gap-2"
                  >
                    <Ghost
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        temporary
                          ? "text-[hsl(var(--ora-accent-hsl))]"
                          : "text-muted-foreground/60",
                      )}
                    />
                    <span
                      className={cn(
                        "flex-1",
                        temporary && "text-[hsl(var(--ora-accent-hsl))] font-medium",
                      )}
                    >
                      {temporary ? "Temporary chat on" : "Temporary chat"}
                    </span>
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
                <DynamicAtom state={atomState} size={52} accentColor={oraAccentColor(tier)} />
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
                Hi, I&apos;m <span className="text-[hsl(var(--ora-accent-hsl))]">Ora</span>
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
                    className="text-xs px-3.5 py-2 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-[hsl(var(--ora-accent-hsl)/0.5)] hover:bg-[hsl(var(--ora-accent-hsl)/0.07)] transition-all"
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
                  className="text-xs px-3 py-1.5 rounded-full border border-border/60 text-muted-foreground hover:text-foreground hover:border-[hsl(var(--ora-accent-hsl)/0.5)] hover:bg-[hsl(var(--ora-accent-hsl)/0.07)] transition-all"
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
            // Skip the empty assistant placeholder created before the first
            // token arrives — it would render as a blank bubble. The loading
            // indicator below represents the pending state until streaming text
            // appears, then this row renders normally once content exists.
            if (msg.role === "assistant" && msg.isStreaming && !msg.content.trim()) {
              return null;
            }
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
                  <DynamicAtom
                    state="idle"
                    size={24}
                    className="shrink-0 mt-0.5"
                    accentColor={oraAccentColor(tier)}
                  />
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
                      {msg.attachment && (
                        <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-[hsl(var(--ora-accent-hsl)/0.35)] bg-[hsl(var(--ora-accent-hsl)/0.07)] px-2.5 py-1.5 text-xs">
                          {msg.attachment.isImage ? (
                            <ImageIcon className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--ora-accent-hsl))]" />
                          ) : msg.attachment.isDataset ? (
                            <Table2 className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--ora-accent-hsl))]" />
                          ) : (
                            <FileText className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--ora-accent-hsl))]" />
                          )}
                          <span className="truncate">{msg.attachment.filename}</span>
                        </div>
                      )}
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
                      <OraRichText text={msg.content} isStreaming={msg.isStreaming} />
                      {import.meta.env.DEV && msg.viaFallback && !msg.isStreaming && (
                        <span
                          title="This response used the non-streaming fallback path (realProviderStreaming=false or /chat fallback)"
                          className="mt-1 inline-block select-none rounded px-1 py-px text-[10px] font-mono leading-none text-muted-foreground/50 border border-muted-foreground/20"
                        >
                          via fallback
                        </span>
                      )}
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
                      {msg.imageMeta && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {formatOraImageMeta(msg.imageMeta).map((label) => (
                            <span
                              key={label}
                              className="rounded-full border border-border/60 bg-muted/45 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                            >
                              {label}
                            </span>
                          ))}
                        </div>
                      )}
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
                                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ora-accent-hsl))] disabled:opacity-60"
                              />
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => submitImageEdit(msg.imageId!)}
                                  disabled={isLoading || !editImageInstruction.trim()}
                                  className="inline-flex items-center gap-1.5 rounded-lg bg-[hsl(var(--ora-accent-hsl))] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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

                  {msg.generatedFile && (
                    <GeneratedFileCard
                      file={msg.generatedFile}
                      onRevise={handleReviseGeneratedFile}
                    />
                  )}

                  {msg.role === "assistant" && msg.viaFallback && !msg.isStreaming && (
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground/50 select-none">
                      <Zap className="h-2.5 w-2.5" />
                      <span>Non-streamed</span>
                    </div>
                  )}

                  {msg.role === "assistant" &&
                    msg.searchRetryable &&
                    isLatestAssistant &&
                    !msg.isStreaming && (
                      <button
                        type="button"
                        onClick={() => void retryLastMessage()}
                        disabled={isLoading}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:border-primary/60 hover:bg-primary/20 disabled:pointer-events-none disabled:opacity-50"
                        title="Retry live search"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Retry live search</span>
                      </button>
                    )}

                  {msg.role === "assistant" &&
                    Array.isArray(msg.sources) &&
                    msg.sources.length > 0 && <OraSourceCards sources={msg.sources} />}

                  {msg.role === "assistant" &&
                    Array.isArray(msg.images) &&
                    msg.images.length > 0 && <OraImageGallery images={msg.images} />}

                  {msg.role === "assistant" &&
                    Array.isArray(msg.videos) &&
                    msg.videos.length > 0 && <OraVideoCards videos={msg.videos} />}

                  {msg.role === "assistant" &&
                    isSignedIn &&
                    (msg.memorySaveCandidate || msg.memorySaved) && (
                      <OraMemorySaveChip
                        fact={msg.memorySaveCandidate ?? ""}
                        saved={Boolean(msg.memorySaved)}
                        sensitive={Boolean(msg.memorySaveCandidateSensitive)}
                        supersededTitles={msg.memorySupersededTitles}
                        onSave={() => handleSaveMemory(msg.memorySaveCandidate ?? "", msg.content)}
                        onOpenMemoryCenter={() => setMemoryManagerOpen(true)}
                      />
                    )}

                  {msg.role === "assistant" &&
                    isSignedIn &&
                    Array.isArray(msg.memoriesUsed) &&
                    msg.memoriesUsed.length > 0 && (
                      <OraMemoriesUsedChip
                        memories={msg.memoriesUsed}
                        onOpenMemoryCenter={() => setMemoryManagerOpen(true)}
                      />
                    )}

                  {msg.role === "assistant" &&
                    isSignedIn &&
                    msg.documentMemory &&
                    (() => {
                      const dm = msg.documentMemory;
                      return (
                        <OraDocumentMemoryChip
                          fileRef={dm.fileRef}
                          filename={dm.filename}
                          saved={Boolean(msg.documentMemorySaved)}
                          onSaved={() => {
                            markDocumentMemorySaved(dm.fileRef);
                            void queryClient.invalidateQueries({
                              queryKey: ORA_MEMORIES_QUERY_KEY,
                            });
                            toast({ title: "Document saved to memory" });
                          }}
                        />
                      );
                    })()}

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
                        ? (text) => voice.speakTextForce(text, language)
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
                          className="text-xs px-3 py-1.5 rounded-full border border-[hsl(var(--ora-accent-hsl)/0.3)] text-muted-foreground hover:text-foreground hover:border-[hsl(var(--ora-accent-hsl)/0.6)] hover:bg-[hsl(var(--ora-accent-hsl)/0.07)] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
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

          {/* Loading state — only while the streaming reply has no visible text
              yet; once tokens flow, the streaming bubble itself shows progress. */}
          {isLoading && !isStreamingWithContent && (
            <div className="flex items-start gap-2.5">
              <DynamicAtom
                state={atomState}
                size={24}
                className="shrink-0 mt-0.5"
                accentColor={oraAccentColor(tier)}
              />
              <div className="flex flex-col gap-1 pt-0.5">
                <div className="flex items-center gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="block h-1.5 w-1.5 rounded-full animate-pulse"
                      style={{
                        backgroundColor: `${oraAccentColor(tier).replace(")", " / 0.5)")}`,
                        animationDelay: `${i * 200}ms`,
                        transition: "background-color 250ms ease",
                      }}
                    />
                  ))}
                </div>
                {oraStatus !== "idle" && (
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {STATUS_LABELS[oraStatus]}
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
              <div className="flex items-center gap-2 shrink-0">
                {((messages.at(-1)?.role === "assistant" && !!messages.at(-1)?.content) ||
                  messages.at(-1)?.role === "user") && (
                  <button
                    type="button"
                    onClick={() => void retryLastMessage()}
                    className="flex items-center gap-1 opacity-70 hover:opacity-100 transition-opacity"
                    title="Retry"
                  >
                    <RotateCcw className="h-3 w-3" />
                    <span>Retry</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearError}
                  className="opacity-60 hover:opacity-100 transition-opacity"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
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
                        className="text-[hsl(var(--ora-accent-hsl))] hover:underline"
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
                        className="text-[hsl(var(--ora-accent-hsl))] hover:underline"
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
                    transport={voiceTransport}
                    realtimeState={realtime.state}
                    interimUserText={realtime.interimUserTranscript}
                    interimAssistantText={realtime.interimAssistantTranscript}
                    remainingSeconds={realtime.remainingSeconds}
                    overLimit={realtime.overLimit}
                    fallbackNotice={fallbackNotice}
                    onDismissFallbackNotice={handleDismissFallbackNotice}
                    showRetry={realtime.networkQuality === "legacy"}
                    onRetry={handleEnterVoiceConvMode}
                    voiceState={
                      voice.voiceState === "unsupported" && whisperConv.isSupported
                        ? "idle"
                        : voice.voiceState
                    }
                    interimTranscript={voice.interimTranscript}
                    isLoading={isLoading}
                    isTtsMuted={realtimeActive ? realtime.isMuted : voiceConvTtsMuted}
                    onToggleTtsMute={handleToggleVoiceConvTtsMute}
                    onExit={handleExitVoiceConvMode}
                    onInterrupt={
                      realtimeActive
                        ? () => realtimeRef.current.interrupt()
                        : () => voiceRef.current.stopSpeaking()
                    }
                    size="md"
                    whisperState={whisperConv.state}
                    whisperSupported={whisperConv.isSupported}
                    whisperError={whisperConv.error}
                    whisperPermissionDenied={whisperConv.isPermissionDenied}
                    onWhisperStart={whisperConv.startRecording}
                    onWhisperStop={whisperConv.stopRecording}
                    onWhisperCancel={whisperConv.cancelRecording}
                    ttsUnavailable={voice.ttsUnavailable}
                    onDismissTtsNotice={voice.clearTtsFailed}
                  />
                ) : (
                  /* ─── Normal dictation + text input ─────────────────────────── */
                  <>
                    {/* One-time hint surfacing voice features (browser-dependent) */}
                    <OraVoiceTip
                      voiceInputSupported={voice.isSupported || whisperConv.isSupported}
                      voiceOutputSupported={voice.isServerTtsSupported}
                    />

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
                      <div className="flex items-center gap-2 rounded-xl border border-[hsl(var(--ora-accent-hsl)/0.35)] bg-[hsl(var(--ora-accent-hsl)/0.07)] px-3 py-2 text-xs mb-2">
                        <FileSpreadsheet className="h-3.5 w-3.5 text-[hsl(var(--ora-accent-hsl))] shrink-0" />
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

                    {/* Unified input bar — single row on desktop; on mobile it wraps
                        into a two-tier composer (full-width field on top, action row
                        below) so the placeholder never gets squeezed. */}
                    <div className="flex flex-wrap sm:flex-nowrap items-end gap-2 rounded-xl border border-border/60 bg-background/60 px-2 py-1.5 focus-within:border-[hsl(var(--ora-accent-hsl)/0.4)] focus-within:ring-1 focus-within:ring-[hsl(var(--ora-accent-hsl)/0.15)] transition-all">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.docx,.txt,.csv,.xlsx,.pptx,.zip,.png,.jpg,.jpeg,.webp"
                        className="sr-only"
                        aria-hidden
                        onChange={handleFileChange}
                      />
                      {/* Compact mode selector — mobile only. Collapses the two
                          Instant/Deep pills into one chip + popover to reclaim width. */}
                      <div className="relative order-2 shrink-0 sm:hidden" ref={modeMenuRef}>
                        <button
                          type="button"
                          onClick={() => setShowModeMenu((v) => !v)}
                          aria-haspopup="menu"
                          aria-expanded={showModeMenu}
                          title="Switch response mode"
                          className="flex h-8 items-center gap-1 rounded-lg bg-muted/40 px-2.5 text-[11px] font-medium text-foreground transition-colors"
                        >
                          {mode === "deep" && deepAllowed ? (
                            <Brain className="h-3.5 w-3.5" />
                          ) : (
                            <Zap className="h-3.5 w-3.5" />
                          )}
                          {mode === "deep" && deepAllowed ? "Deep" : "Instant"}
                          <ChevronDown className="h-3 w-3 opacity-60" />
                        </button>
                        {showModeMenu && (
                          <div
                            role="menu"
                            className="absolute bottom-full mb-1.5 left-0 z-50 bg-popover border border-border rounded-xl shadow-xl py-1 min-w-[190px]"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMode("instant");
                                setShowModeMenu(false);
                              }}
                              className={cn(
                                "w-full text-left px-3 py-2 text-xs hover:bg-muted/50 transition-colors flex items-center gap-2",
                                mode === "instant" &&
                                  "text-[hsl(var(--ora-accent-hsl))] font-medium",
                              )}
                            >
                              <Zap className="h-3.5 w-3.5 shrink-0" />
                              <span className="flex-1">Instant</span>
                              <span className="text-[10px] text-muted-foreground/60 shrink-0">
                                Fast replies
                              </span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setShowModeMenu(false);
                                if (deepAllowed) {
                                  setMode("deep");
                                } else {
                                  setLocation("/ora/settings");
                                }
                              }}
                              className={cn(
                                "w-full text-left px-3 py-2 text-xs hover:bg-muted/50 transition-colors flex items-center gap-2",
                                mode === "deep" &&
                                  deepAllowed &&
                                  "text-[hsl(var(--ora-accent-hsl))] font-medium",
                              )}
                            >
                              {deepAllowed ? (
                                <Brain className="h-3.5 w-3.5 shrink-0" />
                              ) : (
                                <Lock className="h-3.5 w-3.5 shrink-0" />
                              )}
                              <span className="flex-1">Deep</span>
                              <span className="text-[10px] text-muted-foreground/60 shrink-0">
                                {deepAllowed ? "Step-by-step" : "Upgrade"}
                              </span>
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Instant vs Deep Thinking toggle — desktop only */}
                      <div className="hidden sm:order-1 sm:flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/40 p-0.5">
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
                      <div className="relative order-3 shrink-0 sm:order-2" ref={plusMenuRef}>
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
                              ? "text-[hsl(var(--ora-accent-hsl))] bg-[hsl(var(--ora-accent-hsl)/0.12)]"
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
                                    "text-[hsl(var(--ora-accent-hsl))] font-medium",
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
                      <div className="order-4 shrink-0 sm:order-3">
                        <OraDictationButton
                          voiceState={voice.voiceState}
                          isSupported={voice.isSupported}
                          onStart={() => voice.startListening(language)}
                          onStop={() => voice.stopListening()}
                          disabled={isLoading || atLimit}
                          size="md"
                        />
                      </div>

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
                        className="order-1 w-full resize-none bg-transparent py-1.5 text-sm placeholder:text-muted-foreground/60 focus:outline-none leading-snug sm:order-4 sm:w-auto sm:flex-1"
                        style={{ maxHeight: "96px" }}
                        disabled={isLoading}
                        onPaste={handlePaste}
                      />
                      <button
                        type="button"
                        onClick={handleSend}
                        disabled={!input.trim() || isLoading || uploadState === "uploading"}
                        className="order-5 ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--ora-accent-hsl))] text-white disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-colors sm:order-5 sm:ml-0 sm:h-7 sm:w-7"
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
                          <span className="sm:hidden">
                            {voice.isSupported || whisperConv.isSupported
                              ? "Upload files · voice or type"
                              : "Upload files · typing only"}
                          </span>
                          <span className="hidden sm:inline">
                            Upload or drag images, PDF, DOCX, CSV, XLSX ·{" "}
                            {voice.isSupported || whisperConv.isSupported
                              ? "Voice or type in any language"
                              : "Voice unavailable on this browser — typing still works"}
                          </span>
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

      <OraMemoryManager
        open={memoryManagerOpen}
        onOpenChange={setMemoryManagerOpen}
        oraProjectId={saveOraProjectId}
      />
    </div>
  );
}
