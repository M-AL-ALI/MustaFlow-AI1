import { useAuth } from "@clerk/expo";
import { Image } from "expo-image";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import {
  AudioModule,
  RecordingPresets,
  createAudioPlayer,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type AudioPlayer,
  type AudioRecorder,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect, useRouter } from "expo-router";
import {
  AlertCircle,
  ArrowUp,
  Brain,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileDown,
  FileJson,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  Presentation,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Gauge,
  Ghost,
  Globe,
  History,
  Image as ImageIcon,
  Images,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Pencil,
  PhoneOff,
  Plus,
  RefreshCw,
  Send,
  Share2,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
  Zap,
  Pin,
  PinOff,
  Search,
} from "lucide-react-native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Markdown } from "@/components/Markdown";
import {
  OraAssistantExtras,
  OraAttachmentChip,
  OraSuggestions,
} from "@/components/ora/MessageExtras";
import { OraAtom } from "@/components/ora/OraAtom";
import { ImagePreviewModal } from "@/components/ora/ImagePreviewModal";
import { OraThinkingRow } from "@/components/ora/OraThinkingRow";
import { OraMenuLogo } from "@/components/ora/OraMenuLogo";
import { OraThemeToggle } from "@/components/ora/OraThemeToggle";
import { OraVoiceOrb } from "@/components/ora/OraVoiceOrb";
import { OraLiveDot, OraWaveBars } from "@/components/ora/OraWaveBars";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useColors } from "@/hooks/useColors";
import { useOraRealtimeVoiceNative } from "@/hooks/useOraRealtimeVoiceNative";
import {
  getLocalFileSize,
  MAX_UPLOAD_BYTES,
  saveGeneratedFile,
  saveHtmlAsPdf,
  saveImageFromUrl,
  saveTextAsFile,
} from "@/lib/files";
import { logError } from "@/lib/log";
import { isSafeHttpUrl } from "@/lib/safe-url";
import {
  analyzeDataset,
  analyzeDocument,
  analyzeImage,
  ApiRequestError,
  createConversation,
  createProject,
  deleteConversation,
  restoreConversation,
  permanentDeleteConversation,
  pinConversation,
  listArchivedConversations,
  getOraUserSettings,
  patchOraUserSettings,
  deleteProject,
  editImage,
  exportFile,
  generateFile,
  getConversation,
  getOraSession,
  getPreferences,
  listConversations,
  listProjects,
  moveConversation,
  NetworkError,
  renameProject,
  saveConversationMessages,
  saveOraMemory,
  clientTimeZone,
  sendChat,
  notifyStreamFallbackCalled,
  streamChatNative,
  synthesizeSpeech,
  transcribeAudio,
  updatePreferences,
  uploadFile,
} from "@/lib/api";
import { useActiveProject } from "@/context/ActiveProjectContext";
import { setAuthState, TokenUnavailableError } from "@/lib/auth-client";
import { readStoredFocusMode } from "@/lib/focus-mode";
import {
  getAutoSaveMemories,
  getReferenceChatHistory,
  getReferenceSavedMemories,
} from "@/lib/memory-settings";
import { setCurrentSessionTier } from "@/lib/session-store";
import { readStoredVoicePreset } from "@/lib/voice-preset";
import type {
  Attachment,
  ChatRequest,
  ChatResponse,
  FileFormat,
  FocusMode,
  VoicePreset,
  GeneratedFile,
  OraConversationSummary,
  OraMessage,
  OraMode,
  OraProjectSummary,
  OraSession,
} from "@/lib/types";

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Red used for the live "listening" waveform + recording dot (mirrors web red-400). */
const VOICE_LISTEN_RED = "#f87171";

/** Format a seconds countdown as m:ss for the realtime session timer (mirrors web). */
function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, "0")}`;
}

function cleanForTts(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/\*(.+?)\*/gs, "$1")
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, "I included a code block in the written reply.")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\|[^\n]+\|/g, (row) =>
      row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)
        .join(", "),
    )
    .replace(/^\s*[-=]{3,}\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function messageTitle(message: OraMessage): string {
  if (message.messageKind === "image-analysis") return "Ora Image Analysis";
  if (message.messageKind === "document-analysis") return "Ora Document Analysis";
  if (message.datasetResult) return "Ora Dataset Report";
  return message.role === "assistant" ? "Ora Response" : "Ora Message";
}

function datasetWorkflowMarkdown(result: NonNullable<OraMessage["datasetResult"]>): string[] {
  const workflow = result.analystWorkflow;
  if (!workflow) return [];
  const lines: string[] = [];
  const charts = workflow.chartSuggestions ?? [];
  const calculations = workflow.calculationSuggestions ?? [];
  const reports = workflow.reportSuggestions ?? [];

  if (charts.length) {
    lines.push("", "## Suggested Charts");
    charts.forEach((chart) => {
      const columns = [
        chart.xColumn ? `X: ${chart.xColumn}` : "",
        chart.yColumn ? `Y: ${chart.yColumn}` : "",
        chart.groupByColumn ? `Group: ${chart.groupByColumn}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `- **${chart.title}** (${chart.chartType})${columns ? ` - ${columns}` : ""}. ${chart.reason}`,
      );
    });
  }

  if (calculations.length) {
    lines.push("", "## Repeatable Calculations");
    calculations.forEach((calc) => {
      const columns = calc.columns?.length ? ` Columns: ${calc.columns.join(", ")}.` : "";
      lines.push(`- **${calc.label}**: \`${calc.expression}\` - ${calc.description}.${columns}`);
    });
  }

  if (reports.length) {
    lines.push("", "## Downloadable Reports");
    reports.forEach((report) => {
      lines.push(`- **${report.format.toUpperCase()}**: ${report.title} - ${report.description}`);
    });
  }

  return lines;
}

function parseChartNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseFloat(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function textBar(value: number, max: number): string {
  const width = Math.max(1, Math.round((value / Math.max(max, 1)) * 18));
  return "#".repeat(width);
}

function datasetGeneratedChartsMarkdown(
  result: NonNullable<OraMessage["datasetResult"]>,
): string[] {
  const chartBlocks: Array<{ title: string; rows: Array<{ label: string; value: number }> }> = [];
  const paretoRows = (Array.isArray(result.paretoFindings) ? result.paretoFindings : [])
    .map((row) => ({
      label: String(row.label ?? ""),
      value: parseChartNumber(row.value),
    }))
    .filter((row): row is { label: string; value: number } => !!row.label && row.value !== null)
    .slice(0, 8);
  if (paretoRows.length >= 2) chartBlocks.push({ title: "Pareto Contribution", rows: paretoRows });

  const riskRows = (Array.isArray(result.enhancedRisks) ? result.enhancedRisks : [])
    .map((risk) => ({
      label: String(risk.risk ?? ""),
      value: parseChartNumber(risk.riskScore),
    }))
    .filter((row): row is { label: string; value: number } => !!row.label && row.value !== null)
    .slice(0, 8);
  if (riskRows.length >= 2) chartBlocks.push({ title: "Risk Score by Issue", rows: riskRows });

  const priorityCounts = new Map<string, number>();
  for (const action of Array.isArray(result.actionPlan) ? result.actionPlan : []) {
    priorityCounts.set(action.priority, (priorityCounts.get(action.priority) ?? 0) + 1);
  }
  const priorityRows = ["high", "medium", "low"]
    .map((priority) => ({
      label: priority[0].toUpperCase() + priority.slice(1),
      value: priorityCounts.get(priority) ?? 0,
    }))
    .filter((row) => row.value > 0);
  if (priorityRows.length >= 2) {
    chartBlocks.push({ title: "Action Plan by Priority", rows: priorityRows });
  }

  if (chartBlocks.length === 0) return [];

  const lines = ["", "## Generated Charts"];
  chartBlocks.forEach((block) => {
    const max = Math.max(...block.rows.map((row) => row.value), 1);
    lines.push("", `### ${block.title}`);
    block.rows.forEach((row) => {
      lines.push(`- ${row.label}: ${textBar(row.value, max)} ${row.value}`);
    });
  });
  return lines;
}

function messageMarkdown(
  message: OraMessage,
  options: { includeDatasetJson?: boolean } = {},
): string {
  const lines = [`# ${messageTitle(message)}`, "", message.content.trim()];
  if (message.sources?.length) {
    lines.push("", "## Sources");
    message.sources.forEach((source, index) => {
      lines.push(`${index + 1}. ${source.title ?? source.url ?? "Source"}`);
      if (source.url) lines.push(`   ${source.url}`);
    });
  }
  if (message.datasetResult) {
    lines.push(...datasetGeneratedChartsMarkdown(message.datasetResult));
    lines.push(...datasetWorkflowMarkdown(message.datasetResult));
  }
  if (message.datasetResult && options.includeDatasetJson !== false) {
    lines.push(
      "",
      "## Dataset JSON",
      "```json",
      JSON.stringify(message.datasetResult, null, 2),
      "```",
    );
  }
  return lines.join("\n");
}

function conversationMarkdown(messages: OraMessage[]): string {
  return [
    "# Ora Conversation",
    "",
    ...messages.map((m) => `## ${m.role === "user" ? "User" : "Ora"}\n\n${m.content.trim()}`),
  ].join("\n\n");
}

function reportPdfHtml(messages: OraMessage[], title: string): string {
  const rows = messages
    .filter((m) => m.content.trim())
    .map(
      (m) =>
        `<div class="${m.role === "assistant" ? "ora" : "user"}">` +
        `<strong>${m.role === "assistant" ? "Ora" : "You"}</strong>` +
        `<p>${m.content.trim().replace(/\n/g, "<br>")}</p></div>`,
    )
    .join("");
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:20px}` +
    `.ora{background:#f0f4ff;padding:12px;border-radius:8px;margin-bottom:12px}` +
    `.user{background:#fff;border:1px solid #e0e0e0;padding:12px;border-radius:8px;margin-bottom:12px}` +
    `p{margin:8px 0 0}@media print{body{margin:0}}</style></head>` +
    `<body><h1>${title}</h1>${rows}</body></html>`
  );
}

function datasetActionPlanCsv(message: OraMessage): string | null {
  const rows = (message.datasetResult as { actionPlan?: unknown[] } | undefined)?.actionPlan;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const keys = Array.from(
    rows.reduce<Set<string>>((set, row) => {
      if (row && typeof row === "object") Object.keys(row).forEach((k) => set.add(k));
      return set;
    }, new Set<string>()),
  );
  if (keys.length === 0) return null;
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [
    keys.join(","),
    ...rows.map((row) => keys.map((k) => escape((row as Record<string, unknown>)[k])).join(",")),
  ].join("\n");
}

const DATASET_TYPES = ["csv", "xlsx", "xls"];

// Mirrors website Ora EXAMPLE_CHIPS in ora-panel.tsx
const EXAMPLE_CHIPS = [
  "Plan an app idea",
  "Find the root cause of a problem",
  "Can MustaFlow build X?",
  "Help me think through a strategy",
  "What can I build with MustaFlow?",
  "Analyze a business idea",
];

// Matches website Ora LANGUAGES constant in ora-panel.tsx
const LANGUAGES = [
  { value: "auto", label: "Auto Detect" },
  { value: "en", label: "English" },
  { value: "ar", label: "Arabic" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
];

// Matches website oraAccentColor / oraTierLabel from ora-panel.tsx
// Colors: hsl→hex computed from website CSS tokens
function tierAccentColor(tier: string | null | undefined): string {
  if (tier === "core") return "#3D83F5"; // hsl(217 90% 60%) — Core Pack blue
  if (tier === "wave") return "#F0A742"; // hsl(35 85% 60%)  — Deep Wave amber
  return "#995AF2"; // hsl(265 85% 65%) — Free / default purple
}

function tierLabel(tier: string | null | undefined): string {
  if (tier === "core") return "Core Pack";
  if (tier === "wave") return "Deep Wave";
  return "Free";
}

function attachmentKind(fileType: string, isImage: boolean): Attachment["kind"] {
  if (isImage) return "image";
  if (DATASET_TYPES.includes(fileType.toLowerCase())) return "dataset";
  return "document";
}

/** Best-effort hostname for a source URL, used as the card's secondary label. */
function sourceHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function isImageFile(mimeType?: string): boolean {
  return !!mimeType && mimeType.toLowerCase().startsWith("image/");
}

/**
 * Classify a generated file into one of the supported document formats so the
 * download card can show the right affordance. Server replies omit the format,
 * so we infer it from the filename extension first, then the MIME type.
 */
function detectFileFormat(fileName: string, mimeType: string): FileFormat {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "csv" || ext === "xlsx" || ext === "docx" || ext === "pdf" || ext === "pptx") {
    return ext;
  }
  const mt = mimeType.toLowerCase();
  if (mt.includes("csv")) return "csv";
  if (mt.includes("spreadsheet") || mt.includes("excel")) return "xlsx";
  if (mt.includes("wordprocessing") || mt.includes("msword")) return "docx";
  if (mt.includes("presentation") || mt.includes("powerpoint")) return "pptx";
  return "pdf";
}

/** Build a downloadable generated-file payload only when bytes are present. */
function buildGeneratedFile(
  res: Pick<ChatResponse, "fileName" | "fileData" | "mimeType" | "assetId">,
): GeneratedFile | undefined {
  if (!res.fileName || !res.fileData || !res.mimeType) return undefined;
  return {
    fileName: res.fileName,
    fileData: res.fileData,
    mimeType: res.mimeType,
    format: detectFileFormat(res.fileName, res.mimeType),
    // Carried so a reloaded message (bytes dropped) can still download via the
    // durable library asset.
    ...(res.assetId != null ? { assetId: res.assetId } : {}),
  };
}

/** Map the rich metadata from a (non-streamed) /chat reply onto a message. */
function buildChatExtras(res: ChatResponse): Partial<OraMessage> {
  return {
    sources: res.sources,
    images: res.images,
    videos: res.videos,
    suggestions: res.suggestions,
    imageUrl: res.imageUrl,
    imageId: res.imageId,
    imageMeta: res.imageMeta,
    memorySaveCandidate: res.memorySaveCandidate,
    memorySaveCandidateConfidence: res.memorySaveCandidateConfidence,
    memorySaveCandidateSensitive: res.memorySaveCandidateSensitive,
    memoriesUsed: res.memoriesUsed,
    generatedFile: buildGeneratedFile(res),
    ...(res.searchFallback ? { searchFallback: true } : {}),
    ...(res.searchRetryable ? { searchRetryable: true } : {}),
  };
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

export default function OraChatScreen() {
  const { isSignedIn, isLoaded } = useAuth();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<OraMessage>>(null);

  const [session, setSession] = useState<OraSession | null>(null);
  const [sessionSyncError, setSessionSyncError] = useState<"token_unavailable" | null>(null);
  const [messages, setMessages] = useState<OraMessage[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<OraMode>("instant");
  const [sending, setSending] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const lastActiveRestoreAttemptedRef = useRef(false);
  const [showConversations, setShowConversations] = useState(false);
  const [conversations, setConversations] = useState<OraConversationSummary[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [projects, setProjects] = useState<OraProjectSummary[]>([]);
  // The project new chats are filed under. null = standalone ("Recent"). This
  // single state is the source of truth for scope; new conversations created by
  // persist() inherit it via activeProjectIdRef. No route-derived tri-state.
  const { activeProjectId, setActiveProjectId } = useActiveProject();
  const { pendingConversationId, setPendingConversationId, newConversationTick } =
    useActiveProject();
  const activeProjectIdRef = useRef<number | null>(null);
  activeProjectIdRef.current = activeProjectId;
  // True once the project list has loaded at least once, so the "active project
  // vanished" cleanup effect below does not fire during the initial empty state.
  const projectsLoadedRef = useRef(false);
  // Project create/rename editor. editingProject=null means "create new".
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<OraProjectSummary | null>(null);
  const [moveTarget, setMoveTarget] = useState<OraConversationSummary | null>(null);
  const [temporary, setTemporary] = useState(false);
  // Inline image editing state — mirrors web ora-panel
  const [editingImageId, setEditingImageId] = useState<number | null>(null);
  const [editInstruction, setEditInstruction] = useState("");
  const [editingImage, setEditingImage] = useState(false);
  const temporaryRef = useRef(false);
  temporaryRef.current = temporary;
  const sendingRef = useRef(false);
  sendingRef.current = sending;
  const messagesRef = useRef<OraMessage[]>(messages);
  messagesRef.current = messages;
  // Bumped whenever the app is backgrounded so an in-flight speak() can abort
  // before it ever creates/plays an audio player (no TTS after backgrounding).
  const speakGenRef = useRef(0);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showGenerateFile, setShowGenerateFile] = useState(false);
  const [generateFileDraft, setGenerateFileDraft] = useState<{
    prompt: string;
    format: FileFormat;
  } | null>(null);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  // UUID refs of documents/datasets uploaded this conversation. The server
  // re-hydrates their real content during file creation so a generated file is
  // built from the user's actual data instead of fabricated values. Cleared on
  // every context switch (new chat, temporary toggle, conversation load) since
  // refs are session-scoped. Capped at the server's max (5, most recent first).
  const documentRefsRef = useRef<string[]>([]);
  const router = useRouter();
  const [actionsMessage, setActionsMessage] = useState<OraMessage | null>(null);
  // Source (remote URL / data URI / local file URI) of the image shown in the
  // full-screen preview modal; null = closed. Opened by tapping a generated
  // image or an uploaded image thumbnail. Stable setter so the memoized bubble
  // callback below never goes stale.
  const [previewImageSource, setPreviewImageSource] = useState<string | null>(null);
  const openImagePreview = useCallback((src: string) => setPreviewImageSource(src), []);

  const [voiceLang, setVoiceLang] = useState("en");
  // Per-session Ora reply language — matches website LANGUAGES (auto/en/ar/es/fr).
  // Separate from voiceLang (which controls STT/TTS locale). Sent in every chat
  // request so the server applies a language override system prompt when non-auto.
  const [language, setLanguage] = useState("auto");
  const [autoReadReplies, setAutoReadReplies] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [composerFocused, setComposerFocused] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [talkMode, setTalkMode] = useState(false);
  const [talkModeMuted, setTalkModeMuted] = useState(false);
  const talkModeRef = useRef(false);
  talkModeRef.current = talkMode;
  const talkModeMutedRef = useRef(false);
  talkModeMutedRef.current = talkModeMuted;
  // True while a TRUE realtime (WebRTC) voice session is driving Talk mode. When
  // set, the legacy transcribe -> chat -> tts loop is fully suppressed (see the
  // early return in scheduleTalkRestart) so the two voice paths never overlap.
  const [realtimeActive, setRealtimeActive] = useState(false);
  const realtimeActiveRef = useRef(false);
  realtimeActiveRef.current = realtimeActive;
  // True only during the start()/connect window, before realtimeActive flips
  // true. The hook marks itself active before start() resolves, so this lets the
  // background / exit / context-switch handlers abort an in-flight connect that
  // hasn't resolved yet (otherwise the mic could open after the user left).
  const realtimeStartingRef = useRef(false);
  // Monotonic id for each realtime start attempt. Captured before rt.start() and
  // checked when its promise resolves: a stale resolution (a stop / context
  // switch / background, or a newer start, ran in between) must touch nothing —
  // clearing realtimeStartingRef would arm the legacy recorder under the newer
  // connect, and calling stop() would kill the newer session. Incremented in
  // stopRealtimeSession (the single teardown chokepoint) and before each start.
  const realtimeStartGenRef = useRef(0);
  // Assigned just after the realtime hook is created below; declared up here so
  // earlier effects (e.g. the AppState background handler) can tear the session
  // down without a use-before-declaration reference.
  const realtimeVoiceRef = useRef<ReturnType<typeof useOraRealtimeVoiceNative> | null>(null);
  // Centralized teardown for the realtime transport. Safe to call whether a
  // session is fully live (realtimeActive) or still mid-connect
  // (realtimeStartingRef) — the hook's stop() aborts an in-flight start() too.
  // Returns true if it actually tore a session down, so context-switch callers
  // can decide whether to also drop Talk mode.
  const stopRealtimeSession = useCallback(() => {
    if (!realtimeActiveRef.current && !realtimeStartingRef.current) return false;
    // Invalidate any in-flight start() so its late resolution becomes a no-op.
    realtimeStartGenRef.current += 1;
    realtimeVoiceRef.current?.stop();
    setRealtimeActive(false);
    realtimeActiveRef.current = false;
    realtimeStartingRef.current = false;
    // Hand the iOS audio session back to the playback-only category now that the
    // realtime capture is gone — clears the active-mic state and restores normal
    // silent-mode / speak() behavior. Best-effort and only on terminal teardown
    // (exit Talk mode, context switch, background, over-limit), never as a prelude
    // to another start(), so it cannot race the realtime capture session.
    void setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => {});
    return true;
  }, []);
  // Used when the user switches conversation/project/temporary context. A live
  // realtime session is bound to the old thread and has no in-place "continue in
  // the new thread" path (re-minting would be surprising and costly). The
  // terminal-state effect is also intentionally skipped once realtimeActiveRef is
  // cleared, so without this the UI would sit in Talk mode with no transport
  // running. Drop out of Talk mode entirely instead; the user can re-tap Talk to
  // start a fresh session bound to the new thread. The legacy loop's own
  // context-switch behavior (Talk mode survives) is left unchanged.
  const stopRealtimeForContextSwitch = useCallback(() => {
    if (stopRealtimeSession() && talkModeRef.current) {
      setTalkMode(false);
      talkModeRef.current = false;
    }
  }, [stopRealtimeSession]);
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const playerRef = useRef<AudioPlayer | null>(null);
  const talkRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Abort controller for any in-flight SSE stream. Aborted on unmount and on
  // each new send so only one stream is ever active at a time.
  const streamAbortRef = useRef<AbortController | null>(null);
  const startRecordingRef = useRef<() => Promise<void>>(async () => {});
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const transcribingRef = useRef(transcribing);
  transcribingRef.current = transcribing;
  const speakingIdRef = useRef<string | null>(speakingId);
  speakingIdRef.current = speakingId;

  // Speaker-focus posture for realtime voice. Client-only (AsyncStorage), read
  // here and passed into the realtime session start ctx; default "focused".
  const focusModeRef = useRef<FocusMode>("focused");
  // Product voice for realtime voice. Client-only (AsyncStorage), read here and
  // passed into the realtime session start ctx; default "marine".
  const voicePresetRef = useRef<VoicePreset>("marine");

  const loadPreferences = useCallback(() => {
    getPreferences()
      .then((p) => {
        if (p.voiceLang) setVoiceLang(p.voiceLang);
        setAutoReadReplies(!!p.autoReadReplies);
      })
      .catch(() => {});
    readStoredFocusMode()
      .then((mode) => {
        focusModeRef.current = mode;
      })
      .catch(() => {});
    readStoredVoicePreset()
      .then((preset) => {
        voicePresetRef.current = preset;
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Wait for Clerk auth to load before creating the Ora session.
    // React runs child effects before parent effects, so _layout.tsx's
    // setAuthState() may not have been called yet — requireAuthToken()
    // handles this by polling for the first load, but when _authIsLoaded is
    // already true (subsequent re-runs when isSignedIn changes) the poll
    // short-circuits immediately and sees a stale _authIsSignedIn=false.
    // Calling setAuthState here makes the module-level state match React state
    // before any await, so requireAuthToken() never reads a stale value.
    if (!isLoaded) return;
    setAuthState(isLoaded, !!isSignedIn);
    setSessionSyncError(null);
    getOraSession()
      .then((s) => {
        setSession(s);
        setCurrentSessionTier(s.tier ?? null, !!s.isPaid);
      })
      .catch((err) => {
        if (err instanceof TokenUnavailableError) {
          // Signed in but token unavailable — do NOT silently fall to an
          // anonymous/free session. Show a re-sync prompt instead.
          setSessionSyncError("token_unavailable");
        } else {
          setSession(null);
          setCurrentSessionTier(null);
        }
      });
    loadPreferences();
    // Preload projects so the active-scope banner can resolve a project's name
    // even before the chats drawer is opened. Skip for anonymous users.
    if (isSignedIn) {
      listProjects()
        .then((p) => {
          projectsLoadedRef.current = true;
          setProjects(p);
        })
        .catch(() => {});
    }
  }, [loadPreferences, isSignedIn, isLoaded]);

  // Drop back to standalone if the active project no longer exists (deleted here
  // or externally) once the project list has actually loaded, so a new chat never
  // POSTs a dangling projectId that the server would reject (and persist() would
  // then silently drop).
  useEffect(() => {
    if (
      projectsLoadedRef.current &&
      activeProjectId != null &&
      !projects.some((p) => p.id === activeProjectId)
    ) {
      setActiveProjectId(null);
    }
  }, [projects, activeProjectId]);

  // Re-read preferences whenever the chat screen regains focus so changes made
  // in Settings (e.g. "Read replies aloud", voice language) apply immediately
  // without an app restart — drawer screens stay mounted between navigations.
  useFocusEffect(
    useCallback(() => {
      loadPreferences();
    }, [loadPreferences]),
  );

  // Abort any in-flight SSE stream when the user navigates away from this
  // screen. Drawer screens stay mounted between navigations so unmount alone
  // is not enough — we must also cancel on blur to avoid dangling requests.
  // We also clean up any pending/streaming placeholder so the bubble does not
  // stay frozen when the user returns to the screen.
  useFocusEffect(
    useCallback(() => {
      return () => {
        if (streamAbortRef.current) {
          streamAbortRef.current.abort();
          streamAbortRef.current = null;
          setMessages((prev) => {
            const hasFrozen = prev.some((m) => m.pending || m.isStreaming);
            if (!hasFrozen) return prev;
            return prev.map((m) =>
              m.pending || m.isStreaming ? { ...m, pending: false, isStreaming: false } : m,
            );
          });
        }
      };
    }, []),
  );

  useEffect(() => {
    return () => {
      if (talkRestartTimerRef.current) {
        clearTimeout(talkRestartTimerRef.current);
        talkRestartTimerRef.current = null;
      }
      try {
        playerRef.current?.remove();
      } catch {
        /* ignore */
      }
      // Abort any in-flight SSE stream so navigation never leaves a dangling
      // fetch that would try to update unmounted state.
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
    };
  }, []);

  const cancelTalkRestart = useCallback(() => {
    if (talkRestartTimerRef.current) {
      clearTimeout(talkRestartTimerRef.current);
      talkRestartTimerRef.current = null;
    }
  }, []);

  // When the app is backgrounded, tear down the voice loop so it never resumes
  // into a stuck recording/playback state. iOS suspends JS timers and can
  // interrupt the microphone while backgrounded, which would otherwise leave
  // Talk mode mid-cycle (or a TTS clip playing) on return. In-flight SSE streams
  // resume on their own and are intentionally left alone.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      // `inactive` is a transient state iOS passes through for call banners,
      // Control Center, the app switcher, Face ID prompts, etc. Bump the speak
      // generation so any in-flight TTS *synthesis* aborts before it can begin
      // playback during an interruption, but leave the recorder, current player,
      // and Talk mode untouched so a quick peek does not tear down the voice
      // loop. speak()'s abort path reschedules the Talk turn when still active.
      if (next === "inactive") {
        speakGenRef.current += 1;
        return;
      }
      if (next !== "background") return;
      speakGenRef.current += 1;
      cancelTalkRestart();
      // Tear down a realtime voice session too — its mic/peer connection must not
      // linger while the app is suspended. Covers a session that is still
      // connecting (realtimeStartingRef), not just a fully-live one.
      stopRealtimeSession();
      try {
        playerRef.current?.remove();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      setSpeakingId(null);
      speakingIdRef.current = null;
      if (recordingRef.current) {
        recorder
          .stop()
          .then(() => setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }))
          .catch(() => {});
        setRecording(false);
      }
      if (talkModeRef.current) {
        setTalkMode(false);
        talkModeRef.current = false;
      }
    });
    return () => sub.remove();
  }, [cancelTalkRestart, recorder, stopRealtimeSession]);

  const scheduleTalkRestart = useCallback(
    (delayMs: number) => {
      // A realtime WebRTC session fully owns the mic/audio while active, so never
      // arm the legacy record/transcribe loop underneath it. Also suppress while a
      // realtime session is still connecting (realtimeStartingRef): an AppState
      // inactive->active during the connect window could otherwise arm the legacy
      // recorder underneath an in-flight realtime start.
      if (realtimeActiveRef.current || realtimeStartingRef.current) return;
      cancelTalkRestart();
      talkRestartTimerRef.current = setTimeout(() => {
        talkRestartTimerRef.current = null;
        if (
          !talkModeRef.current ||
          realtimeActiveRef.current ||
          realtimeStartingRef.current ||
          recordingRef.current ||
          transcribingRef.current ||
          speakingIdRef.current ||
          AppState.currentState !== "active"
        ) {
          // Never open the mic while the app is not foregrounded. If an
          // interruption (call banner, Control Center, app switcher) is active
          // when this fires, bail; the resume-on-active effect re-schedules the
          // turn once the app comes back.
          return;
        }
        void startRecordingRef.current();
      }, delayMs);
    },
    [cancelTalkRestart],
  );

  // Resume the Talk loop when the app returns to the foreground after a
  // transient interruption. Talk mode is only torn down on `background`, so if
  // it survived (e.g. a quick peek at Control Center) and we are idle, schedule
  // the next listen turn — this is what actually restarts the loop after a
  // restart that bailed because the app was still inactive.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      if (
        talkModeRef.current &&
        !recordingRef.current &&
        !transcribingRef.current &&
        !speakingIdRef.current
      ) {
        scheduleTalkRestart(500);
      }
    });
    return () => sub.remove();
  }, [scheduleTalkRestart]);

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, []);

  const persist = useCallback(
    async (msgs: OraMessage[], temporaryOverride?: boolean) => {
      // Anonymous sessions are never persisted — no account to attach to.
      if (!isSignedIn) return;
      // Temporary chats are never written to the conversation store. A turn
      // passes its captured temporary state so a mid-flight toggle can't flip
      // whether an already-started send gets persisted.
      if ((temporaryOverride ?? temporaryRef.current) === true) return;
      try {
        let convId = conversationId;
        if (!convId) {
          const title = msgs.find((m) => m.role === "user")?.content.slice(0, 60) || "New chat";
          // Scope new chats to the active project (null = standalone/"Recent").
          const created = await createConversation(title, activeProjectIdRef.current);
          convId = created.conversation.id;
          setConversationId(convId);
        }
        await saveConversationMessages(convId, msgs);
      } catch {
        /* persistence is best-effort */
      }
    },
    [conversationId, isSignedIn],
  );

  // ── TRUE realtime (WebRTC) voice — primary Talk-to-Ora transport ──────────
  // Appends a finalized realtime turn into the conversation and persists it,
  // reusing the same message + persist pipeline as typed chat so history and
  // memory rules are unchanged. Realtime turns are already complete when the
  // transcript event fires, so they carry no streaming/pending state.
  const appendRealtimeTurn = useCallback(
    (role: "user" | "assistant", content: string) => {
      const msg: OraMessage = { id: uid(), role, content };
      const nextMsgs = [...messagesRef.current, msg];
      messagesRef.current = nextMsgs;
      setMessages(nextMsgs);
      void persist(nextMsgs, temporaryRef.current);
      scrollToEnd();
    },
    [persist, scrollToEnd],
  );

  // Flip from the realtime transport back to the legacy transcribe -> chat -> tts
  // loop when a live session drops mid-call, surfacing a visible warning. Only
  // acts while Talk mode is still on.
  const handleRealtimeFallback = useCallback(
    (reason: string) => {
      setRealtimeActive(false);
      realtimeActiveRef.current = false;
      if (talkModeRef.current) {
        setVoiceError(reason);
        scheduleTalkRestart(400);
      }
    },
    [scheduleTalkRestart],
  );

  const realtimeVoice = useOraRealtimeVoiceNative({
    onUserTranscript: (t) => appendRealtimeTurn("user", t),
    onAssistantTranscript: (t) => appendRealtimeTurn("assistant", t),
    onFallback: handleRealtimeFallback,
  });
  realtimeVoiceRef.current = realtimeVoice;

  // The realtime session can end on its own — most commonly the hard duration
  // cap (the server can't meter audio after the token is minted). The hook flips
  // to a terminal state but can't touch screen-level Talk state, so clear
  // realtimeActive here; otherwise the LIVE UI and the scheduleTalkRestart
  // suppression leave the user stuck. If they're still in Talk mode, drop to the
  // legacy metered loop so the conversation can continue. The realtimeActiveRef
  // guard means failed/cancelled starts (which never flipped active) are ignored
  // here — those are already handled inline by toggleTalkMode's start() branch.
  const realtimeState = realtimeVoice.state;
  const realtimeOverLimit = realtimeVoice.overLimit;
  useEffect(() => {
    if (
      realtimeState !== "ended" &&
      realtimeState !== "error" &&
      realtimeState !== "permission_denied"
    ) {
      return;
    }
    if (!realtimeActiveRef.current) return;
    setRealtimeActive(false);
    realtimeActiveRef.current = false;
    realtimeStartingRef.current = false;
    if (talkModeRef.current) {
      // Live-voice budget exhausted mid-call: do NOT drop to the legacy metered
      // loop (that would bypass the per-plan voice cap). Exit Talk mode and show
      // the reset time; the user can keep chatting by text.
      if (realtimeOverLimit) {
        setTalkMode(false);
        talkModeRef.current = false;
        setVoiceError(realtimeOverLimit.message);
        return;
      }
      setVoiceError("Live voice session ended. Switched to basic voice mode.");
      scheduleTalkRestart(400);
    }
  }, [realtimeState, realtimeOverLimit, scheduleTalkRestart]);

  const sendMessage = useCallback(
    async (
      text: string,
      attch: Attachment | null,
      opts?: { truncateTo?: number; forceSearch?: boolean },
    ) => {
      if ((!text && !attch) || sending) return;

      // Capture this turn's temporary state so a toggle mid-send can't change
      // whether the resulting transcript is persisted.
      const turnIsTemporary = temporary;

      // Abort any previous in-flight stream before starting a new one.
      streamAbortRef.current?.abort();
      const abortController = new AbortController();
      streamAbortRef.current = abortController;

      const userMsg: OraMessage = {
        id: uid(),
        role: "user",
        content: text,
        ...(attch
          ? {
              hadAttachment: true,
              attachment: {
                filename: attch.filename,
                fileType: attch.fileType,
                isImage: attch.kind === "image",
                isDataset: attch.kind === "dataset",
              },
              // Client-only: lets the bubble show a tappable thumbnail preview.
              ...(attch.kind === "image" && attch.localUri
                ? { attachmentLocalUri: attch.localUri }
                : {}),
            }
          : {}),
      };
      const pendingId = uid();
      const pendingMsg: OraMessage = {
        id: pendingId,
        role: "assistant",
        content: "",
        pending: true,
      };
      // For regenerate, truncate to just before the retried message so history
      // excludes the stale assistant turn and the re-sent user message.
      const base = opts?.truncateTo !== undefined ? messages.slice(0, opts.truncateTo) : messages;
      const history = base
        .filter((m) => !m.pending && !m.error)
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));

      const next = [...base, userMsg, pendingMsg];
      setMessages(next);
      setSending(true);
      scrollToEnd();

      try {
        let assistant: OraMessage;

        if (attch) {
          // Attachment analysis — no streaming on these specialized endpoints.
          const prompt = text || "Please analyze this attachment.";
          if (attch.kind === "image") {
            const res = await analyzeImage(attch.ref, prompt, history);
            assistant = {
              id: pendingId,
              role: "assistant",
              content: res.reply,
              messageKind: "image-analysis",
            };
          } else if (attch.kind === "dataset") {
            const { result } = await analyzeDataset(attch.ref, prompt, history);
            const profile = result.datasetProfile;
            const summary =
              typeof result.summary === "string" && result.summary.trim()
                ? result.summary
                : "Here is what I found in your dataset.";
            assistant = {
              id: pendingId,
              role: "assistant",
              content: summary,
              datasetResult: {
                ...result,
                summary,
                rowCount: profile?.rowCount,
                columnCount: profile?.colCount,
                truncated: result.truncated ?? profile?.truncated,
              },
            };
          } else {
            const res = await analyzeDocument(attch.ref, prompt, history);
            assistant = {
              id: pendingId,
              role: "assistant",
              content: res.reply,
              messageKind: "document-analysis",
            };
          }
        } else {
          // Plain chat — attempt SSE streaming first.
          // Temporary chats force both reference flags off and flag the turn as
          // temporary so the server skips memory recall, summaries, and saves.
          const chatReq: ChatRequest = {
            message: text,
            messages: history,
            mode,
            language: language !== "auto" ? language : undefined,
            timeZone: clientTimeZone(),
            referenceSavedMemories: getReferenceSavedMemories() && !!isSignedIn && !temporary,
            referenceChatHistory: getReferenceChatHistory() && !!isSignedIn && !temporary,
            temporary,
            oraProjectId: activeProjectIdRef.current,
            ...(opts?.forceSearch ? { forceSearch: true } : {}),
            // Carry uploaded document/dataset refs on every chat turn so the
            // server can route uploaded-file edit requests ("make it
            // professional", "add a section…") to the layout-preserving file
            // editor. Without this the backend never learns a file is attached
            // and replies with plain text. Every send path reuses this chatReq
            // (streaming, stream fallback, forceSearch retry, regenerate), so
            // the refs survive all of them. Mirrors the website hook.
            ...(documentRefsRef.current.length > 0
              ? { documentRefs: documentRefsRef.current }
              : {}),
          };

          if (opts?.forceSearch) {
            // "Retry live search" must deterministically re-run the LIVE web-search
            // tool. Search is a non-streaming specialist branch that the stream
            // route only bounces back with a streamingFallback signal, so skip
            // streaming and POST straight to /chat with forceSearch:true. If the
            // forced search still fails the server returns a retryable 503 (handled
            // in catch) instead of repeating the general-knowledge fallback the
            // user just rejected.
            const res = await sendChat(chatReq);
            assistant = {
              id: pendingId,
              role: "assistant",
              content: res.reply,
              viaFallback: true,
              ...buildChatExtras(res),
            };
            if (res.msgCount != null && res.msgLimit != null) {
              setSession((s) =>
                s ? { ...s, msgCount: res.msgCount!, msgLimit: res.msgLimit! } : s,
              );
            }
          } else {
            // Try streaming first; fall back to regular sendChat when unavailable.
            let streamedContent = "";
            const streamResult = await streamChatNative(
              chatReq,
              (delta) => {
                streamedContent += delta;
                const content = streamedContent;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === pendingId ? { ...m, content, isStreaming: true, pending: false } : m,
                  ),
                );
              },
              abortController.signal,
            );

            if (streamResult === null) {
              // Streaming could not start — fall back to regular /chat.
              notifyStreamFallbackCalled();
              const res = await sendChat(chatReq);
              assistant = {
                id: pendingId,
                role: "assistant",
                content: res.reply,
                viaFallback: true,
                ...buildChatExtras(res),
              };
              if (res.msgCount != null && res.msgLimit != null) {
                setSession((s) =>
                  s ? { ...s, msgCount: res.msgCount!, msgLimit: res.msgLimit! } : s,
                );
              }
            } else if (streamResult.ok) {
              // Streaming succeeded — apply final metadata from the done payload.
              // The conversational stream carries suggestions/videos/memory, plus
              // a generated file when the server's false-delivery safety net
              // built one for real (sources/images still come from /chat).
              assistant = {
                id: pendingId,
                role: "assistant",
                content: streamResult.reply || streamedContent,
                isStreaming: false,
                suggestions: streamResult.suggestions,
                videos: streamResult.videos,
                memorySaveCandidate: streamResult.memorySaveCandidate,
                memorySaveCandidateConfidence: streamResult.memorySaveCandidateConfidence,
                memorySaveCandidateSensitive: streamResult.memorySaveCandidateSensitive,
                memoriesUsed: streamResult.memoriesUsed,
                generatedFile: buildGeneratedFile(streamResult),
                ...(streamResult.isRealStreaming === false ? { viaFallback: true } : {}),
              };
              if (streamResult.msgCount != null && streamResult.msgLimit != null) {
                setSession((s) =>
                  s
                    ? { ...s, msgCount: streamResult.msgCount!, msgLimit: streamResult.msgLimit! }
                    : s,
                );
              }
            } else if (!streamResult.firstToken) {
              // Pre-first-token failure — the stream pre-incremented the session.
              // Retry via /chat with the signed fallback token so the server
              // acknowledges the increment without double-charging.
              notifyStreamFallbackCalled();
              const res = await sendChat({
                ...chatReq,
                ...(streamResult.fallbackToken
                  ? { streamFallbackToken: streamResult.fallbackToken }
                  : {}),
              });
              assistant = {
                id: pendingId,
                role: "assistant",
                content: res.reply,
                viaFallback: true,
                ...buildChatExtras(res),
              };
              if (res.msgCount != null && res.msgLimit != null) {
                setSession((s) =>
                  s ? { ...s, msgCount: res.msgCount!, msgLimit: res.msgLimit! } : s,
                );
              }
            } else {
              // Post-first-token interruption — partial content already rendered
              // via onToken callbacks. Keep what the user saw and flag it cut off
              // so a "response was cut off" note renders beneath the partial reply
              // (mirrors the web hook). Do not retry.
              assistant = {
                id: pendingId,
                role: "assistant",
                content: streamedContent,
                isStreaming: false,
                streamCutOff: true,
              };
            }
          }
        }

        const finalMsgs = next.map((m) => (m.id === pendingId ? assistant : m));
        setMessages(finalMsgs);
        scrollToEnd();
        void persist(finalMsgs, turnIsTemporary);
        // Auto-speak in Talk mode or when the user has enabled auto-read
        const shouldSpeakInTalkMode = talkModeRef.current && !talkModeMutedRef.current;
        const shouldSpeakForPreference = !talkModeRef.current && autoReadRef.current;
        if ((shouldSpeakInTalkMode || shouldSpeakForPreference) && assistant.content.trim()) {
          void speakRef.current(assistant);
        } else if (talkModeRef.current && !recordingRef.current) {
          scheduleTalkRestart(700);
        }
      } catch (err) {
        if (abortController.signal.aborted) return;
        const msg = err instanceof Error ? err.message : "Something went wrong. Try again.";
        // A forced "Retry live search" that still failed returns a retryable 503
        // with searchRetryable in the body. Keep the user's message and re-surface
        // the Retry affordance on the error bubble instead of a dead banner.
        const searchRetryable =
          err instanceof ApiRequestError &&
          typeof err.body === "object" &&
          err.body !== null &&
          (err.body as { searchRetryable?: unknown }).searchRetryable === true;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId
              ? {
                  ...m,
                  pending: false,
                  isStreaming: false,
                  error: true,
                  content: msg,
                  ...(searchRetryable ? { searchRetryable: true } : {}),
                }
              : m,
          ),
        );
      } finally {
        setSending(false);
        if (streamAbortRef.current === abortController) {
          streamAbortRef.current = null;
        }
      }
    },
    [
      sending,
      messages,
      mode,
      temporary,
      language,
      scrollToEnd,
      persist,
      scheduleTalkRestart,
      isSignedIn,
    ],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && !attachment) || sending) return;
    const attch = attachment;
    setInput("");
    setAttachment(null);
    await sendMessage(text, attch);
  }, [input, attachment, sending, sendMessage]);

  // Author a brand-new file (csv/xlsx/docx/pdf/pptx) from a prompt via the
  // "Create file" sheet. Mirrors the website Create-file flow: append the user's
  // request and a pending assistant turn, call the dedicated generate-file
  // endpoint (re-hydrating any uploaded source data), then settle the reply with
  // a downloadable generated-file card. Generation is non-streaming.
  const handleGenerateFile = useCallback(
    async (prompt: string, format: FileFormat) => {
      const text = prompt.trim();
      if (!text || sending) return;
      setShowGenerateFile(false);
      setGenerateFileDraft(null);

      const turnIsTemporary = temporary;
      const userMsg: OraMessage = { id: uid(), role: "user", content: text };
      const pendingId = uid();
      const pendingMsg: OraMessage = {
        id: pendingId,
        role: "assistant",
        content: "",
        pending: true,
      };
      const history = messages
        .filter((m) => !m.pending && !m.error)
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));
      const next = [...messages, userMsg, pendingMsg];
      setMessages(next);
      setSending(true);
      scrollToEnd();

      try {
        const res = await generateFile({
          message: text,
          messages: history,
          format,
          language: language !== "auto" ? language : undefined,
          documentRefs: documentRefsRef.current,
        });
        const assistant: OraMessage = {
          id: pendingId,
          role: "assistant",
          content: res.reply,
          ...buildChatExtras(res),
        };
        if (res.msgCount != null && res.msgLimit != null) {
          setSession((s) => (s ? { ...s, msgCount: res.msgCount!, msgLimit: res.msgLimit! } : s));
        }
        const finalMsgs = next.map((m) => (m.id === pendingId ? assistant : m));
        setMessages(finalMsgs);
        scrollToEnd();
        void persist(finalMsgs, turnIsTemporary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Couldn't create that file. Try again.";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId
              ? { ...m, pending: false, isStreaming: false, error: true, content: msg }
              : m,
          ),
        );
      } finally {
        setSending(false);
      }
    },
    [sending, messages, temporary, language, scrollToEnd, persist],
  );

  const handleReviseGeneratedFile = useCallback((file: GeneratedFile) => {
    setGenerateFileDraft({
      prompt: `Revise the ${file.format.toUpperCase()} file "${file.fileName}": `,
      format: file.format,
    });
    setShowGenerateFile(true);
  }, []);

  // Tapping a follow-up suggestion chip sends it as the next message.
  const handleSuggestion = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean || sendingRef.current) return;
    void sendMessageRef.current(clean, null);
  }, []);

  // Persist a memory-save candidate, then mark the message as saved in place.
  // Mobile has no dedicated save-candidate endpoint, so saveOraMemory derives a
  // short title (mirroring the web) and writes through the Ora memories API,
  // returning the titles of any earlier memories this fact superseded so the
  // chip can name exactly what changed. The updated transcript is persisted
  // immediately so the saved/superseded state survives a reload.
  // Refs so the memoized save-memory handler stays stable yet always uses the
  // current persist (correct conversationId) and auth state, even when invoked
  // from a settled bubble that has not re-rendered.
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const isSignedInRef = useRef(isSignedIn);
  isSignedInRef.current = isSignedIn;
  const handleSaveMemory = useCallback(async (message: OraMessage) => {
    // Never write memory from an anonymous or temporary chat.
    if (!isSignedInRef.current || temporaryRef.current) return;
    const fact = message.memorySaveCandidate?.trim();
    if (!fact) return;
    const supersededTitles = await saveOraMemory(fact, activeProjectIdRef.current);
    const next = messagesRef.current.map((m) =>
      m.id === message.id
        ? {
            ...m,
            memorySaved: true,
            memorySaveCandidate: undefined,
            memorySupersededTitles: supersededTitles,
          }
        : m,
    );
    setMessages(next);
    void persistRef.current(next);
  }, []);

  // Regenerate the assistant reply for the user turn that produced `message`.
  const handleRegenerate = useCallback(
    (message: OraMessage) => {
      if (sending) return;
      const idx = messages.findIndex((m) => m.id === message.id);
      if (idx < 0) return;
      let userIdx = -1;
      for (let i = idx - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          userIdx = i;
          break;
        }
      }
      if (userIdx < 0) return;
      // Regenerate replays the user turn as plain text; it cannot reconstruct an
      // attachment, so skip turns whose source message carried one.
      const sourceUser = messages[userIdx];
      if (sourceUser.attachment || sourceUser.hadAttachment || !sourceUser.content.trim()) return;
      void sendMessage(sourceUser.content, null, { truncateTo: userIdx });
    },
    [messages, sending, sendMessage],
  );

  // "Retry live search": replay the user turn but force the LIVE web-search tool
  // (forceSearch:true) instead of a plain regenerate, which would just re-classify
  // and could answer conversationally. Mirrors handleRegenerate's truncation so
  // history excludes the stale answer/error being retried.
  const handleRetrySearch = useCallback(
    (message: OraMessage) => {
      if (sending) return;
      const idx = messages.findIndex((m) => m.id === message.id);
      if (idx < 0) return;
      let userIdx = -1;
      for (let i = idx - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          userIdx = i;
          break;
        }
      }
      if (userIdx < 0) return;
      const sourceUser = messages[userIdx];
      if (sourceUser.attachment || sourceUser.hadAttachment || !sourceUser.content.trim()) return;
      void sendMessage(sourceUser.content, null, { truncateTo: userIdx, forceSearch: true });
    },
    [messages, sending, sendMessage],
  );

  // Repopulate the composer with a user message for quick editing/resending.
  const handleEditMessage = useCallback((message: OraMessage) => {
    setInput(message.content);
  }, []);

  // Share a message's text via the native share sheet.
  const handleShareMessage = useCallback(async (message: OraMessage) => {
    const content = message.content.trim();
    if (!content) return;
    try {
      await Share.share({ message: content });
    } catch {
      /* dismissed or unavailable */
    }
  }, []);

  // Save a message's text as a Markdown file via the native share sheet.
  const handleSaveMessageFile = useCallback(async (message: OraMessage) => {
    const content = message.content.trim();
    if (!content) return;
    try {
      await saveTextAsFile(content, "ora-reply.md", "text/markdown");
    } catch (err) {
      Alert.alert("Couldn't save", err instanceof Error ? err.message : "Something went wrong.");
    }
  }, []);

  const handleExportMessageMarkdown = useCallback(async (message: OraMessage) => {
    try {
      await saveTextAsFile(messageMarkdown(message), "ora-response.md", "text/markdown");
    } catch (err) {
      Alert.alert("Export failed", err instanceof Error ? err.message : "Something went wrong.");
    }
  }, []);

  const handleExportConversationMarkdown = useCallback(async () => {
    try {
      await saveTextAsFile(conversationMarkdown(messages), "ora-conversation.md", "text/markdown");
    } catch (err) {
      Alert.alert("Export failed", err instanceof Error ? err.message : "Something went wrong.");
    }
  }, [messages]);

  const handleExportJson = useCallback(async (message: OraMessage) => {
    try {
      await saveTextAsFile(
        JSON.stringify(message.datasetResult ?? message, null, 2),
        message.datasetResult ? "ora-dataset.json" : "ora-message.json",
        "application/json",
      );
    } catch (err) {
      Alert.alert("Export failed", err instanceof Error ? err.message : "Something went wrong.");
    }
  }, []);

  const handleExportActionPlanCsv = useCallback(async (message: OraMessage) => {
    const csv = datasetActionPlanCsv(message);
    if (!csv) {
      Alert.alert("No action plan", "This response does not include an action-plan table.");
      return;
    }
    try {
      await saveTextAsFile(csv, "ora-action-plan.csv", "text/csv");
    } catch (err) {
      Alert.alert("Export failed", err instanceof Error ? err.message : "Something went wrong.");
    }
  }, []);

  const handleExportWord = useCallback(async (message: OraMessage) => {
    try {
      const file = await exportFile({
        format: "docx",
        title: messageTitle(message),
        content: messageMarkdown(message, { includeDatasetJson: false }),
        filename: "ora-report",
      });
      await saveGeneratedFile(file);
    } catch (err) {
      Alert.alert("Export failed", err instanceof Error ? err.message : "Something went wrong.");
    }
  }, []);

  const handleExportExcel = useCallback(async (message: OraMessage) => {
    try {
      const file = await exportFile({
        format: "xlsx",
        title: messageTitle(message),
        content: messageMarkdown(message, { includeDatasetJson: false }),
        filename: "ora-data",
      });
      await saveGeneratedFile(file);
    } catch (err) {
      Alert.alert("Export failed", err instanceof Error ? err.message : "Something went wrong.");
    }
  }, []);

  const handleExportPresentation = useCallback(async (message: OraMessage) => {
    try {
      const file = await exportFile({
        format: "pptx",
        title: messageTitle(message),
        content: messageMarkdown(message, { includeDatasetJson: false }),
        filename: "ora-presentation",
      });
      await saveGeneratedFile(file);
    } catch (err) {
      Alert.alert("Export failed", err instanceof Error ? err.message : "Something went wrong.");
    }
  }, []);

  const handleExportPdf = useCallback(
    async (message: OraMessage) => {
      const title = messageTitle(message);
      try {
        if (message.datasetResult) {
          const file = await exportFile({
            format: "pdf",
            title,
            content: messageMarkdown(message, { includeDatasetJson: false }),
            filename: "ora-report",
          });
          await saveGeneratedFile(file);
          return;
        }
        await saveHtmlAsPdf(
          reportPdfHtml(
            messages.filter((m) => m.content.trim()),
            title,
          ),
          "ora-report.pdf",
        );
      } catch (err) {
        Alert.alert("Export failed", err instanceof Error ? err.message : "Something went wrong.");
      }
    },
    [messages],
  );

  // Submit an image-edit instruction via the /images/:id/edit polling flow.
  const handleEditImage = useCallback(async () => {
    const id = editingImageId;
    const instr = editInstruction.trim();
    if (!id || !instr || editingImage || sending) return;
    const sourceImageMeta = messagesRef.current.find((m) => m.imageId === id)?.imageMeta;
    setEditingImage(true);
    setEditInstruction("");
    setEditingImageId(null);

    const userMsg: OraMessage = {
      id: `${Date.now()}-edit-user`,
      role: "user",
      content: `Edit image: ${instr}`,
    };
    const loadingMsg: OraMessage = {
      id: `${Date.now()}-edit-loading`,
      role: "assistant",
      content: "",
      pending: true,
    };
    setMessages((prev) => [...prev, userMsg, loadingMsg]);

    try {
      const { displayUrl, newImageId } = await editImage(id, instr);
      setMessages((prev) => [
        ...prev.slice(0, -1),
        {
          id: `${Date.now()}-edit-result`,
          role: "assistant" as const,
          content: "Here's the edited image. Tap Edit to refine it further.",
          imageUrl: displayUrl,
          imageId: newImageId,
          editInstruction: instr,
          ...(sourceImageMeta ? { imageMeta: sourceImageMeta } : {}),
        } satisfies OraMessage,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Image edit failed.";
      setMessages((prev) => [
        ...prev.slice(0, -1),
        {
          id: `${Date.now()}-edit-err`,
          role: "assistant",
          content: msg,
          error: true,
        },
      ]);
    } finally {
      setEditingImage(false);
    }
  }, [editingImageId, editInstruction, editingImage, sending]);

  const startRecording = useCallback(async () => {
    if (recording || transcribing) return;
    setVoiceError(null);
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        const msg =
          "Ora needs microphone access to record voice input. Enable microphone permission in your device Settings to use voice.";
        setVoiceError(msg);
        Alert.alert("Microphone access needed", msg, [{ text: "OK" }]);
        // A denied permission can't be retried automatically — leave Talk mode
        // so the user lands back on the composer instead of a stalled panel.
        if (talkModeRef.current) {
          cancelTalkRestart();
          setTalkMode(false);
          talkModeRef.current = false;
        }
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
      setRecording(false);
      const msg = "Couldn't start recording. Please check your microphone and try again.";
      setVoiceError(msg);
      Alert.alert("Recording failed", msg, [{ text: "OK" }]);
      // Recording hardware is unavailable — exit Talk mode to avoid a retry loop.
      if (talkModeRef.current) {
        cancelTalkRestart();
        setTalkMode(false);
        talkModeRef.current = false;
      }
    }
  }, [recording, transcribing, recorder, cancelTalkRestart]);

  const stopRecording = useCallback(async () => {
    if (!recording) return;
    setRecording(false);
    setTranscribing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Talk mode keeps the conversation going (resume listening) and shows the
    // error inline in the panel; normal dictation surfaces a blocking Alert.
    // Both set the shared voiceError banner so no failure path stays silent.
    const reportTranscribeFailure = (msg: string) => {
      setVoiceError(msg);
      if (talkModeRef.current) {
        scheduleTalkRestart(700);
      } else {
        Alert.alert("Transcription failed", msg, [{ text: "OK" }]);
      }
    };
    try {
      await recorder.stop();
      // Never reset to the playback-only category while a realtime voice session
      // is starting or live — that stomps the WebRTC capture session and the mic
      // goes silent. The realtime hook owns the audio mode in that case.
      if (!realtimeStartingRef.current && !realtimeActiveRef.current) {
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      }
      const uri = recorder.uri;
      if (!uri) {
        reportTranscribeFailure("Couldn't capture any audio. Please try again.");
        return;
      }
      const text = await transcribeAudio(uri, "m4a", voiceLang);
      const clean = text.trim();
      if (clean) {
        setVoiceError(null);
        if (talkModeRef.current) {
          // Talk mode: auto-send without putting in input field for editing
          void sendMessageRef.current(clean, null);
        } else {
          // Normal dictation: fill the input so the user can review/edit before sending
          setInput((prev) => (prev.trim() ? `${prev.trim()} ${clean}` : clean));
          inputRef.current?.focus();
        }
      } else {
        // Empty transcript means nothing was understood — treat as a failure.
        reportTranscribeFailure("Couldn't transcribe your audio. Please try again.");
      }
    } catch {
      reportTranscribeFailure("Couldn't transcribe your audio. Please try again.");
    } finally {
      setTranscribing(false);
    }
  }, [recording, recorder, voiceLang, scheduleTalkRestart]);

  const speak = useCallback(
    async (message: OraMessage) => {
      try {
        playerRef.current?.remove();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      if (speakingId === message.id) {
        setSpeakingId(null);
        return;
      }
      setSpeakingId(message.id);
      const gen = speakGenRef.current;
      try {
        // Strip markdown so the voice sounds natural (no "hashtag hashtag" etc.)
        const spokenText = cleanForTts(message.content) || message.content;
        const dataUri = await synthesizeSpeech(spokenText, "nova", voiceLang);
        const base64 = dataUri.split(",")[1] ?? "";
        const fileUri = `${FileSystem.cacheDirectory}ora-tts-${Date.now()}.mp3`;
        await FileSystem.writeAsStringAsync(fileUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        // Skip while realtime voice owns the session (see stopRecording note).
        if (!realtimeStartingRef.current && !realtimeActiveRef.current) {
          await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
        }
        // The app was backgrounded mid-synthesis — abort instead of starting
        // playback after the user has already left.
        if (speakGenRef.current !== gen) {
          setSpeakingId((cur) => (cur === message.id ? null : cur));
          // Synthesis was aborted by an AppState change. If Talk mode is still
          // active (a transient `inactive` peek, not a real backgrounding — the
          // background handler clears talkMode), keep the loop alive so the next
          // turn can listen again instead of stalling silently.
          if (talkModeRef.current && !recordingRef.current) {
            scheduleTalkRestart(700);
          }
          return;
        }
        const player = createAudioPlayer({ uri: fileUri });
        playerRef.current = player;
        player.addListener("playbackStatusUpdate", (status) => {
          if (status.didJustFinish) {
            setSpeakingId((cur) => (cur === message.id ? null : cur));
            try {
              player.remove();
            } catch {
              /* ignore */
            }
            if (playerRef.current === player) playerRef.current = null;
            // In Talk mode: automatically start listening for the next turn
            if (talkModeRef.current && !recordingRef.current) {
              scheduleTalkRestart(700);
            }
          }
        });
        player.play();
      } catch {
        setSpeakingId((cur) => (cur === message.id ? null : cur));
        // Even on TTS failure, keep the conversation going in Talk mode
        if (talkModeRef.current && !recordingRef.current) {
          scheduleTalkRestart(700);
        }
      }
    },
    [scheduleTalkRestart, speakingId, voiceLang],
  );

  const speakRef = useRef(speak);
  speakRef.current = speak;
  const autoReadRef = useRef(autoReadReplies);
  autoReadRef.current = autoReadReplies;
  // Stable refs so async callbacks (TTS listener, stopRecording) always see
  // the latest function/state without stale closure captures.
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  startRecordingRef.current = startRecording;
  const stopRecordingRef = useRef(stopRecording);
  stopRecordingRef.current = stopRecording;
  recordingRef.current = recording;

  const autoStopTalkRecording = useCallback(() => {
    if (talkModeRef.current && recordingRef.current) {
      void stopRecordingRef.current();
    }
  }, []);

  const doUpload = useCallback(
    async (
      file: { uri: string; name: string; type: string; size?: number | null },
      isImage: boolean,
    ) => {
      setUploading(true);
      try {
        const size = await getLocalFileSize(file.uri, file.size);
        if (size !== null && size > MAX_UPLOAD_BYTES) {
          setAttachment(null);
          Alert.alert(
            "File too large",
            "Files must be 100 MB or smaller. Please choose a smaller file.",
          );
          return;
        }
        const res = await uploadFile({ uri: file.uri, name: file.name, type: file.type });
        const ref = res.imageRef ?? res.fileRef;
        if (!ref) throw new Error("Upload failed");
        const kind = attachmentKind(res.fileType, isImage || res.kind === "image");
        // Remember document/dataset refs so a later "Create file" can build from
        // the user's real uploaded data. Images carry no extractable text, so
        // they're excluded. Keep the 5 most recent (server cap), newest first.
        if (kind === "document" || kind === "dataset") {
          documentRefsRef.current = [
            ref,
            ...documentRefsRef.current.filter((r) => r !== ref),
          ].slice(0, 5);
        }
        setAttachment({
          ref,
          kind,
          filename: res.filename ?? file.name,
          fileType: res.fileType,
          // Keep the picked image's local URI so the sent bubble can render a
          // tappable thumbnail + full-screen preview without re-downloading.
          ...(kind === "image" ? { localUri: file.uri } : {}),
        });
      } catch (err) {
        setAttachment(null);
        logError("upload", "File upload failed", err, { isImage });
        const message =
          err instanceof ApiRequestError || err instanceof NetworkError
            ? err.message
            : "Could not upload that file. Please try again.";
        Alert.alert("Upload failed", message);
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const handleCameraCapture = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission needed", "Camera access is required to take photos.");
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.8 });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      await doUpload(
        {
          uri: asset.uri,
          name: asset.fileName ?? `photo_${Date.now()}.jpg`,
          type: asset.mimeType ?? "image/jpeg",
          size: asset.fileSize ?? null,
        },
        true,
      );
    } catch (err) {
      logError("upload", "Camera capture failed", err);
      Alert.alert("Camera unavailable", "Could not open the camera. Please try again.");
    }
  }, [doUpload]);

  const handleGalleryPick = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission needed", "Photo library access is required to choose photos.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      await doUpload(
        {
          uri: asset.uri,
          name: asset.fileName ?? `image_${Date.now()}.jpg`,
          type: asset.mimeType ?? "image/jpeg",
          size: asset.fileSize ?? null,
        },
        true,
      );
    } catch (err) {
      logError("upload", "Gallery pick failed", err);
      Alert.alert(
        "Photo library unavailable",
        "Could not open your photo library. Please try again.",
      );
    }
  }, [doUpload]);

  const handleBrowseFiles = useCallback(async () => {
    let picked: DocumentPicker.DocumentPickerResult;
    try {
      picked = await DocumentPicker.getDocumentAsync({
        type: [
          "image/*",
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "text/csv",
          "text/plain",
          "application/zip",
          "application/x-zip-compressed",
        ],
        copyToCacheDirectory: true,
      });
    } catch (err) {
      logError("upload", "Document picker failed", err);
      Alert.alert("Upload failed", "Could not open the file picker. Please try again.");
      return;
    }
    if (picked.canceled || !picked.assets?.[0]) return;
    const file = picked.assets[0];
    const isImage = (file.mimeType ?? "").startsWith("image/");
    await doUpload(
      {
        uri: file.uri,
        name: file.name,
        type: file.mimeType ?? "application/octet-stream",
        size: file.size ?? null,
      },
      isImage,
    );
  }, [doUpload]);

  // iOS cannot present a native picker (Files, camera, photo library) while the
  // attach menu <Modal> is still animating its dismissal: the presentation
  // silently fails and expo-document-picker's native picking context leaks, so
  // every later attempt instantly rejects with "Could not open the file picker"
  // until the app restarts. Defer the chosen action until the Modal's onDismiss
  // fires (iOS-only callback); Android tears its dialog down synchronously, so
  // the action runs immediately there.
  const pendingPlusMenuActionRef = useRef<(() => void) | null>(null);
  const closePlusMenuThen = useCallback((action: () => void) => {
    setShowPlusMenu(false);
    if (Platform.OS === "ios") {
      pendingPlusMenuActionRef.current = action;
    } else {
      action();
    }
  }, []);
  const handlePlusMenuDismissed = useCallback(() => {
    const action = pendingPlusMenuActionRef.current;
    pendingPlusMenuActionRef.current = null;
    action?.();
  }, []);

  const newChat = useCallback(() => {
    // A live realtime session is bound to the current conversation; switching
    // threads underneath it would mis-persist its transcripts to the new thread,
    // so stop it (and drop Talk mode if it was driving the session).
    stopRealtimeForContextSwitch();
    setMessages([]);
    setConversationId(null);
    setAttachment(null);
    setInput("");
    documentRefsRef.current = [];
  }, [stopRealtimeForContextSwitch]);

  // Toggle temporary mode. Either direction starts a clean conversation so
  // temporary and saved turns never mix in one thread (mirrors the website).
  const toggleTemporary = useCallback(() => {
    // Block toggling during an in-flight send to avoid clearing a live thread.
    if (sending) return;
    // Stop realtime first: the new temporary/saved thread must not inherit the
    // old session's transcripts, and temporary state changes its persistence.
    stopRealtimeForContextSwitch();
    setTemporary((prev) => !prev);
    setMessages([]);
    setConversationId(null);
    setAttachment(null);
    setInput("");
    documentRefsRef.current = [];
  }, [sending, stopRealtimeForContextSwitch]);

  // Header overflow menu: flip the "Voice responses on" preference and persist
  // it, mirroring the website auto-read toggle (settings.autoReadReplies).
  const toggleVoiceResponses = useCallback(() => {
    setAutoReadReplies((prev) => {
      const next = !prev;
      updatePreferences({ autoReadReplies: next }).catch(() => {});
      return next;
    });
    setShowHeaderMenu(false);
  }, []);

  const openMemoryScreen = useCallback(() => {
    setShowHeaderMenu(false);
    router.push("/memory");
  }, [router]);

  // Open (or re-open) a realtime live-voice session and wire the screen-level
  // realtimeActive state to the result. Extracted from toggleTalkMode so the
  // Retry button (shown after a poor-network legacy fallback) can rebuild the
  // session with the exact same connect + fallback handling.
  const beginRealtimeSession = useCallback(() => {
    // Clear any stale fallback warning and stop legacy audio that could fight the
    // realtime AVAudioSession.
    setVoiceError(null);
    setTalkModeMuted(false);
    talkModeMutedRef.current = false;
    if (speakingId) {
      try {
        playerRef.current?.remove();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      setSpeakingId(null);
    }
    const rt = realtimeVoiceRef.current;
    if (rt?.isSupported) {
      // Mark the connect window BEFORE stopping the legacy recorder. stopRecording
      // resets the audio session to the playback-only category, which would stomp
      // the realtime WebRTC capture we are about to open (mic goes silent, Ora
      // never hears the user and never replies). The guard on that reset keys off
      // realtimeStartingRef, so it must be set first. It also lets background /
      // exit / context-switch handlers abort an in-flight start().
      realtimeStartingRef.current = true;
      if (recordingRef.current) void stopRecordingRef.current();
      // Seed the live session with the recent visible conversation so the spoken
      // turn continues in context (seeded client-side as lower-authority items,
      // never injected into the server instructions).
      const recent = messagesRef.current
        .filter((m) => !m.pending && !m.error && m.content.trim())
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));
      const lastUser = [...recent].reverse().find((m) => m.role === "user");
      const myAttempt = ++realtimeStartGenRef.current;
      void rt
        .start({
          language: language !== "auto" ? language : undefined,
          temporary: temporaryRef.current,
          referenceSavedMemories:
            getReferenceSavedMemories() && !!isSignedInRef.current && !temporaryRef.current,
          oraProjectId: activeProjectIdRef.current,
          conversationId,
          message: lastUser?.content,
          history: recent,
          focusMode: focusModeRef.current,
          voicePreset: voicePresetRef.current,
        })
        .then((result) => {
          // A newer start, or a stop / context switch / background teardown, has
          // superseded this attempt. That path already owns (and may have
          // re-minted) the single hook session, so this stale resolution must
          // touch nothing: clearing realtimeStartingRef would arm the legacy
          // recorder under the newer connect, and stop() would kill it. The
          // superseding teardown already stopped this attempt's own session.
          if (realtimeStartGenRef.current !== myAttempt) return;
          realtimeStartingRef.current = false;
          if (!talkModeRef.current) {
            // User left Talk mode while the session was connecting; the exit path
            // already called stop() (which aborts start()), but tear down any
            // session that still managed to complete.
            if (result.started) realtimeVoiceRef.current?.stop();
            return;
          }
          if (result.started) {
            setRealtimeActive(true);
            realtimeActiveRef.current = true;
          } else if (result.overLimit) {
            // Live-voice budget exhausted (or a concurrent session) at connect
            // time: exit Talk mode and show the reset time. Do NOT fall back to
            // the legacy loop (that would bypass the per-plan voice cap).
            setRealtimeActive(false);
            realtimeActiveRef.current = false;
            setTalkMode(false);
            talkModeRef.current = false;
            const ol = realtimeVoiceRef.current?.overLimit;
            setVoiceError(
              ol?.message ??
                "You've used all your live voice time for now. You can keep chatting with Ora by text.",
            );
          } else {
            // Realtime could not start on a capable device — show the reason and
            // drop to the legacy transcribe -> chat -> tts loop.
            setRealtimeActive(false);
            realtimeActiveRef.current = false;
            if (result.reason) setVoiceError(result.reason);
            scheduleTalkRestart(300);
          }
        });
    } else {
      // This build has no realtime native module yet — use the legacy loop
      // silently (no visible warning: it is the pre-existing behavior, and once a
      // WebRTC-enabled build ships, isSupported is always true).
      if (recordingRef.current) void stopRecordingRef.current();
      scheduleTalkRestart(300);
    }
  }, [conversationId, language, scheduleTalkRestart, speakingId]);

  const toggleTalkMode = useCallback(() => {
    const next = !talkMode;
    setTalkMode(next);
    talkModeRef.current = next;
    if (!next) {
      cancelTalkRestart();
      // Exiting Talk mode: stop a realtime session if one is running OR still
      // connecting, so a mid-connect start() can't open the mic after exit.
      stopRealtimeSession();
      // Stop any TTS that is playing.
      if (speakingId) {
        try {
          playerRef.current?.remove();
        } catch {
          /* ignore */
        }
        playerRef.current = null;
        setSpeakingId(null);
      }
      // If the legacy mic is active, stop it (user is leaving voice mode).
      if (recording) void stopRecordingRef.current();
      return;
    }
    // Entering Talk mode: open the realtime session.
    beginRealtimeSession();
  }, [
    beginRealtimeSession,
    cancelTalkRestart,
    recording,
    speakingId,
    stopRealtimeSession,
    talkMode,
  ]);

  // Retry live voice after a poor-network legacy fallback: re-open the realtime
  // session from scratch (start() resets the single-attempt reconnect budget).
  const retryRealtimeVoice = useCallback(() => {
    if (!talkModeRef.current) {
      setTalkMode(true);
      talkModeRef.current = true;
    }
    beginRealtimeSession();
  }, [beginRealtimeSession]);

  const interruptTalkMode = useCallback(() => {
    try {
      playerRef.current?.remove();
    } catch {
      /* ignore */
    }
    playerRef.current = null;
    setSpeakingId(null);
    if (talkModeRef.current && !recordingRef.current) {
      scheduleTalkRestart(250);
    }
  }, [scheduleTalkRestart]);

  const toggleTalkModeMute = useCallback(() => {
    const next = !talkModeMuted;
    setTalkModeMuted(next);
    talkModeMutedRef.current = next;
    if (next && speakingId) {
      interruptTalkMode();
    }
  }, [interruptTalkMode, speakingId, talkModeMuted]);

  const openConversations = useCallback(async () => {
    if (!isSignedIn) {
      Alert.alert("Sign in required", "Sign in to save conversations and access your history.", [
        { text: "OK" },
      ]);
      return;
    }
    setShowConversations(true);
    setLoadingConversations(true);
    // Load conversations and projects independently so one failing endpoint
    // does not blank the other list.
    const [convs, projs] = await Promise.allSettled([
      listConversations({ limit: 100 }),
      listProjects(),
    ]);
    setConversations(convs.status === "fulfilled" ? convs.value : []);
    if (projs.status === "fulfilled") {
      projectsLoadedRef.current = true;
      setProjects(projs.value);
    }
    setLoadingConversations(false);
  }, [isSignedIn]);

  // Refresh just the project + conversation lists (after create/rename/delete)
  // without reopening or toggling the loading state.
  const refreshChatLists = useCallback(async () => {
    const [convs, projs] = await Promise.allSettled([
      listConversations({ limit: 100 }),
      listProjects(),
    ]);
    if (convs.status === "fulfilled") setConversations(convs.value);
    if (projs.status === "fulfilled") {
      projectsLoadedRef.current = true;
      setProjects(projs.value);
    }
  }, []);

  const searchChatLists = useCallback(async (query: string) => {
    const q = query.trim() || undefined;
    const convs = await listConversations({ q, limit: 100 });
    setConversations(convs);
  }, []);

  const loadConversation = useCallback(
    async (id: number) => {
      setShowConversations(false);
      // Switching to a different saved conversation must stop a live realtime
      // session bound to the old thread, or its transcripts persist to the wrong
      // conversation; drop Talk mode too if it was driving the session.
      stopRealtimeForContextSwitch();
      // Opening a saved conversation always exits temporary mode.
      setTemporary(false);
      // Uploaded-file refs are session-scoped to the prior thread; drop them so a
      // "Create file" in this conversation never reuses a stale ref.
      documentRefsRef.current = [];
      try {
        const detail = await getConversation(id);
        setConversationId(id);
        // Sync last-active to server settings (fire-and-forget).
        void patchOraUserSettings({ lastConversationId: id }).catch(() => {});
        // Follow the loaded chat's scope so a subsequent "new chat" stays in the
        // same project (mirrors the website's route-as-source-of-truth).
        setActiveProjectId(detail.projectId ?? null);
        setMessages(
          (detail.messages ?? []).map((m) => ({
            ...m,
            id: m.id || uid(),
          })),
        );
        scrollToEnd();
      } catch {
        /* ignore */
      }
    },
    [scrollToEnd, stopRealtimeForContextSwitch],
  );

  const removeConversation = useCallback(
    async (id: number) => {
      try {
        await deleteConversation(id);
        setConversations((prev) => prev.filter((x) => x.id !== id));
        if (id === conversationId) newChat();
      } catch {
        /* ignore */
      }
    },
    [conversationId, newChat],
  );

  // Start a fresh chat scoped to a project (id) or standalone (null). Closes the
  // drawer so the user lands on the composer with the new scope active.
  const startChatInScope = useCallback(
    (projectId: number | null) => {
      setActiveProjectId(projectId);
      setTemporary(false);
      newChat();
      setShowConversations(false);
    },
    [newChat],
  );

  // Select a project as the active scope without starting a chat or closing the
  // drawer, so the user can then browse its chats or start a new one. Mirrors
  // "entering" a project on the website (route becomes source of truth there).
  const selectProjectScope = useCallback((projectId: number) => {
    setActiveProjectId(projectId);
  }, []);

  // ── Drawer → chat bridge ──────────────────────────────────────────────────
  // On a clean signed-in launch, restore the last active Ora conversation saved
  // by the website/mobile settings endpoint. Explicit drawer/project selections
  // still win because pendingConversationId is handled below.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    if (lastActiveRestoreAttemptedRef.current) return;
    if (pendingConversationId != null || conversationId != null || messagesRef.current.length > 0)
      return;
    lastActiveRestoreAttemptedRef.current = true;
    void getOraUserSettings()
      .then((settings) => {
        if (settings.lastConversationId != null) {
          void loadConversation(settings.lastConversationId);
        }
      })
      .catch(() => {});
  }, [conversationId, isLoaded, isSignedIn, loadConversation, pendingConversationId]);

  // When the sidebar taps a conversation, load it here and clear the pending id.
  useEffect(() => {
    if (pendingConversationId != null) {
      loadConversation(pendingConversationId);
      setPendingConversationId(null);
    }
  }, [pendingConversationId, loadConversation, setPendingConversationId]);

  // When the sidebar triggers "New conversation" (or selects a project), start
  // a fresh chat. The tick is 0 on mount so the initial render never fires.
  useEffect(() => {
    if (newConversationTick > 0) {
      newChat();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newConversationTick]);
  // ─────────────────────────────────────────────────────────────────────────

  const openCreateProject = useCallback(() => {
    setEditingProject(null);
    setProjectEditorOpen(true);
  }, []);

  const openRenameProject = useCallback((project: OraProjectSummary) => {
    setEditingProject(project);
    setProjectEditorOpen(true);
  }, []);

  // Save the project editor: rename when editing an existing project, otherwise
  // create a new one and immediately make it the active scope for a new chat.
  const handleSaveProject = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        if (editingProject) {
          await renameProject(editingProject.id, trimmed);
          await refreshChatLists();
        } else {
          const created = await createProject(trimmed);
          await refreshChatLists();
          startChatInScope(created.id);
        }
      } catch {
        Alert.alert("Couldn't save project", "Please try again.");
      } finally {
        setProjectEditorOpen(false);
        setEditingProject(null);
      }
    },
    [editingProject, refreshChatLists, startChatInScope],
  );

  // Delete a project. The server detaches its conversations (they become
  // standalone), so we only reset local scope and refresh the lists.
  const handleDeleteProject = useCallback(
    (project: OraProjectSummary) => {
      Alert.alert(
        "Delete project?",
        `"${project.name}" will be removed. Its chats are kept and moved to Recent.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => {
              void (async () => {
                try {
                  await deleteProject(project.id);
                  if (activeProjectIdRef.current === project.id) setActiveProjectId(null);
                  await refreshChatLists();
                } catch {
                  Alert.alert("Couldn't delete project", "Please try again.");
                }
              })();
            },
          },
        ],
      );
    },
    [refreshChatLists],
  );

  // Move a conversation to a project or back to standalone ("Recent"), mirroring
  // the website's per-conversation "Move to" menu. If the active chat is moved,
  // follow its new scope so a subsequent "new chat" stays consistent.
  const handleMoveConversation = useCallback(
    async (conversationToMoveId: number, projectId: number | null) => {
      setMoveTarget(null);
      try {
        await moveConversation(conversationToMoveId, projectId);
        if (conversationToMoveId === conversationId) setActiveProjectId(projectId);
        await refreshChatLists();
      } catch {
        Alert.alert("Couldn't move chat", "Please try again.");
      }
    },
    [conversationId, refreshChatLists],
  );

  // Mirrors website: deepAllowed = tier === "core" || tier === "wave"
  // Free / anonymous users are gated to Instant mode only.
  const deepAllowed = session?.tier === "core" || session?.tier === "wave";

  // Tier-specific accent color — mirrors website's --ora-accent-hsl CSS var on the panel root.
  // Used for Ora-specific active states (mode indicator, language selector, temp/talk toggles).
  // When the session/tier has not loaded, fall back to the FREE accent (purple) to match the
  // website's free-tier accent and OraAtom's default — never the theme's teal accentForeground.
  const tierAccent = tierAccentColor(session?.tier);

  // Reset to Instant if tier drops and Deep is active (e.g. plan downgrade)
  useEffect(() => {
    if (!deepAllowed && mode === "deep") setMode("instant");
  }, [deepAllowed, mode]);

  const activeProjectName = activeProjectId
    ? (projects.find((p) => p.id === activeProjectId)?.name ?? "Project")
    : null;

  // ── Talk-mode status (realtime vs legacy loop) ────────────────────────────
  const realtimeOn = realtimeActive;
  const rtState = realtimeVoice.state;
  // Mute + interrupt are driven by the realtime hook while a live session runs,
  // and by the legacy loop otherwise.
  const talkMuted = realtimeOn ? realtimeVoice.isMuted : talkModeMuted;
  const showInterrupt = realtimeOn
    ? rtState === "speaking" || rtState === "thinking"
    : !!speakingId;
  const onInterruptPress = realtimeOn ? realtimeVoice.interrupt : interruptTalkMode;
  const onMutePress = realtimeOn ? realtimeVoice.toggleMute : toggleTalkModeMute;
  const realtimeInterim =
    realtimeVoice.interimAssistantTranscript || realtimeVoice.interimUserTranscript;

  // Talk-card live state booleans (mirror website OraRealtimeConvView).
  const talkListening = realtimeOn ? rtState === "listening" : recording;
  const talkConnecting = realtimeOn && rtState === "connecting";
  const talkThinking = realtimeOn ? rtState === "thinking" : sending || transcribing;
  const talkSpeaking = realtimeOn ? rtState === "speaking" : !!speakingId;
  const talkAnimated = talkListening || talkConnecting || talkThinking || talkSpeaking;

  const talkStatusTitle = realtimeOn
    ? rtState === "connecting"
      ? "Connecting…"
      : rtState === "thinking"
        ? "Ora is thinking…"
        : rtState === "speaking"
          ? "Ora is speaking…"
          : rtState === "listening"
            ? "Listening…"
            : "Live voice active"
    : sending
      ? "Ora is thinking"
      : speakingId
        ? "Ora is speaking"
        : transcribing
          ? "Transcribing"
          : recording
            ? "Listening"
            : "Voice mode active";

  const talkStatusSubtitle = realtimeOn
    ? rtState === "connecting"
      ? "Setting up a live voice connection…"
      : talkMuted
        ? "Muted — Ora can still hear you"
        : rtState === "speaking"
          ? realtimeInterim || "Tap interrupt to jump in"
          : rtState === "thinking"
            ? "Preparing a spoken reply…"
            : realtimeVoice.interimUserTranscript
              ? `"${realtimeVoice.interimUserTranscript}"`
              : "Speak naturally — Ora listens as you talk"
    : talkModeMuted
      ? "Muted - replies stay on screen"
      : sending
        ? "Preparing reply..."
        : speakingId
          ? "Tap interrupt to speak"
          : transcribing
            ? "Turning speech into text..."
            : recording
              ? "Speak naturally - Ora answers when you pause"
              : "Tap the mic or wait for Ora to listen";

  // Header subtitle mirrors the website's transient status line: it only shows
  // while Ora is busy, and is blank otherwise (no usage counter in the header).
  const headerStatus = sending
    ? "Thinking…"
    : speakingId
      ? "Speaking…"
      : transcribing
        ? "Transcribing…"
        : recording
          ? "Listening…"
          : undefined;

  // Loading-row parity with the website (ora-panel.tsx `isLoading &&
  // !isStreamingWithContent`): never render a blank assistant bubble while
  // waiting for the first token. Skip empty pending/streaming assistant rows and
  // show a separate atom + pulsing-dots + "Thinking…" row instead.
  const streamingWithContent = messages.some(
    (m) => m.role === "assistant" && m.isStreaming && (m.content ?? "").trim().length > 0,
  );
  const visibleMessages = messages.filter(
    (m) =>
      !(
        m.role === "assistant" &&
        (m.pending || m.isStreaming) &&
        (m.content ?? "").trim().length === 0
      ),
  );
  const showThinkingRow = sending && !streamingWithContent;

  // The most recent settled assistant message is the only one eligible for the
  // Regenerate action (mirrors ChatGPT, which only regenerates the last reply).
  let lastAssistantId: string | null = null;
  let lastAssistantRegenerable = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && !m.pending && !m.isStreaming && !m.error) {
      lastAssistantId = m.id;
      // Regenerate replays the preceding user turn as plain text, so only allow
      // it when that turn was text-only (no attachment to reconstruct).
      for (let j = i - 1; j >= 0; j--) {
        if (messages[j].role === "user") {
          lastAssistantRegenerable =
            !messages[j].attachment && !messages[j].hadAttachment && !!messages[j].content.trim();
          break;
        }
      }
      break;
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader
        title="Ora"
        leftNode={<OraMenuLogo />}
        titleNode={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
            <OraAtom size={28} accentColor={tierAccent} animated />
            <Text
              style={{
                color: c.foreground,
                fontFamily: "Inter_600SemiBold",
                fontSize: 14,
                letterSpacing: -0.2,
              }}
            >
              Ora
            </Text>
            {isSignedIn && session?.tier ? (
              <View
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: tierAccentColor(session.tier),
                  backgroundColor: tierAccentColor(session.tier) + "20",
                }}
              >
                <Text
                  style={{
                    color: tierAccentColor(session.tier),
                    fontSize: 10,
                    fontFamily: "Inter_500Medium",
                  }}
                >
                  {tierLabel(session.tier)}
                </Text>
              </View>
            ) : !isSignedIn ? (
              <View
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: c.border,
                }}
              >
                <Text
                  style={{ color: c.mutedForeground, fontSize: 10, fontFamily: "Inter_500Medium" }}
                >
                  Free · No sign-in required
                </Text>
              </View>
            ) : null}
            {temporary && (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 3,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: tierAccent,
                  backgroundColor: tierAccent + "20",
                }}
              >
                <Ghost size={11} color={tierAccent} />
                <Text style={{ color: tierAccent, fontSize: 10, fontFamily: "Inter_500Medium" }}>
                  Temporary
                </Text>
              </View>
            )}
          </View>
        }
        subtitle={headerStatus}
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <OraVoiceOrb
              active={talkMode}
              listening={realtimeOn ? rtState === "listening" : recording}
              speaking={
                realtimeOn ? rtState === "speaking" || rtState === "thinking" : !!speakingId
              }
              onPress={toggleTalkMode}
            />
            {messages.length > 0 && (
              <Pressable
                onPress={() => void handleExportConversationMarkdown()}
                hitSlop={8}
                style={{ padding: 4 }}
                accessibilityLabel="Export conversation"
              >
                <Download size={20} color={c.foreground} />
              </Pressable>
            )}
            <Pressable
              onPress={() => setShowHeaderMenu(true)}
              hitSlop={8}
              style={{ padding: 4 }}
              accessibilityLabel="More options"
            >
              <MoreHorizontal size={22} color={c.foreground} />
            </Pressable>
            <OraThemeToggle />
          </View>
        }
      />

      {temporary && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 16,
            paddingVertical: 8,
            backgroundColor: c.muted,
            borderBottomWidth: 1,
            borderBottomColor: c.border,
          }}
        >
          <Ghost size={14} color={c.mutedForeground} />
          <Text style={{ color: c.mutedForeground, fontSize: 12, flex: 1 }}>
            Temporary chat — saved memories and history are off, and nothing here is saved.
          </Text>
        </View>
      )}

      {!temporary && activeProjectName && (
        <Pressable
          onPress={openConversations}
          accessibilityRole="button"
          accessibilityLabel={`Project ${activeProjectName}. Open chats`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 16,
            paddingVertical: 8,
            backgroundColor: c.muted,
            borderBottomWidth: 1,
            borderBottomColor: c.border,
          }}
        >
          <Folder size={14} color={c.mutedForeground} />
          <Text style={{ color: c.mutedForeground, fontSize: 12, flex: 1 }} numberOfLines={1}>
            New chats save to {activeProjectName}
          </Text>
        </Pressable>
      )}

      {sessionSyncError === "token_unavailable" && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 16,
            paddingVertical: 10,
            backgroundColor: "rgba(239,67,67,0.08)",
            borderBottomWidth: 1,
            borderBottomColor: "rgba(239,67,67,0.3)",
          }}
        >
          <AlertCircle size={14} color="#f87171" />
          <Text style={{ color: "#f87171", fontSize: 12, flex: 1 }}>
            Sign-in token unavailable. Ora is paused to protect your plan — tap to retry.
          </Text>
          <Pressable
            onPress={() => {
              setSessionSyncError(null);
              getOraSession()
                .then((s) => {
                  setSession(s);
                  setCurrentSessionTier(s.tier ?? null, !!s.isPaid);
                })
                .catch((err) => {
                  if (err instanceof TokenUnavailableError) {
                    setSessionSyncError("token_unavailable");
                  } else {
                    setSession(null);
                    setCurrentSessionTier(null);
                  }
                });
            }}
            hitSlop={8}
            style={{ padding: 4 }}
          >
            <RefreshCw size={14} color="#f87171" />
          </Pressable>
        </View>
      )}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={insets.top + 44}
      >
        <FlatList
          ref={listRef}
          data={visibleMessages}
          keyExtractor={(m) => m.id}
          extraData={`${speakingId ?? ""}|${tierAccent}`}
          removeClippedSubviews={Platform.OS === "android"}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 24,
            paddingBottom: 32,
            gap: 24,
            flexGrow: 1,
          }}
          onContentSizeChange={scrollToEnd}
          ListFooterComponent={
            showThinkingRow ? <OraThinkingRow accentColor={tierAccent} label="Thinking…" /> : null
          }
          ListEmptyComponent={
            <View
              style={{
                flex: 1,
                justifyContent: "center",
                alignItems: "center",
                paddingHorizontal: 24,
              }}
            >
              <OraAtom size={52} accentColor={tierAccent} animated style={{ marginBottom: 20 }} />
              <Text
                style={{
                  color: c.foreground,
                  fontFamily: "Inter_700Bold",
                  fontSize: 24,
                  letterSpacing: -0.6,
                  textAlign: "center",
                }}
              >
                Hi, I&apos;m <Text style={{ color: tierAccent }}>Ora</Text>
              </Text>
              <Text
                style={{
                  color: c.mutedForeground,
                  fontFamily: "Inter_400Regular",
                  fontSize: 14,
                  lineHeight: 23,
                  textAlign: "center",
                  marginTop: 10,
                  maxWidth: 448,
                }}
              >
                Ask anything, think things through, or get work done — planning, strategy, files,
                images, and more, all in one chat.
              </Text>
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 8,
                  justifyContent: "center",
                  marginTop: 28,
                }}
              >
                {EXAMPLE_CHIPS.map((chip) => (
                  <Pressable
                    key={chip}
                    onPress={() => {
                      if (!sending) void sendMessage(chip, null);
                    }}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: c.border + "99",
                      backgroundColor: "transparent",
                    }}
                  >
                    <Text
                      style={{
                        color: c.mutedForeground,
                        fontSize: 12,
                        fontFamily: "Inter_400Regular",
                      }}
                    >
                      {chip}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          }
          renderItem={({ item }) => (
            <MessageBubble
              message={item}
              accentColor={tierAccent}
              speaking={speakingId === item.id}
              onSpeak={() => speakRef.current(item)}
              onSuggestion={handleSuggestion}
              onSaveMemory={!temporary && getAutoSaveMemories() ? handleSaveMemory : undefined}
              onLongPress={() => setActionsMessage(item)}
              onEditImage={(id) => {
                setEditingImageId(id);
                setEditInstruction("");
              }}
              onImagePreview={openImagePreview}
              onRetrySearch={handleRetrySearch}
              onReviseFile={handleReviseGeneratedFile}
              isLatest={item.id === messages.at(-1)?.id}
            />
          )}
        />

        {/* Composer */}
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: c.border,
            backgroundColor: c.background,
            paddingHorizontal: 12,
            paddingTop: 10,
            paddingBottom: insets.bottom + 10,
            gap: 10,
          }}
        >
          {editingImageId !== null && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                backgroundColor: c.card,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 8,
              }}
            >
              <Pencil size={14} color={c.accentForeground} />
              <TextInput
                value={editInstruction}
                onChangeText={setEditInstruction}
                placeholder="Describe your edit…"
                placeholderTextColor={c.mutedForeground}
                style={{
                  flex: 1,
                  color: c.foreground,
                  fontSize: 14,
                  fontFamily: "Inter_400Regular",
                }}
                returnKeyType="send"
                onSubmitEditing={handleEditImage}
                autoFocus
              />
              {editingImage ? (
                <ActivityIndicator size="small" color={c.accentForeground} />
              ) : (
                <Pressable
                  onPress={handleEditImage}
                  disabled={!editInstruction.trim()}
                  hitSlop={8}
                  style={{ opacity: editInstruction.trim() ? 1 : 0.4 }}
                >
                  <ArrowUp size={18} color={c.accentForeground} />
                </Pressable>
              )}
              <Pressable
                onPress={() => {
                  setEditingImageId(null);
                  setEditInstruction("");
                }}
                hitSlop={8}
              >
                <X size={16} color={c.mutedForeground} />
              </Pressable>
            </View>
          )}

          {attachment && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                alignSelf: "flex-start",
                backgroundColor: c.muted,
                borderRadius: 999,
                paddingVertical: 6,
                paddingHorizontal: 12,
              }}
            >
              {attachment.kind === "image" ? (
                <ImageIcon size={14} color={c.accentForeground} />
              ) : (
                <FileText size={14} color={c.accentForeground} />
              )}
              <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13, maxWidth: 200 }}>
                {attachment.filename}
              </Text>
              <Pressable onPress={() => setAttachment(null)} hitSlop={8}>
                <X size={14} color={c.mutedForeground} />
              </Pressable>
            </View>
          )}

          {/* Voice error banner — shown above the composer in both normal and
              Talk modes so mic/transcription failures are never silent. */}
          {voiceError && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: c.destructive + "55",
                backgroundColor: c.destructive + "15",
              }}
            >
              <AlertCircle size={15} color={c.destructive} />
              <Text
                style={{
                  flex: 1,
                  color: c.destructive,
                  fontSize: 12,
                  fontFamily: "Inter_500Medium",
                }}
              >
                {voiceError}
              </Text>
              {realtimeVoice.networkQuality === "legacy" && realtimeVoice.isSupported && (
                <Pressable
                  onPress={retryRealtimeVoice}
                  hitSlop={6}
                  style={{
                    borderWidth: 1,
                    borderColor: tierAccent + "59",
                    borderRadius: 10,
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                  }}
                >
                  <Text
                    style={{ color: tierAccent, fontSize: 12, fontFamily: "Inter_600SemiBold" }}
                  >
                    Retry
                  </Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => setVoiceError(null)}
                accessibilityLabel="Dismiss voice error"
                hitSlop={8}
              >
                <X size={14} color={c.destructive} />
              </Pressable>
            </View>
          )}

          {talkMode ? (
            /* ── Talk to Ora live card — mirrors website OraRealtimeConvView ── */
            <View
              style={{
                borderWidth: 1,
                borderColor: tierAccent + "4d",
                borderRadius: 16,
                backgroundColor: tierAccent + "0f",
                paddingHorizontal: 16,
                paddingVertical: 14,
                gap: 14,
              }}
            >
              {/* Status row: waveform · (LIVE + title / subtitle) · live dot */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <OraWaveBars
                  animated={talkAnimated}
                  color={talkListening ? VOICE_LISTEN_RED : tierAccent}
                  scale={1.1}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    {realtimeOn && (
                      <View
                        style={{
                          backgroundColor: tierAccent + "26",
                          borderRadius: 4,
                          paddingHorizontal: 6,
                          paddingVertical: 2,
                        }}
                      >
                        <Text
                          style={{
                            color: tierAccent,
                            fontSize: 9,
                            fontFamily: "Inter_700Bold",
                            letterSpacing: 0.5,
                          }}
                        >
                          LIVE
                        </Text>
                      </View>
                    )}
                    <Text
                      style={{
                        color: c.foreground,
                        fontFamily: "Inter_600SemiBold",
                        fontSize: 15,
                        flexShrink: 1,
                      }}
                      numberOfLines={1}
                    >
                      {talkStatusTitle}
                    </Text>
                  </View>
                  <Text
                    style={{
                      color: c.mutedForeground,
                      fontSize: 12,
                      fontStyle:
                        talkListening && realtimeVoice.interimUserTranscript ? "italic" : "normal",
                    }}
                    numberOfLines={1}
                  >
                    {talkStatusSubtitle}
                  </Text>
                </View>
                {realtimeOn &&
                  (realtimeVoice.networkQuality === "reconnecting" ? (
                    <ActivityIndicator size="small" color="#f0a742" />
                  ) : (
                    <View
                      accessibilityLabel={`Connection quality: ${realtimeVoice.networkQuality}`}
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor:
                          realtimeVoice.networkQuality === "good"
                            ? "#3fb950"
                            : realtimeVoice.networkQuality === "degraded"
                              ? "#f0a742"
                              : c.mutedForeground,
                      }}
                    />
                  ))}
                {talkListening ? (
                  <OraLiveDot color={VOICE_LISTEN_RED} size={8} />
                ) : talkConnecting || talkThinking ? (
                  <ActivityIndicator size="small" color={tierAccent} />
                ) : null}
              </View>

              {/* Connection-issue chip — repeated audio drops on a live session */}
              {realtimeOn && realtimeVoice.connectionIssue && (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    borderWidth: 1,
                    borderColor: "#f0a742" + "59",
                    backgroundColor: "#f0a742" + "14",
                    borderRadius: 12,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                  }}
                >
                  <Text
                    style={{
                      flex: 1,
                      color: c.foreground,
                      fontSize: 12,
                      fontFamily: "Inter_600SemiBold",
                    }}
                  >
                    Connection issues?
                  </Text>
                  <Pressable
                    onPress={retryRealtimeVoice}
                    hitSlop={6}
                    style={{
                      borderWidth: 1,
                      borderColor: tierAccent + "59",
                      borderRadius: 10,
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                    }}
                  >
                    <Text
                      style={{ color: tierAccent, fontSize: 12, fontFamily: "Inter_600SemiBold" }}
                    >
                      Call back
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      realtimeVoiceRef.current?.stop();
                      scheduleTalkRestart(300);
                    }}
                    hitSlop={6}
                    style={{
                      borderWidth: 1,
                      borderColor: c.border,
                      borderRadius: 10,
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                    }}
                  >
                    <Text
                      style={{
                        color: c.mutedForeground,
                        fontSize: 12,
                        fontFamily: "Inter_600SemiBold",
                      }}
                    >
                      Switch to basic
                    </Text>
                  </Pressable>
                </View>
              )}

              {/* Legacy mic waveform — only the fallback loop records via expo-audio */}
              {recording && (
                <RecordingIndicator
                  recorder={recorder}
                  accentColor={tierAccent}
                  autoStopOnSilence={true}
                  onAutoStop={autoStopTalkRecording}
                />
              )}

              {/* Controls row: Mute · [Interrupt] · timer → End */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Pressable
                  onPress={onMutePress}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    borderWidth: 1,
                    borderRadius: 12,
                    borderColor: talkMuted ? c.border : tierAccent + "59",
                    paddingHorizontal: 12,
                    paddingVertical: 7,
                  }}
                >
                  {talkMuted ? (
                    <VolumeX size={14} color={c.mutedForeground} />
                  ) : (
                    <Volume2 size={14} color={tierAccent} />
                  )}
                  <Text
                    style={{
                      color: talkMuted ? c.mutedForeground : tierAccent,
                      fontFamily: "Inter_600SemiBold",
                      fontSize: 13,
                    }}
                  >
                    {talkMuted ? "Unmute" : "Mute"}
                  </Text>
                </Pressable>

                {showInterrupt && (
                  <Pressable
                    onPress={onInterruptPress}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      borderWidth: 1,
                      borderRadius: 12,
                      borderColor: c.border,
                      paddingHorizontal: 12,
                      paddingVertical: 7,
                    }}
                  >
                    <Mic size={14} color={c.mutedForeground} />
                    <Text
                      style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 13 }}
                    >
                      Interrupt
                    </Text>
                  </Pressable>
                )}

                {realtimeOn && realtimeVoice.remainingSeconds != null && (
                  <Text
                    style={{
                      color: realtimeVoice.remainingSeconds <= 30 ? "#f0a742" : c.mutedForeground,
                      fontSize: 12,
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {formatRemaining(realtimeVoice.remainingSeconds)}
                  </Text>
                )}

                <Pressable
                  onPress={toggleTalkMode}
                  style={{
                    marginLeft: "auto",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    borderWidth: 1,
                    borderRadius: 12,
                    borderColor: c.destructive + "4d",
                    paddingHorizontal: 14,
                    paddingVertical: 7,
                  }}
                >
                  <PhoneOff size={14} color={c.destructive} />
                  <Text
                    style={{ color: c.destructive, fontFamily: "Inter_600SemiBold", fontSize: 13 }}
                  >
                    End
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : (
            /* ── Unified rounded composer bar — mirrors website Ora panel layout ── */
            <View
              style={{
                borderWidth: 1.5,
                borderColor: composerFocused ? tierAccent + "99" : c.border,
                borderRadius: 20,
                backgroundColor: c.card,
              }}
            >
              {/* Input area: TextInput when idle, waveform when recording */}
              {recording ? (
                <RecordingIndicator
                  recorder={recorder}
                  accentColor={tierAccent}
                  autoStopOnSilence={false}
                  onAutoStop={autoStopTalkRecording}
                />
              ) : (
                <TextInput
                  ref={inputRef}
                  value={input}
                  onChangeText={setInput}
                  placeholder="Ask Ora anything…"
                  placeholderTextColor={c.mutedForeground}
                  multiline
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => setComposerFocused(false)}
                  style={{
                    paddingHorizontal: 14,
                    paddingTop: 12,
                    paddingBottom: 4,
                    maxHeight: 120,
                    minHeight: 48,
                    color: c.foreground,
                    fontFamily: "Inter_400Regular",
                    fontSize: 15,
                  }}
                />
              )}

              {/* Control row: Mode | Plus | Mic → spacer → Send */}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 8,
                  paddingBottom: 8,
                  paddingTop: 2,
                  gap: 2,
                }}
              >
                {/* Mode pill */}
                <Pressable
                  onPress={() => {
                    if (!deepAllowed) {
                      Alert.alert(
                        "Deep Thinking",
                        "Deep Thinking is available with Core Pack or Deep Wave. Manage your plan on the MustaFlow website.",
                        [{ text: "OK" }],
                      );
                      return;
                    }
                    setMode(mode === "deep" ? "instant" : "deep");
                  }}
                  accessibilityLabel={
                    mode === "deep" ? "Switch to Instant mode" : "Switch to Deep Thinking mode"
                  }
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingVertical: 5,
                    paddingHorizontal: 10,
                    borderRadius: 999,
                    backgroundColor: mode === "deep" ? tierAccent + "18" : "transparent",
                    borderWidth: 1,
                    borderColor: mode === "deep" ? tierAccent + "55" : "transparent",
                  }}
                >
                  {mode === "deep" ? (
                    <Gauge size={13} color={tierAccent} />
                  ) : (
                    <Zap size={13} color={c.mutedForeground} />
                  )}
                  <Text
                    style={{
                      color: mode === "deep" ? tierAccent : c.mutedForeground,
                      fontFamily: "Inter_500Medium",
                      fontSize: 12,
                    }}
                  >
                    {mode === "deep" ? "Deep" : "Instant"}
                  </Text>
                </Pressable>

                {/* Plus — hidden while recording */}
                {!recording && (
                  <Pressable
                    onPress={() => setShowPlusMenu(true)}
                    disabled={uploading}
                    accessibilityLabel="Add attachment or create file"
                    style={{ padding: 6, opacity: uploading ? 0.5 : 1 }}
                  >
                    {uploading ? (
                      <ActivityIndicator size="small" color={c.mutedForeground} />
                    ) : (
                      <Plus size={20} color={c.mutedForeground} />
                    )}
                  </Pressable>
                )}

                {/* Mic */}
                <Pressable
                  onPress={recording ? stopRecording : startRecording}
                  disabled={transcribing}
                  accessibilityRole="button"
                  accessibilityLabel={recording ? "Stop recording" : "Record a voice message"}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 15,
                    backgroundColor: recording ? tierAccent + "20" : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {transcribing ? (
                    <ActivityIndicator size="small" color={c.mutedForeground} />
                  ) : recording ? (
                    <Square size={14} color={tierAccent} fill={tierAccent} />
                  ) : (
                    <Mic size={20} color={c.mutedForeground} />
                  )}
                </Pressable>

                <View style={{ flex: 1 }} />

                {/* Send */}
                <Pressable
                  onPress={handleSend}
                  disabled={sending || (!input.trim() && !attachment)}
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 17,
                    backgroundColor:
                      sending || (!input.trim() && !attachment) ? c.secondary : tierAccent,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={c.primaryForeground} />
                  ) : (
                    <Send
                      size={18}
                      color={!input.trim() && !attachment ? c.mutedForeground : "#ffffff"}
                    />
                  )}
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>

      <ChatsDrawer
        visible={showConversations}
        loading={loadingConversations}
        conversations={conversations}
        projects={projects}
        activeId={conversationId}
        activeProjectId={activeProjectId}
        onClose={() => setShowConversations(false)}
        onSelect={loadConversation}
        onDelete={removeConversation}
        onNewChatInScope={startChatInScope}
        onSelectProject={selectProjectScope}
        onCreateProject={openCreateProject}
        onRenameProject={openRenameProject}
        onDeleteProject={handleDeleteProject}
        onMoveConversation={(conv) => setMoveTarget(conv)}
        onSearchConversations={searchChatLists}
        onPinConversation={async (id, pinned) => {
          try {
            await pinConversation(id, pinned);
            void refreshChatLists();
          } catch {
            /* best-effort */
          }
        }}
      />

      <MoveConversationSheet
        conversation={moveTarget}
        projects={projects}
        onClose={() => setMoveTarget(null)}
        onMove={handleMoveConversation}
      />

      <ProjectEditorModal
        visible={projectEditorOpen}
        project={editingProject}
        onClose={() => {
          setProjectEditorOpen(false);
          setEditingProject(null);
        }}
        onSave={handleSaveProject}
      />

      <PlusMenu
        visible={showPlusMenu}
        onClose={() => setShowPlusMenu(false)}
        onDismissed={handlePlusMenuDismissed}
        onTakePhoto={() => closePlusMenuThen(() => void handleCameraCapture())}
        onPickPhoto={() => closePlusMenuThen(() => void handleGalleryPick())}
        onBrowseFiles={() => closePlusMenuThen(() => void handleBrowseFiles())}
        onGenerateFile={() =>
          closePlusMenuThen(() => {
            setGenerateFileDraft(null);
            setShowGenerateFile(true);
          })
        }
      />

      <GenerateFileSheet
        visible={showGenerateFile}
        accentColor={tierAccent}
        sending={sending}
        initialPrompt={generateFileDraft?.prompt ?? ""}
        initialFormat={generateFileDraft?.format ?? "docx"}
        onClose={() => {
          setShowGenerateFile(false);
          setGenerateFileDraft(null);
        }}
        onGenerate={handleGenerateFile}
      />

      <OraHeaderMenu
        visible={showHeaderMenu}
        accentColor={tierAccent}
        isSignedIn={!!isSignedIn}
        hasMessages={messages.length > 0}
        temporary={temporary}
        language={language}
        autoReadReplies={autoReadReplies}
        sending={sending}
        onClose={() => setShowHeaderMenu(false)}
        onSelectLanguage={(lang) => setLanguage(lang)}
        onToggleVoiceResponses={toggleVoiceResponses}
        onNewChat={() => {
          setShowHeaderMenu(false);
          newChat();
        }}
        onOpenConversations={() => {
          setShowHeaderMenu(false);
          void openConversations();
        }}
        onOpenMemory={openMemoryScreen}
        onToggleTemporary={() => {
          setShowHeaderMenu(false);
          toggleTemporary();
        }}
        onClearConversation={() => {
          setShowHeaderMenu(false);
          newChat();
        }}
      />

      <MessageActionsSheet
        message={actionsMessage}
        canRegenerate={
          !!actionsMessage &&
          actionsMessage.id === lastAssistantId &&
          lastAssistantRegenerable &&
          !sending
        }
        onClose={() => setActionsMessage(null)}
        onCopy={(m) => {
          void Clipboard.setStringAsync(m.content);
          setActionsMessage(null);
        }}
        onShare={(m) => {
          setActionsMessage(null);
          void handleShareMessage(m);
        }}
        onSaveFile={(m) => {
          setActionsMessage(null);
          void handleSaveMessageFile(m);
        }}
        onExportMarkdown={(m) => {
          setActionsMessage(null);
          void handleExportMessageMarkdown(m);
        }}
        onExportConversation={() => {
          setActionsMessage(null);
          void handleExportConversationMarkdown();
        }}
        onExportJson={(m) => {
          setActionsMessage(null);
          void handleExportJson(m);
        }}
        onExportCsv={(m) => {
          setActionsMessage(null);
          void handleExportActionPlanCsv(m);
        }}
        onRegenerate={(m) => {
          setActionsMessage(null);
          handleRegenerate(m);
        }}
        onReadAloud={(m) => {
          setActionsMessage(null);
          void speak(m);
        }}
        onEdit={(m) => {
          setActionsMessage(null);
          handleEditMessage(m);
        }}
        onExportWord={(m) => {
          setActionsMessage(null);
          void handleExportWord(m);
        }}
        onExportExcel={(m) => {
          setActionsMessage(null);
          void handleExportExcel(m);
        }}
        onExportPresentation={(m) => {
          setActionsMessage(null);
          void handleExportPresentation(m);
        }}
        onExportPdf={(m) => {
          setActionsMessage(null);
          void handleExportPdf(m);
        }}
      />

      <ImagePreviewModal source={previewImageSource} onClose={() => setPreviewImageSource(null)} />
    </View>
  );
}

const WAVEFORM_BAR_COUNT = 28;
const METERING_FLOOR_DB = -50;
const TALK_MODE_SPEECH_DB = -42;
const TALK_MODE_SILENCE_DB = -48;
const TALK_MODE_SILENCE_MS = 1200;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = (totalSeconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function RecordingIndicator({
  recorder,
  accentColor,
  autoStopOnSilence = false,
  onAutoStop,
}: {
  recorder: AudioRecorder;
  accentColor: string;
  autoStopOnSilence?: boolean;
  onAutoStop?: () => void;
}) {
  const c = useColors();
  const state = useAudioRecorderState(recorder, 90);
  const [levels, setLevels] = useState<number[]>(() => Array(WAVEFORM_BAR_COUNT).fill(0));
  const heardSpeechRef = useRef(false);
  const silenceStartedAtRef = useRef<number | null>(null);
  const autoStopFiredRef = useRef(false);

  const metering = state.metering;
  useEffect(() => {
    const db = typeof metering === "number" ? metering : METERING_FLOOR_DB;
    const norm = Math.max(0, Math.min(1, (db - METERING_FLOOR_DB) / -METERING_FLOOR_DB));
    const eased = Math.pow(norm, 0.6);
    setLevels((prev) => [...prev.slice(1), eased]);
  }, [metering]);

  useEffect(() => {
    if (!autoStopOnSilence) {
      heardSpeechRef.current = false;
      silenceStartedAtRef.current = null;
      autoStopFiredRef.current = false;
      return;
    }

    const db = typeof metering === "number" ? metering : METERING_FLOOR_DB;
    if (db > TALK_MODE_SPEECH_DB) {
      heardSpeechRef.current = true;
      silenceStartedAtRef.current = null;
      autoStopFiredRef.current = false;
      return;
    }

    if (!heardSpeechRef.current || db > TALK_MODE_SILENCE_DB || autoStopFiredRef.current) {
      return;
    }

    const now = Date.now();
    if (silenceStartedAtRef.current == null) {
      silenceStartedAtRef.current = now;
      return;
    }

    if (now - silenceStartedAtRef.current >= TALK_MODE_SILENCE_MS) {
      autoStopFiredRef.current = true;
      onAutoStop?.();
    }
  }, [autoStopOnSilence, metering, onAutoStop]);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
        minHeight: 48,
      }}
    >
      <View
        style={{
          flex: 1,
          height: 28,
          flexDirection: "row",
          alignItems: "center",
          gap: 2,
        }}
      >
        {levels.map((level, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: Math.max(3, level * 26),
              borderRadius: 2,
              backgroundColor: accentColor,
              opacity: 0.3 + level * 0.7,
            }}
          />
        ))}
      </View>
      <Text
        style={{
          color: c.mutedForeground,
          fontFamily: "Inter_500Medium",
          fontSize: 13,
          fontVariant: ["tabular-nums"],
          minWidth: 44,
          textAlign: "right",
        }}
      >
        {formatElapsed(state.durationMillis)}
      </Text>
    </View>
  );
}

function MessageBubbleBase({
  message,
  accentColor,
  speaking,
  onSpeak,
  onSuggestion,
  onSaveMemory,
  onLongPress,
  onEditImage,
  onImagePreview,
  onRetrySearch,
  onReviseFile,
  isLatest,
}: {
  message: OraMessage;
  accentColor: string;
  speaking: boolean;
  onSpeak: () => void;
  onSuggestion: (text: string) => void;
  onSaveMemory?: (message: OraMessage) => Promise<void>;
  onLongPress: () => void;
  onEditImage?: (imageId: number) => void;
  onImagePreview?: (source: string) => void;
  onRetrySearch?: (message: OraMessage) => void;
  onReviseFile?: (file: GeneratedFile) => void;
  isLatest?: boolean;
}) {
  const c = useColors();
  const isUser = message.role === "user";
  // Web-search citations are untrusted — only render/open safe public links.
  const safeSources = (message.sources ?? []).filter((s) => isSafeHttpUrl(s.url));
  const [savingFile, setSavingFile] = useState(false);
  const [savingImage, setSavingImage] = useState(false);

  const copy = () => Clipboard.setStringAsync(message.content);

  // Long-press anywhere on a settled bubble opens the per-message actions sheet.
  const triggerLongPress = () => {
    if (message.pending) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onLongPress();
  };

  const handleSaveFile = useCallback(async () => {
    if (!message.generatedFile || savingFile) return;
    setSavingFile(true);
    try {
      const outcome = await saveGeneratedFile(message.generatedFile);
      if (outcome === "image-saved") {
        Alert.alert("Saved", "Image saved to your photo library.");
      }
    } catch (err) {
      Alert.alert(
        "Couldn't save file",
        err instanceof Error ? err.message : "Something went wrong.",
      );
    } finally {
      setSavingFile(false);
    }
  }, [message.generatedFile, savingFile]);

  const handleSaveImage = useCallback(async () => {
    if (!message.imageUrl || savingImage) return;
    setSavingImage(true);
    try {
      await saveImageFromUrl(message.imageUrl);
      if (Platform.OS !== "web") {
        Alert.alert("Saved", "Image saved to your photo library.");
      }
    } catch (err) {
      Alert.alert(
        "Couldn't save image",
        err instanceof Error ? err.message : "Something went wrong.",
      );
    } finally {
      setSavingImage(false);
    }
  }, [message.imageUrl, savingImage]);

  if (isUser) {
    return (
      <View style={{ alignItems: "flex-end" }}>
        <Pressable
          onLongPress={triggerLongPress}
          delayLongPress={300}
          style={{
            backgroundColor: c.muted + "99",
            borderRadius: 16,
            borderTopRightRadius: 4,
            paddingHorizontal: 14,
            paddingVertical: 10,
            maxWidth: "85%",
          }}
        >
          {message.attachment?.isImage && message.attachmentLocalUri ? (
            <Pressable
              onPress={() => onImagePreview?.(message.attachmentLocalUri!)}
              accessibilityRole="imagebutton"
              accessibilityLabel="Open image preview"
              style={{ marginBottom: message.content ? 8 : 0 }}
            >
              <Image
                source={{ uri: message.attachmentLocalUri }}
                style={{ width: 200, height: 200, borderRadius: 12 }}
                contentFit="cover"
                transition={120}
              />
            </Pressable>
          ) : (
            <OraAttachmentChip attachment={message.attachment} />
          )}
          {!!message.content && (
            <Text
              style={{
                color: c.foreground,
                fontFamily: "Inter_400Regular",
                fontSize: 15,
                lineHeight: 24,
              }}
            >
              {message.content}
            </Text>
          )}
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flexDirection: "row", gap: 10, maxWidth: "100%" }}>
      <OraAtom size={24} accentColor={accentColor} animated style={{ marginTop: 2 }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Pressable
          onLongPress={triggerLongPress}
          delayLongPress={300}
          style={{ width: "100%", paddingVertical: 2 }}
        >
          {message.pending ? (
            <ActivityIndicator size="small" color={c.mutedForeground} />
          ) : message.error ? (
            <>
              <Text style={{ color: c.destructive, fontSize: 14 }}>{message.content}</Text>
              {message.searchRetryable && isLatest && (
                <Pressable
                  onPress={() => onRetrySearch?.(message)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Retry live search"
                  style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}
                >
                  <RefreshCw size={13} color={c.mutedForeground} />
                  <Text
                    style={{
                      color: c.mutedForeground,
                      fontSize: 13,
                      fontFamily: "Inter_500Medium",
                    }}
                  >
                    Retry live search
                  </Text>
                </Pressable>
              )}
            </>
          ) : (
            <>
              <Markdown isStreaming={message.isStreaming}>{message.content}</Markdown>

              {message.streamCutOff && (
                <Text style={{ color: c.destructive, fontSize: 12, marginTop: 8 }}>
                  Ora&apos;s response was cut off. The partial reply above may be incomplete.
                </Text>
              )}

              {message.searchRetryable && isLatest && !message.isStreaming && (
                <Pressable
                  onPress={() => onRetrySearch?.(message)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Retry live search"
                  style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}
                >
                  <RefreshCw size={13} color={c.mutedForeground} />
                  <Text
                    style={{
                      color: c.mutedForeground,
                      fontSize: 13,
                      fontFamily: "Inter_500Medium",
                    }}
                  >
                    Retry live search
                  </Text>
                </Pressable>
              )}

              {message.imageUrl && (
                <View style={{ marginTop: 10 }}>
                  <Pressable
                    onPress={() => onImagePreview?.(message.imageUrl!)}
                    accessibilityRole="imagebutton"
                    accessibilityLabel="Open image preview"
                  >
                    <Image
                      source={{ uri: message.imageUrl }}
                      style={{
                        width: "100%",
                        aspectRatio: 1,
                        borderRadius: 12,
                      }}
                      contentFit="cover"
                      transition={200}
                    />
                  </Pressable>
                  {!!message.imageMeta && (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                      {formatOraImageMeta(message.imageMeta).map((label) => (
                        <View
                          key={label}
                          style={{
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: c.border,
                            backgroundColor: c.muted + "66",
                            borderRadius: 999,
                            paddingHorizontal: 8,
                            paddingVertical: 3,
                          }}
                        >
                          <Text
                            style={{
                              color: c.mutedForeground,
                              fontSize: 11,
                              fontFamily: "Inter_500Medium",
                            }}
                          >
                            {label}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                  {/* Save button — top-right */}
                  <Pressable
                    onPress={handleSaveImage}
                    disabled={savingImage}
                    hitSlop={8}
                    style={{
                      position: "absolute",
                      top: 8,
                      right: 8,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      paddingVertical: 6,
                      paddingHorizontal: 10,
                      borderRadius: 999,
                      backgroundColor: "rgba(0,0,0,0.55)",
                    }}
                  >
                    {savingImage ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Download size={14} color="#fff" />
                    )}
                    <Text style={{ color: "#fff", fontSize: 12 }}>Save</Text>
                  </Pressable>
                  {/* Edit button — top-left (only for editable images with an id) */}
                  {!!message.imageId && onEditImage && (
                    <Pressable
                      onPress={() => onEditImage(message.imageId!)}
                      hitSlop={8}
                      style={{
                        position: "absolute",
                        top: 8,
                        left: 8,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 6,
                        paddingVertical: 6,
                        paddingHorizontal: 10,
                        borderRadius: 999,
                        backgroundColor: "rgba(0,0,0,0.55)",
                      }}
                    >
                      <Pencil size={14} color="#fff" />
                      <Text style={{ color: "#fff", fontSize: 12 }}>Edit</Text>
                    </Pressable>
                  )}
                </View>
              )}

              {message.generatedFile && (
                <View
                  style={{
                    marginTop: 10,
                    padding: 10,
                    borderRadius: 10,
                    backgroundColor: c.muted,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <FileText size={18} color={c.accentForeground} />
                    <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13, flex: 1 }}>
                      {message.generatedFile.fileName}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                    <Pressable
                      onPress={handleSaveFile}
                      disabled={savingFile}
                      accessibilityRole="button"
                      accessibilityLabel="Save generated file"
                      style={{
                        flex: 1,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        borderRadius: 9,
                        paddingVertical: 8,
                        backgroundColor: c.card,
                      }}
                    >
                      {savingFile ? (
                        <ActivityIndicator size="small" color={c.mutedForeground} />
                      ) : isImageFile(message.generatedFile.mimeType) ? (
                        <Download size={15} color={c.accentForeground} />
                      ) : (
                        <Share2 size={15} color={c.accentForeground} />
                      )}
                      <Text
                        style={{
                          color: c.foreground,
                          fontSize: 12,
                          fontFamily: "Inter_600SemiBold",
                        }}
                      >
                        {isImageFile(message.generatedFile.mimeType) ? "Save" : "Share"}
                      </Text>
                    </Pressable>
                    {onReviseFile ? (
                      <Pressable
                        onPress={() => onReviseFile(message.generatedFile!)}
                        accessibilityRole="button"
                        accessibilityLabel="Revise generated file"
                        style={{
                          flex: 1,
                          flexDirection: "row",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 6,
                          borderRadius: 9,
                          paddingVertical: 8,
                          borderWidth: 1,
                          borderColor: c.border,
                          backgroundColor: "transparent",
                        }}
                      >
                        <Pencil size={15} color={c.accentForeground} />
                        <Text
                          style={{
                            color: c.foreground,
                            fontSize: 12,
                            fontFamily: "Inter_600SemiBold",
                          }}
                        >
                          Revise
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              )}

              {safeSources.length > 0 && (
                <View style={{ marginTop: 10 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 6,
                    }}
                  >
                    <Globe size={12} color={c.mutedForeground + "99"} />
                    <Text
                      style={{
                        color: c.mutedForeground + "99",
                        fontFamily: "Inter_600SemiBold",
                        fontSize: 10,
                        letterSpacing: 0.5,
                        textTransform: "uppercase",
                      }}
                    >
                      Sources
                    </Text>
                  </View>
                  <View style={{ gap: 6 }}>
                    {safeSources.map((s, i) => (
                      <Pressable
                        key={`${s.url}-${i}`}
                        onPress={() => WebBrowser.openBrowserAsync(s.url)}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 10,
                          borderRadius: 10,
                          borderWidth: 1,
                          borderColor: c.border + "99",
                          backgroundColor: c.muted + "4D",
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                        }}
                      >
                        <View
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 6,
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: "#995AF21F",
                          }}
                        >
                          <Globe size={14} color="#995AF2" />
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            numberOfLines={1}
                            style={{
                              color: c.foreground + "E6",
                              fontSize: 12,
                              fontFamily: "Inter_600SemiBold",
                            }}
                          >
                            {s.title || sourceHostname(s.url)}
                          </Text>
                          <Text
                            numberOfLines={1}
                            style={{ color: c.mutedForeground + "B3", fontSize: 10 }}
                          >
                            {sourceHostname(s.url)}
                          </Text>
                        </View>
                        <ExternalLink size={14} color={c.mutedForeground + "80"} />
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}

              <OraAssistantExtras message={message} onSaveMemory={onSaveMemory} />
            </>
          )}
        </Pressable>
        {!message.pending && !message.isStreaming && !message.error && (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 16,
              marginTop: 6,
              marginLeft: 4,
            }}
          >
            <Pressable
              onPress={copy}
              hitSlop={8}
              style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
            >
              <Copy size={13} color={c.mutedForeground} />
              <Text style={{ color: c.mutedForeground, fontSize: 12 }}>Copy</Text>
            </Pressable>
            {!!message.content && (
              <Pressable
                onPress={onSpeak}
                hitSlop={8}
                style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
              >
                <Volume2 size={13} color={speaking ? c.accentForeground : c.mutedForeground} />
                <Text
                  style={{
                    color: speaking ? c.accentForeground : c.mutedForeground,
                    fontSize: 12,
                  }}
                >
                  {speaking ? "Stop" : "Listen"}
                </Text>
              </Pressable>
            )}
          </View>
        )}
        {!message.pending && !message.isStreaming && !message.error && (
          <OraSuggestions suggestions={message.suggestions} onPress={onSuggestion} />
        )}
      </View>
    </View>
  );
}

// Memoized so a token-by-token streaming update (setMessages every ~55ms) only
// re-renders the streaming bubble, not all 50+ settled bubbles. Unchanged
// messages keep their object reference, so this comparator skips them. The
// callback props are intentionally excluded: they capture the row's own message
// (identical to `message`) or read live values through refs, so they stay
// correct even when a settled bubble does not re-render.
const MessageBubble = React.memo(
  MessageBubbleBase,
  (prev, next) =>
    prev.message === next.message &&
    prev.accentColor === next.accentColor &&
    prev.speaking === next.speaking &&
    // isLatest gates the "Retry live search" affordance; when a newer message
    // arrives the previously-latest bubble must re-render to hide the button.
    prev.isLatest === next.isLatest &&
    // onSaveMemory is stable (deps []); its presence only flips when temporary
    // mode toggles, so this keeps the memory chip from going stale without
    // re-rendering on every streaming token.
    Boolean(prev.onSaveMemory) === Boolean(next.onSaveMemory),
);

function ConversationRow({
  conv,
  active,
  indented,
  onSelect,
  onDelete,
  onMove,
  onPin,
}: {
  conv: OraConversationSummary;
  active: boolean;
  indented?: boolean;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
  onMove: (conversation: OraConversationSummary) => void;
  onPin?: (id: number, pinned: boolean) => void;
}) {
  const c = useColors();
  const isPinned = conv.pinnedAt != null;
  const hasBadges =
    conv.metaHasImages || conv.metaHasGeneratedFiles || conv.metaHasSources || conv.metaHasVoice;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 12,
        paddingHorizontal: 12,
        marginLeft: indented ? 16 : 0,
        borderRadius: c.radius,
        backgroundColor: active ? c.accent : "transparent",
      }}
    >
      {isPinned ? (
        <Pin size={15} color={c.mutedForeground} />
      ) : (
        <MessageSquare size={16} color={c.mutedForeground} />
      )}
      <Pressable
        style={{ flex: 1 }}
        onPress={() => onSelect(conv.id)}
        accessibilityRole="button"
        accessibilityLabel={`Open chat ${conv.title || "Untitled"}`}
      >
        <Text
          numberOfLines={1}
          style={{ color: c.foreground, fontFamily: "Inter_500Medium", fontSize: 15 }}
        >
          {conv.title || "Untitled"}
        </Text>
        {conv.preview ? (
          <Text numberOfLines={1} style={{ color: c.mutedForeground, fontSize: 13, marginTop: 2 }}>
            {conv.preview}
          </Text>
        ) : null}
        {hasBadges ? (
          <View style={{ flexDirection: "row", gap: 4, marginTop: 3 }}>
            {conv.metaHasImages ? <ImageIcon size={11} color={c.mutedForeground} /> : null}
            {conv.metaHasGeneratedFiles ? <FileText size={11} color={c.mutedForeground} /> : null}
            {conv.metaHasSources ? <Globe size={11} color={c.mutedForeground} /> : null}
            {conv.metaHasVoice ? <Mic size={11} color={c.mutedForeground} /> : null}
          </View>
        ) : null}
      </Pressable>
      {onPin ? (
        <Pressable
          onPress={() => onPin(conv.id, !isPinned)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={
            isPinned ? `Unpin ${conv.title || "chat"}` : `Pin ${conv.title || "chat"}`
          }
        >
          {isPinned ? (
            <PinOff size={15} color={c.mutedForeground} />
          ) : (
            <Pin size={15} color={c.mutedForeground} />
          )}
        </Pressable>
      ) : null}
      <Pressable
        onPress={() => onMove(conv)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Move chat ${conv.title || "Untitled"}`}
      >
        <FolderInput size={16} color={c.mutedForeground} />
      </Pressable>
      <Pressable
        onPress={() => onDelete(conv.id)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Delete chat ${conv.title || "Untitled"}`}
      >
        <Trash2 size={16} color={c.mutedForeground} />
      </Pressable>
    </View>
  );
}

function ChatsDrawer({
  visible,
  loading,
  conversations,
  projects,
  activeId,
  activeProjectId,
  onClose,
  onSelect,
  onDelete,
  onNewChatInScope,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onMoveConversation,
  onSearchConversations,
  onPinConversation,
}: {
  visible: boolean;
  loading: boolean;
  conversations: OraConversationSummary[];
  projects: OraProjectSummary[];
  activeId: number | null;
  activeProjectId: number | null;
  onClose: () => void;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
  onNewChatInScope: (projectId: number | null) => void;
  onSelectProject: (projectId: number) => void;
  onCreateProject: () => void;
  onRenameProject: (project: OraProjectSummary) => void;
  onDeleteProject: (project: OraProjectSummary) => void;
  onMoveConversation: (conversation: OraConversationSummary) => void;
  onSearchConversations: (query: string) => Promise<void>;
  onPinConversation: (id: number, pinned: boolean) => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [searchQuery, setSearchQuery] = useState("");

  // Always expand the active project when it changes (mirrors the website, which
  // keeps the current project open). The user can still manually collapse it.
  useEffect(() => {
    if (activeProjectId != null) {
      setExpanded((prev) => ({ ...prev, [activeProjectId]: true }));
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (!visible) return;
    const handle = setTimeout(() => {
      void onSearchConversations(searchQuery);
    }, 250);
    return () => clearTimeout(handle);
  }, [onSearchConversations, searchQuery, visible]);

  // Standalone chats (no project) live under "Recent"; the rest nest under
  // their project. Server returns projectId per conversation.
  const filtered = conversations;
  const pinned = filtered.filter((cv) => cv.pinnedAt != null && cv.archivedAt == null);
  const standalone = filtered.filter((cv) => cv.projectId == null && cv.archivedAt == null);

  const labelStyle = {
    color: c.mutedForeground,
    fontFamily: "Inter_600SemiBold" as const,
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: "uppercase" as const,
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)" }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View
          style={{
            backgroundColor: c.card,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingTop: 8,
            paddingBottom: insets.bottom + 12,
            maxHeight: "80%",
          }}
        >
          <View
            style={{
              alignSelf: "center",
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: c.border,
              marginBottom: 12,
            }}
          />
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 18,
              paddingBottom: 12,
            }}
          >
            <Text style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 18 }}>
              Chats
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close chats"
            >
              <X size={22} color={c.mutedForeground} />
            </Pressable>
          </View>

          {/* Search */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              marginHorizontal: 18,
              marginBottom: 10,
              paddingHorizontal: 10,
              borderRadius: 10,
              backgroundColor: c.muted,
              gap: 6,
            }}
          >
            <Search size={15} color={c.mutedForeground} />
            <TextInput
              placeholder="Search…"
              placeholderTextColor={c.mutedForeground}
              value={searchQuery}
              onChangeText={setSearchQuery}
              style={{
                flex: 1,
                paddingVertical: 8,
                fontSize: 14,
                color: c.foreground,
                fontFamily: "Inter_400Regular",
              }}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          </View>

          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginVertical: 32 }} />
          ) : (
            <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8 }}>
              {/* Pinned conversations */}
              {pinned.length > 0 && (
                <>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      paddingHorizontal: 12,
                      paddingTop: 4,
                      paddingBottom: 6,
                    }}
                  >
                    <Pin size={12} color={c.mutedForeground} />
                    <Text style={labelStyle}>Pinned</Text>
                  </View>
                  {pinned.map((conv) => (
                    <ConversationRow
                      key={conv.id}
                      conv={conv}
                      active={conv.id === activeId}
                      onSelect={onSelect}
                      onDelete={onDelete}
                      onMove={onMoveConversation}
                      onPin={onPinConversation}
                    />
                  ))}
                  <View style={{ height: 8 }} />
                </>
              )}

              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingHorizontal: 12,
                  paddingTop: 4,
                  paddingBottom: 8,
                }}
              >
                <Text style={labelStyle}>Projects</Text>
                <Pressable
                  onPress={onCreateProject}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="New project"
                >
                  <FolderPlus size={18} color={c.mutedForeground} />
                </Pressable>
              </View>

              {projects.length === 0 ? (
                <Text
                  style={{
                    color: c.mutedForeground,
                    fontSize: 13,
                    paddingHorizontal: 12,
                    paddingBottom: 8,
                  }}
                >
                  No projects yet
                </Text>
              ) : (
                projects.map((p) => {
                  const isOpen = expanded[p.id] ?? p.id === activeProjectId;
                  const convs = conversations.filter((cv) => cv.projectId === p.id);
                  return (
                    <View key={p.id} style={{ marginBottom: 2 }}>
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 6,
                          paddingVertical: 10,
                          paddingHorizontal: 12,
                          borderRadius: c.radius,
                          backgroundColor: p.id === activeProjectId ? c.accent : "transparent",
                        }}
                      >
                        <Pressable
                          onPress={() => setExpanded((prev) => ({ ...prev, [p.id]: !isOpen }))}
                          hitSlop={6}
                          accessibilityRole="button"
                          accessibilityLabel={`${isOpen ? "Collapse" : "Expand"} project ${p.name}`}
                        >
                          {isOpen ? (
                            <ChevronDown size={16} color={c.mutedForeground} />
                          ) : (
                            <ChevronRight size={16} color={c.mutedForeground} />
                          )}
                        </Pressable>
                        <Pressable
                          style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}
                          onPress={() => onSelectProject(p.id)}
                          accessibilityRole="button"
                          accessibilityState={{ selected: p.id === activeProjectId }}
                          accessibilityLabel={`Select project ${p.name}`}
                        >
                          {isOpen ? (
                            <FolderOpen size={16} color={c.foreground} />
                          ) : (
                            <Folder size={16} color={c.foreground} />
                          )}
                          <Text
                            numberOfLines={1}
                            style={{
                              color: c.foreground,
                              fontFamily: "Inter_600SemiBold",
                              fontSize: 15,
                              flex: 1,
                            }}
                          >
                            {p.name}
                          </Text>
                        </Pressable>
                        <Pressable
                          onPress={() => onNewChatInScope(p.id)}
                          hitSlop={6}
                          accessibilityRole="button"
                          accessibilityLabel={`New chat in ${p.name}`}
                        >
                          <Plus size={16} color={c.mutedForeground} />
                        </Pressable>
                        <Pressable
                          onPress={() => onRenameProject(p)}
                          hitSlop={6}
                          accessibilityRole="button"
                          accessibilityLabel={`Rename ${p.name}`}
                        >
                          <Pencil size={15} color={c.mutedForeground} />
                        </Pressable>
                        <Pressable
                          onPress={() => onDeleteProject(p)}
                          hitSlop={6}
                          accessibilityRole="button"
                          accessibilityLabel={`Delete ${p.name}`}
                        >
                          <Trash2 size={15} color={c.mutedForeground} />
                        </Pressable>
                      </View>
                      {isOpen &&
                        (convs.length === 0 ? (
                          <Text
                            style={{
                              color: c.mutedForeground,
                              fontSize: 13,
                              paddingVertical: 8,
                              paddingHorizontal: 12,
                              marginLeft: 16,
                            }}
                          >
                            No chats yet
                          </Text>
                        ) : (
                          convs.map((conv) => (
                            <ConversationRow
                              key={conv.id}
                              conv={conv}
                              active={conv.id === activeId}
                              indented
                              onSelect={onSelect}
                              onDelete={onDelete}
                              onMove={onMoveConversation}
                              onPin={onPinConversation}
                            />
                          ))
                        ))}
                    </View>
                  );
                })
              )}

              <View style={{ height: 12 }} />
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingHorizontal: 12,
                  paddingBottom: 8,
                }}
              >
                <Text style={labelStyle}>Recent</Text>
                <Pressable
                  onPress={() => onNewChatInScope(null)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="New standalone chat"
                >
                  <Plus size={18} color={c.mutedForeground} />
                </Pressable>
              </View>
              {standalone.length === 0 ? (
                <Text
                  style={{
                    color: c.mutedForeground,
                    fontSize: 13,
                    paddingHorizontal: 12,
                    paddingBottom: 8,
                  }}
                >
                  No conversations yet
                </Text>
              ) : (
                standalone.map((conv) => (
                  <ConversationRow
                    key={conv.id}
                    conv={conv}
                    active={conv.id === activeId}
                    onSelect={onSelect}
                    onDelete={onDelete}
                    onMove={onMoveConversation}
                    onPin={onPinConversation}
                  />
                ))
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function ProjectEditorModal({
  visible,
  project,
  onClose,
  onSave,
}: {
  visible: boolean;
  project: OraProjectSummary | null;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const c = useColors();
  const [name, setName] = useState("");

  useEffect(() => {
    if (visible) setName(project?.name ?? "");
  }, [visible, project]);

  const canSave = name.trim().length > 0;

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.6)",
            justifyContent: "center",
            padding: 24,
          }}
          onPress={onClose}
        >
          <Pressable
            onPress={() => {}}
            style={{ backgroundColor: c.card, borderRadius: 16, padding: 20, gap: 14 }}
          >
            <Text style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 17 }}>
              {project ? "Rename project" : "New project"}
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Project name"
              placeholderTextColor={c.mutedForeground}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => {
                if (canSave) onSave(name);
              }}
              style={{
                color: c.foreground,
                fontSize: 16,
                fontFamily: "Inter_400Regular",
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: c.radius,
                paddingHorizontal: 12,
                paddingVertical: 10,
                backgroundColor: c.background,
              }}
            />
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
              <Pressable
                onPress={onClose}
                style={{ paddingVertical: 10, paddingHorizontal: 16 }}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={{ color: c.mutedForeground, fontFamily: "Inter_600SemiBold" }}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (canSave) onSave(name);
                }}
                disabled={!canSave}
                style={{
                  paddingVertical: 10,
                  paddingHorizontal: 16,
                  borderRadius: c.radius,
                  backgroundColor: canSave ? c.primary : c.muted,
                }}
                accessibilityRole="button"
                accessibilityLabel="Save project"
              >
                <Text
                  style={{
                    color: canSave ? c.primaryForeground : c.mutedForeground,
                    fontFamily: "Inter_600SemiBold",
                  }}
                >
                  Save
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Format options for the "Create file" sheet. Order mirrors the website's
// most-common-first ordering; values are the server-accepted file formats.
const GENERATE_FILE_FORMATS: {
  value: FileFormat;
  label: string;
  icon: React.ComponentType<{ size?: number; color?: string }>;
}[] = [
  { value: "docx", label: "Word document (.docx)", icon: FileText },
  { value: "pdf", label: "PDF (.pdf)", icon: FileDown },
  { value: "xlsx", label: "Excel spreadsheet (.xlsx)", icon: FileSpreadsheet },
  { value: "csv", label: "CSV (.csv)", icon: FileSpreadsheet },
  { value: "pptx", label: "PowerPoint (.pptx)", icon: Presentation },
];

// Bottom sheet to author a brand-new file from a prompt. Collects a description
// and a target format, then hands both to onGenerate. State resets each time the
// sheet opens so a prior draft never leaks into a new request.
function GenerateFileSheet({
  visible,
  accentColor,
  sending,
  initialPrompt = "",
  initialFormat = "docx",
  onClose,
  onGenerate,
}: {
  visible: boolean;
  accentColor: string;
  sending: boolean;
  initialPrompt?: string;
  initialFormat?: FileFormat;
  onClose: () => void;
  onGenerate: (prompt: string, format: FileFormat) => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState<FileFormat>("docx");

  useEffect(() => {
    if (visible) {
      setPrompt(initialPrompt);
      setFormat(initialFormat);
    }
  }, [visible, initialPrompt, initialFormat]);

  const canGenerate = prompt.trim().length > 0 && !sending;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)" }}>
          <Pressable style={{ flex: 1 }} onPress={onClose} />
          <View
            style={{
              backgroundColor: c.card,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingTop: 8,
              paddingBottom: insets.bottom + 12,
            }}
          >
            <View
              style={{
                alignSelf: "center",
                width: 40,
                height: 4,
                borderRadius: 2,
                backgroundColor: c.border,
                marginBottom: 8,
              }}
            />
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: 20,
                paddingVertical: 4,
              }}
            >
              <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 17 }}>
                Create a file
              </Text>
              <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
                <X size={20} color={c.mutedForeground} />
              </Pressable>
            </View>

            <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
              <SheetSectionLabel label="What should it contain?" />
              <View style={{ paddingHorizontal: 20 }}>
                <TextInput
                  value={prompt}
                  onChangeText={setPrompt}
                  multiline
                  placeholder="e.g. A budget spreadsheet for a 3-day trip to Tokyo"
                  placeholderTextColor={c.mutedForeground}
                  accessibilityLabel="Describe the file to create"
                  style={{
                    minHeight: 80,
                    maxHeight: 160,
                    borderWidth: 1,
                    borderColor: c.border,
                    borderRadius: 12,
                    padding: 12,
                    color: c.foreground,
                    fontFamily: "Inter_400Regular",
                    fontSize: 15,
                    textAlignVertical: "top",
                  }}
                />
              </View>

              <SheetSectionLabel label="Format" />
              {GENERATE_FILE_FORMATS.map((f) => (
                <ToolRow
                  key={f.value}
                  icon={f.icon}
                  label={f.label}
                  active={format === f.value}
                  accentColor={accentColor}
                  onPress={() => setFormat(f.value)}
                />
              ))}
            </ScrollView>

            <View style={{ paddingHorizontal: 20, paddingTop: 12 }}>
              <Pressable
                onPress={() => onGenerate(prompt, format)}
                disabled={!canGenerate}
                accessibilityRole="button"
                accessibilityLabel="Create file"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  height: 50,
                  borderRadius: 14,
                  backgroundColor: canGenerate ? accentColor : c.secondary,
                }}
              >
                {sending ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <FilePlus2 size={18} color={canGenerate ? "#ffffff" : c.mutedForeground} />
                )}
                <Text
                  style={{
                    color: canGenerate ? "#ffffff" : c.mutedForeground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 15,
                  }}
                >
                  {sending ? "Creating\u2026" : "Create file"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function PlusMenu({
  visible,
  onClose,
  onTakePhoto,
  onPickPhoto,
  onBrowseFiles,
  onGenerateFile,
  onDismissed,
}: {
  visible: boolean;
  onClose: () => void;
  onTakePhoto: () => void;
  onPickPhoto: () => void;
  onBrowseFiles: () => void;
  onGenerateFile: () => void;
  onDismissed: () => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      onDismiss={onDismissed}
    >
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)" }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View
          style={{
            backgroundColor: c.card,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingTop: 8,
            paddingBottom: insets.bottom + 12,
          }}
        >
          <View
            style={{
              alignSelf: "center",
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: c.border,
              marginBottom: 8,
            }}
          />
          <SheetSectionLabel label="Attach" />
          <ActionRow icon={Camera} label="Take photo" onPress={onTakePhoto} />
          <ActionRow icon={Images} label="Photo library" onPress={onPickPhoto} />
          <ActionRow icon={FolderOpen} label="Browse files" onPress={onBrowseFiles} />

          <SheetSectionLabel label="Create" />
          <ActionRow icon={FilePlus2} label="Create file" onPress={onGenerateFile} />
        </View>
      </View>
    </Modal>
  );
}

function OraHeaderMenu({
  visible,
  accentColor,
  isSignedIn,
  hasMessages,
  temporary,
  language,
  autoReadReplies,
  sending,
  onClose,
  onSelectLanguage,
  onToggleVoiceResponses,
  onNewChat,
  onOpenConversations,
  onOpenMemory,
  onToggleTemporary,
  onClearConversation,
}: {
  visible: boolean;
  accentColor: string;
  isSignedIn: boolean;
  hasMessages: boolean;
  temporary: boolean;
  language: string;
  autoReadReplies: boolean;
  sending: boolean;
  onClose: () => void;
  onSelectLanguage: (lang: string) => void;
  onToggleVoiceResponses: () => void;
  onNewChat: () => void;
  onOpenConversations: () => void;
  onOpenMemory: () => void;
  onToggleTemporary: () => void;
  onClearConversation: () => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)" }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View
          style={{
            backgroundColor: c.card,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingTop: 8,
            paddingBottom: insets.bottom + 12,
          }}
        >
          <View
            style={{
              alignSelf: "center",
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: c.border,
              marginBottom: 8,
            }}
          />
          <ScrollView bounces={false}>
            <SheetSectionLabel label="Chat" />
            <ActionRow icon={Plus} label="New chat" onPress={onNewChat} disabled={sending} />
            <ActionRow icon={History} label="Conversations" onPress={onOpenConversations} />

            <SheetSectionLabel label="Reply language" />
            {LANGUAGES.map((l) => (
              <ToolRow
                key={l.value}
                icon={Globe}
                label={l.label}
                active={language === l.value}
                accentColor={accentColor}
                onPress={() => {
                  onSelectLanguage(l.value);
                  onClose();
                }}
              />
            ))}

            <SheetSectionLabel label="Voice" />
            <ToolRow
              icon={autoReadReplies ? Volume2 : VolumeX}
              label="Voice responses"
              sublabel={autoReadReplies ? undefined : "Off"}
              active={autoReadReplies}
              accentColor={accentColor}
              onPress={onToggleVoiceResponses}
            />

            {isSignedIn && (
              <>
                <SheetSectionLabel label="Memory" />
                <ActionRow icon={Brain} label="Ora memory" onPress={onOpenMemory} />
                <ToolRow
                  icon={Ghost}
                  label="Temporary chat"
                  sublabel={temporary ? undefined : "Off"}
                  active={temporary}
                  accentColor={accentColor}
                  onPress={onToggleTemporary}
                />
              </>
            )}

            {hasMessages && (
              <>
                <SheetSectionLabel label="Conversation" />
                <Pressable
                  onPress={onClearConversation}
                  disabled={sending}
                  accessibilityLabel="Clear conversation"
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 14,
                    paddingVertical: 14,
                    paddingHorizontal: 20,
                    opacity: sending ? 0.4 : 1,
                  }}
                >
                  <Trash2 size={20} color="#EF4444" />
                  <Text style={{ color: "#EF4444", fontFamily: "Inter_500Medium", fontSize: 15 }}>
                    Clear conversation
                  </Text>
                </Pressable>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function MessageActionsSheet({
  message,
  canRegenerate,
  onClose,
  onCopy,
  onShare,
  onSaveFile,
  onExportMarkdown,
  onExportConversation,
  onExportJson,
  onExportCsv,
  onRegenerate,
  onReadAloud,
  onEdit,
  onExportWord,
  onExportExcel,
  onExportPresentation,
  onExportPdf,
}: {
  message: OraMessage | null;
  canRegenerate: boolean;
  onClose: () => void;
  onCopy: (message: OraMessage) => void;
  onShare: (message: OraMessage) => void;
  onSaveFile: (message: OraMessage) => void;
  onExportMarkdown: (message: OraMessage) => void;
  onExportConversation: () => void;
  onExportJson: (message: OraMessage) => void;
  onExportCsv: (message: OraMessage) => void;
  onRegenerate: (message: OraMessage) => void;
  onReadAloud: (message: OraMessage) => void;
  onEdit: (message: OraMessage) => void;
  onExportWord: (message: OraMessage) => void;
  onExportExcel: (message: OraMessage) => void;
  onExportPresentation: (message: OraMessage) => void;
  onExportPdf: (message: OraMessage) => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();

  const isAssistant = message?.role === "assistant";
  const isUser = message?.role === "user";
  const hasContent = !!message?.content.trim();
  const hasDataset = !!message?.datasetResult;
  const hasActionPlan = !!message && !!datasetActionPlanCsv(message);

  return (
    <Modal visible={!!message} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)" }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View
          style={{
            backgroundColor: c.card,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingTop: 8,
            paddingBottom: insets.bottom + 12,
          }}
        >
          <View
            style={{
              alignSelf: "center",
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: c.border,
              marginBottom: 8,
            }}
          />
          {message && (
            <>
              <ActionRow icon={Copy} label="Copy" onPress={() => onCopy(message)} />
              {hasContent && (
                <ActionRow icon={Share2} label="Share" onPress={() => onShare(message)} />
              )}
              {isUser && <ActionRow icon={Pencil} label="Edit" onPress={() => onEdit(message)} />}
              {isAssistant && hasContent && (
                <ActionRow icon={Volume2} label="Read aloud" onPress={() => onReadAloud(message)} />
              )}
              {isAssistant && hasContent && (
                <ActionRow
                  icon={Download}
                  label="Save as file"
                  onPress={() => onSaveFile(message)}
                />
              )}
              {isAssistant && hasContent && (
                <ActionRow
                  icon={FileText}
                  label="Export Markdown"
                  onPress={() => onExportMarkdown(message)}
                />
              )}
              {isAssistant && hasContent && (
                <ActionRow
                  icon={FileText}
                  label="Export conversation Markdown"
                  onPress={() => onExportConversation()}
                />
              )}
              {(hasDataset || isAssistant) && (
                <ActionRow
                  icon={FileJson}
                  label={hasDataset ? "Export dataset JSON" : "Export message JSON"}
                  onPress={() => onExportJson(message)}
                />
              )}
              {hasActionPlan && (
                <ActionRow
                  icon={FileSpreadsheet}
                  label="Export action-plan CSV"
                  onPress={() => onExportCsv(message)}
                />
              )}
              {isAssistant && hasContent && (
                <ActionRow
                  icon={FileText}
                  label="Word Report"
                  onPress={() => onExportWord(message)}
                />
              )}
              {isAssistant && hasContent && (
                <ActionRow
                  icon={FileSpreadsheet}
                  label="Excel Workbook"
                  onPress={() => onExportExcel(message)}
                />
              )}
              {isAssistant && hasContent && (
                <ActionRow
                  icon={Presentation}
                  label="Presentation"
                  onPress={() => onExportPresentation(message)}
                />
              )}
              {isAssistant && hasContent && (
                <ActionRow
                  icon={FileDown}
                  label="PDF Report"
                  onPress={() => onExportPdf(message)}
                />
              )}
              {isAssistant && canRegenerate && (
                <ActionRow
                  icon={RefreshCw}
                  label="Regenerate"
                  onPress={() => onRegenerate(message)}
                />
              )}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

// Bottom-sheet mirror of the website's per-conversation "Move to" menu. Lists
// every project except the conversation's current one, plus "Recent" when the
// conversation is currently scoped to a project. The server validates ownership.
function MoveConversationSheet({
  conversation,
  projects,
  onClose,
  onMove,
}: {
  conversation: OraConversationSummary | null;
  projects: OraProjectSummary[];
  onClose: () => void;
  onMove: (conversationId: number, projectId: number | null) => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();

  const targets = conversation ? projects.filter((p) => p.id !== conversation.projectId) : [];
  const canMoveToRecent = conversation?.projectId != null;
  const isEmpty = targets.length === 0 && !canMoveToRecent;

  return (
    <Modal visible={!!conversation} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)" }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View
          style={{
            backgroundColor: c.card,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingTop: 8,
            paddingBottom: insets.bottom + 12,
            maxHeight: "70%",
          }}
        >
          <View
            style={{
              alignSelf: "center",
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: c.border,
              marginBottom: 8,
            }}
          />
          <SheetSectionLabel label="Move to" />
          {conversation && (
            <ScrollView>
              {canMoveToRecent && (
                <ActionRow
                  icon={MessageSquare}
                  label="Recent (no project)"
                  onPress={() => onMove(conversation.id, null)}
                />
              )}
              {targets.map((p) => (
                <ActionRow
                  key={p.id}
                  icon={Folder}
                  label={p.name}
                  onPress={() => onMove(conversation.id, p.id)}
                />
              ))}
              {isEmpty && (
                <Text
                  style={{
                    color: c.mutedForeground,
                    fontSize: 14,
                    paddingHorizontal: 20,
                    paddingVertical: 16,
                  }}
                >
                  No other projects yet. Create a project first.
                </Text>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function ActionRow({
  icon: Icon,
  label,
  onPress,
  disabled,
}: {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 14,
        paddingHorizontal: 20,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Icon size={20} color={c.foreground} />
      <Text style={{ color: c.foreground, fontFamily: "Inter_500Medium", fontSize: 15 }}>
        {label}
      </Text>
    </Pressable>
  );
}

function ToolRow({
  icon: Icon,
  label,
  sublabel,
  active,
  disabled,
  accentColor,
  onPress,
}: {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
  sublabel?: string;
  active: boolean;
  disabled?: boolean;
  accentColor?: string;
  onPress: () => void;
}) {
  const c = useColors();
  const accent = accentColor ?? c.accentForeground;
  const iconColor = disabled ? c.mutedForeground : active ? accent : c.foreground;
  const labelColor = disabled ? c.mutedForeground : active ? accent : c.foreground;
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 14,
        paddingHorizontal: 20,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Icon size={20} color={iconColor} />
      <Text
        style={{
          flex: 1,
          color: labelColor,
          fontFamily: "Inter_500Medium",
          fontSize: 15,
        }}
      >
        {label}
      </Text>
      {sublabel && !active && (
        <Text style={{ color: c.mutedForeground, fontSize: 12 }}>{sublabel}</Text>
      )}
      {active && <Check size={18} color={accent} />}
    </Pressable>
  );
}

function SheetSectionLabel({ label }: { label: string }) {
  const c = useColors();
  return (
    <Text
      style={{
        color: c.mutedForeground,
        fontFamily: "Inter_600SemiBold",
        fontSize: 12,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 4,
      }}
    >
      {label}
    </Text>
  );
}
