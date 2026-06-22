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
import { useFocusEffect } from "expo-router";
import {
  ArrowUp,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileDown,
  FileJson,
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
  Lock,
  MessageSquare,
  Mic,
  Pencil,
  PhoneCall,
  Plus,
  RefreshCw,
  Share2,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react-native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Markdown } from "@/components/Markdown";
import { OraAssistantExtras, OraAttachmentChip } from "@/components/ora/MessageExtras";
import { ScreenHeader } from "@/components/ScreenHeader";
import { EmptyState } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import {
  getLocalFileSize,
  MAX_UPLOAD_BYTES,
  saveGeneratedFile,
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
  deleteProject,
  editImage,
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
  sendChat,
  streamChatNative,
  synthesizeSpeech,
  transcribeAudio,
  uploadFile,
} from "@/lib/api";
import type {
  Attachment,
  ChatRequest,
  ChatResponse,
  FileFormat,
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

function messageMarkdown(message: OraMessage): string {
  const lines = [`# ${messageTitle(message)}`, "", message.content.trim()];
  if (message.sources?.length) {
    lines.push("", "## Sources");
    message.sources.forEach((source, index) => {
      lines.push(`${index + 1}. ${source.title ?? source.url ?? "Source"}`);
      if (source.url) lines.push(`   ${source.url}`);
    });
  }
  if (message.datasetResult) {
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

function reportRtf(messages: OraMessage[], title: string): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
  const body = messages
    .filter((m) => m.content.trim())
    .map(
      (m) =>
        `{\\b ${esc(m.role === "assistant" ? "Ora" : "You")}:}  ` +
        `${esc(m.content.trim()).replace(/\n/g, "\\line ")}\\par\\par `,
    )
    .join("");
  return (
    `{\\rtf1\\ansi\\deff0\n{\\fonttbl{\\f0\\fswiss Arial;}}\n` +
    `\\f0\\fs24\\b ${esc(title)}\\b0\\par\\par\n${body}}`
  );
}

function reportCsv(messages: OraMessage[]): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = messages
    .filter((m) => m.content.trim())
    .map((m) => [q(m.role === "assistant" ? "Ora" : "You"), q(m.content.trim())].join(","))
    .join("\n");
  return `"Role","Content"\n${rows}`;
}

function reportPresentationHtml(messages: OraMessage[], title: string): string {
  const slides = messages
    .filter((m) => m.role === "assistant" && m.content.trim())
    .map(
      (m, i) =>
        `<section><h2>Slide ${i + 1}</h2>` +
        `<p>${m.content.trim().replace(/\n/g, "<br>")}</p></section>`,
    )
    .join("");
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{font-family:Arial,sans-serif;max-width:900px;margin:0 auto;padding:20px}` +
    `section{border-bottom:2px solid #ddd;padding:32px 0;margin-bottom:16px}` +
    `h2{color:#4B6BFB}p{font-size:16px;line-height:1.6}` +
    `@media print{section{page-break-after:always}}</style></head>` +
    `<body><h1>${title}</h1>${slides}</body></html>`
  );
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

function formatReset(resetsAt: string | null | undefined): string {
  if (!resetsAt) return "";
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return "";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `resets in ${h}h`;
  if (m > 0) return `resets in ${m}m`;
  return "resetting soon";
}

const EXAMPLE_CHIPS = [
  "Plan an app idea",
  "Find the root cause of a problem",
  "Help me think through a strategy",
  "Analyze a business idea",
  "What can you help me with?",
  "Research a topic for me",
];

// Matches website Ora LANGUAGES constant in ora-panel.tsx
const LANGUAGES = [
  { value: "auto", label: "Auto" },
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

function OraLogoTitle({ accentColor }: { accentColor: string }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: 1,
          borderColor: accentColor,
          backgroundColor: `${accentColor}18`,
        }}
      >
        <View
          style={{
            position: "absolute",
            width: 26,
            height: 10,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: `${accentColor}99`,
            transform: [{ rotate: "28deg" }],
          }}
        />
        <View
          style={{
            position: "absolute",
            width: 26,
            height: 10,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: `${accentColor}99`,
            transform: [{ rotate: "-28deg" }],
          }}
        />
        <Image
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          source={require("../../assets/logo.png")}
          style={{ width: 20, height: 20, borderRadius: 5 }}
          contentFit="contain"
        />
      </View>
      <Text
        numberOfLines={1}
        style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 18 }}
      >
        Ora
      </Text>
    </View>
  );
}

function attachmentKind(fileType: string, isImage: boolean): Attachment["kind"] {
  if (isImage) return "image";
  if (DATASET_TYPES.includes(fileType.toLowerCase())) return "dataset";
  return "document";
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
function buildGeneratedFile(res: ChatResponse): GeneratedFile | undefined {
  if (!res.fileName || !res.fileData || !res.mimeType) return undefined;
  return {
    fileName: res.fileName,
    fileData: res.fileData,
    mimeType: res.mimeType,
    format: detectFileFormat(res.fileName, res.mimeType),
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
    memorySaveCandidate: res.memorySaveCandidate,
    memorySaveCandidateConfidence: res.memorySaveCandidateConfidence,
    memorySaveCandidateSensitive: res.memorySaveCandidateSensitive,
    memoriesUsed: res.memoriesUsed,
    generatedFile: buildGeneratedFile(res),
  };
}

export default function OraChatScreen() {
  const { isSignedIn } = useAuth();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<OraMessage>>(null);

  const [session, setSession] = useState<OraSession | null>(null);
  const [messages, setMessages] = useState<OraMessage[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<OraMode>("instant");
  const [sending, setSending] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [showConversations, setShowConversations] = useState(false);
  const [conversations, setConversations] = useState<OraConversationSummary[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [projects, setProjects] = useState<OraProjectSummary[]>([]);
  // The project new chats are filed under. null = standalone ("Recent"). This
  // single state is the source of truth for scope; new conversations created by
  // persist() inherit it via activeProjectIdRef. No route-derived tri-state.
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
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
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [actionsMessage, setActionsMessage] = useState<OraMessage | null>(null);

  const [voiceLang, setVoiceLang] = useState("en");
  // Per-session Ora reply language — matches website LANGUAGES (auto/en/ar/es/fr).
  // Separate from voiceLang (which controls STT/TTS locale). Sent in every chat
  // request so the server applies a language override system prompt when non-auto.
  const [language, setLanguage] = useState("auto");
  const [autoReadReplies, setAutoReadReplies] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [talkMode, setTalkMode] = useState(false);
  const [talkModeMuted, setTalkModeMuted] = useState(false);
  const talkModeRef = useRef(false);
  talkModeRef.current = talkMode;
  const talkModeMutedRef = useRef(false);
  talkModeMutedRef.current = talkModeMuted;
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

  const loadPreferences = useCallback(() => {
    getPreferences()
      .then((p) => {
        if (p.voiceLang) setVoiceLang(p.voiceLang);
        setAutoReadReplies(!!p.autoReadReplies);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    getOraSession()
      .then(setSession)
      .catch(() => setSession(null));
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
  }, [loadPreferences, isSignedIn]);

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

  const scheduleTalkRestart = useCallback(
    (delayMs: number) => {
      cancelTalkRestart();
      talkRestartTimerRef.current = setTimeout(() => {
        talkRestartTimerRef.current = null;
        if (
          !talkModeRef.current ||
          recordingRef.current ||
          transcribingRef.current ||
          speakingIdRef.current
        ) {
          return;
        }
        void startRecordingRef.current();
      }, delayMs);
    },
    [cancelTalkRestart],
  );

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

  const sendMessage = useCallback(
    async (text: string, attch: Attachment | null, opts?: { truncateTo?: number }) => {
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
            referenceSavedMemories: !!isSignedIn && !temporary,
            referenceChatHistory: !!isSignedIn && !temporary,
            temporary,
          };

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
            // Feature disabled or ReadableStream missing — total fallback.
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
            // The conversational stream carries suggestions/videos/memory only
            // (never sources/images/files — those come from the /chat path).
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
            // via onToken callbacks. Finalize without retrying.
            assistant = {
              id: pendingId,
              role: "assistant",
              content: streamedContent,
              isStreaming: false,
            };
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
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId
              ? { ...m, pending: false, isStreaming: false, error: true, content: msg }
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
    [sending, messages, mode, temporary, scrollToEnd, persist, scheduleTalkRestart, isSignedIn],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && !attachment) || sending) return;
    const attch = attachment;
    setInput("");
    setAttachment(null);
    await sendMessage(text, attch);
  }, [input, attachment, sending, sendMessage]);

  // Tapping a follow-up suggestion chip sends it as the next message.
  const handleSuggestion = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || sending) return;
      void sendMessage(clean, null);
    },
    [sending, sendMessage],
  );

  // Persist a memory-save candidate, then mark the message as saved in place.
  // Mobile has no dedicated save-candidate endpoint, so saveOraMemory derives a
  // short title (mirroring the web) and writes through the Ora memories API,
  // returning the titles of any earlier memories this fact superseded so the
  // chip can name exactly what changed. The updated transcript is persisted
  // immediately so the saved/superseded state survives a reload.
  const handleSaveMemory = useCallback(
    async (message: OraMessage) => {
      // Never write memory from an anonymous or temporary chat.
      if (!isSignedIn || temporaryRef.current) return;
      const fact = message.memorySaveCandidate?.trim();
      if (!fact) return;
      const supersededTitles = await saveOraMemory(fact);
      const next = messages.map((m) =>
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
      void persist(next);
    },
    [messages, persist, isSignedIn],
  );

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

  const handleExportWord = useCallback(
    async (message: OraMessage) => {
      const title = messageTitle(message);
      try {
        await saveTextAsFile(
          reportRtf(
            messages.filter((m) => m.content.trim()),
            title,
          ),
          "ora-report.rtf",
          "application/rtf",
        );
      } catch (err) {
        Alert.alert("Export failed", err instanceof Error ? err.message : "Something went wrong.");
      }
    },
    [messages],
  );

  const handleExportExcel = useCallback(
    async (message: OraMessage) => {
      const src = message.datasetResult ? [message] : messages.filter((m) => m.content.trim());
      try {
        await saveTextAsFile(reportCsv(src), "ora-data.csv", "text/csv");
      } catch (err) {
        Alert.alert("Export failed", err instanceof Error ? err.message : "Something went wrong.");
      }
    },
    [messages],
  );

  const handleExportPresentation = useCallback(
    async (message: OraMessage) => {
      const title = messageTitle(message);
      try {
        await saveTextAsFile(
          reportPresentationHtml(
            messages.filter((m) => m.content.trim()),
            title,
          ),
          "ora-presentation.html",
          "text/html",
        );
      } catch (err) {
        Alert.alert("Export failed", err instanceof Error ? err.message : "Something went wrong.");
      }
    },
    [messages],
  );

  const handleExportPdf = useCallback(
    async (message: OraMessage) => {
      const title = messageTitle(message);
      try {
        await saveTextAsFile(
          reportPdfHtml(
            messages.filter((m) => m.content.trim()),
            title,
          ),
          "ora-report.html",
          "text/html",
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
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) return;
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
      setRecording(false);
    }
  }, [recording, transcribing, recorder]);

  const stopRecording = useCallback(async () => {
    if (!recording) return;
    setRecording(false);
    setTranscribing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await recorder.stop();
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      const uri = recorder.uri;
      if (!uri) return;
      const text = await transcribeAudio(uri, "m4a", voiceLang);
      const clean = text.trim();
      if (clean) {
        if (talkModeRef.current) {
          // Talk mode: auto-send without putting in input field for editing
          void sendMessageRef.current(clean, null);
        } else {
          // Normal dictation: fill the input so the user can review/edit before sending
          setInput((prev) => (prev.trim() ? `${prev.trim()} ${clean}` : clean));
        }
      }
    } catch {
      /* surfaced by absence of inserted text */
    } finally {
      setTranscribing(false);
    }
  }, [recording, recorder, voiceLang]);

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
      try {
        // Strip markdown so the voice sounds natural (no "hashtag hashtag" etc.)
        const spokenText = cleanForTts(message.content) || message.content;
        const dataUri = await synthesizeSpeech(spokenText, "nova", voiceLang);
        const base64 = dataUri.split(",")[1] ?? "";
        const fileUri = `${FileSystem.cacheDirectory}ora-tts-${Date.now()}.mp3`;
        await FileSystem.writeAsStringAsync(fileUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
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
            "Files must be 10 MB or smaller. Please choose a smaller file.",
          );
          return;
        }
        const res = await uploadFile({ uri: file.uri, name: file.name, type: file.type });
        const ref = res.imageRef ?? res.fileRef;
        if (!ref) throw new Error("Upload failed");
        setAttachment({
          ref,
          kind: attachmentKind(res.fileType, isImage || res.kind === "image"),
          filename: res.filename ?? file.name,
          fileType: res.fileType,
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

  const newChat = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setAttachment(null);
    setInput("");
  }, []);

  // Toggle temporary mode. Either direction starts a clean conversation so
  // temporary and saved turns never mix in one thread (mirrors the website).
  const toggleTemporary = useCallback(() => {
    // Block toggling during an in-flight send to avoid clearing a live thread.
    if (sending) return;
    setTemporary((prev) => !prev);
    setMessages([]);
    setConversationId(null);
    setAttachment(null);
    setInput("");
  }, [sending]);

  const toggleTalkMode = useCallback(() => {
    const next = !talkMode;
    setTalkMode(next);
    talkModeRef.current = next;
    if (!next) {
      cancelTalkRestart();
      // Exiting: stop any TTS that is playing
      if (speakingId) {
        try {
          playerRef.current?.remove();
        } catch {
          /* ignore */
        }
        playerRef.current = null;
        setSpeakingId(null);
      }
      // If the mic is active, stop it (user is leaving voice mode)
      if (recording) void stopRecordingRef.current();
    } else {
      // Entering Talk mode: stop TTS if playing and immediately start listening
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
      scheduleTalkRestart(300);
    }
  }, [cancelTalkRestart, recording, scheduleTalkRestart, speakingId, talkMode]);

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
    const [convs, projs] = await Promise.allSettled([listConversations(), listProjects()]);
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
    const [convs, projs] = await Promise.allSettled([listConversations(), listProjects()]);
    if (convs.status === "fulfilled") setConversations(convs.value);
    if (projs.status === "fulfilled") {
      projectsLoadedRef.current = true;
      setProjects(projs.value);
    }
  }, []);

  const loadConversation = useCallback(
    async (id: number) => {
      setShowConversations(false);
      // Opening a saved conversation always exits temporary mode.
      setTemporary(false);
      try {
        const detail = await getConversation(id);
        setConversationId(id);
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
    [scrollToEnd],
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

  const usageText = session
    ? (() => {
        const reset = formatReset(session.resetsAt);
        return `${session.msgCount}/${session.msgLimit} messages${reset ? ` · ${reset}` : ""}`;
      })()
    : "Loading…";

  // Mirrors website: deepAllowed = tier === "core" || tier === "wave"
  // Free / anonymous users are gated to Instant mode only.
  const deepAllowed = session?.tier === "core" || session?.tier === "wave";

  // Tier-specific accent color — mirrors website's --ora-accent-hsl CSS var on the panel root.
  // Used for Ora-specific active states (mode indicator, language selector, temp/talk toggles).
  // Falls back to the theme's fixed accent when session has not loaded yet.
  const tierAccent = session?.tier ? tierAccentColor(session.tier) : c.accentForeground;

  // Reset to Instant if tier drops and Deep is active (e.g. plan downgrade)
  useEffect(() => {
    if (!deepAllowed && mode === "deep") setMode("instant");
  }, [deepAllowed, mode]);

  const activeProjectName = activeProjectId
    ? (projects.find((p) => p.id === activeProjectId)?.name ?? "Project")
    : null;

  const talkStatusTitle = sending
    ? "Ora is thinking"
    : speakingId
      ? "Ora is speaking"
      : transcribing
        ? "Transcribing"
        : recording
          ? "Listening"
          : "Voice mode active";

  const talkStatusSubtitle = talkModeMuted
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
        titleNode={<OraLogoTitle accentColor={tierAccent} />}
        subtitle={usageText}
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {session?.tier && (
              <View
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: tierAccentColor(session.tier),
                  backgroundColor: tierAccentColor(session.tier) + "20",
                  marginRight: 2,
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
            )}
            <Pressable
              onPress={toggleTemporary}
              hitSlop={8}
              disabled={sending}
              style={{ padding: 6, opacity: sending ? 0.4 : 1 }}
              accessibilityLabel={temporary ? "Turn off temporary chat" : "Start temporary chat"}
            >
              <Ghost size={22} color={temporary ? tierAccent : c.foreground} />
            </Pressable>
            <Pressable
              onPress={toggleTalkMode}
              hitSlop={8}
              style={{ padding: 6 }}
              accessibilityLabel={talkMode ? "Exit Talk to Ora" : "Talk to Ora"}
            >
              <PhoneCall size={22} color={talkMode ? tierAccent : c.foreground} />
            </Pressable>
            <Pressable onPress={openConversations} hitSlop={8} style={{ padding: 6 }}>
              <History size={22} color={c.foreground} />
            </Pressable>
            <Pressable onPress={newChat} hitSlop={8} style={{ padding: 6 }}>
              <Plus size={22} color={c.foreground} />
            </Pressable>
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

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={insets.top + 44}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{
            padding: 16,
            gap: 14,
            flexGrow: 1,
          }}
          onContentSizeChange={scrollToEnd}
          ListEmptyComponent={
            <View style={{ flex: 1, justifyContent: "center", gap: 20 }}>
              <EmptyState
                icon={Sparkles}
                title="Ask Ora anything"
                subtitle="Brainstorm ideas, analyze files and images, search the web, or generate documents — all in one conversation."
              />
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 8,
                  justifyContent: "center",
                  paddingHorizontal: 8,
                }}
              >
                {EXAMPLE_CHIPS.map((chip) => (
                  <Pressable
                    key={chip}
                    onPress={() => setInput(chip)}
                    style={{
                      paddingHorizontal: 14,
                      paddingVertical: 8,
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: c.border,
                      backgroundColor: c.card,
                    }}
                  >
                    <Text
                      style={{
                        color: c.foreground,
                        fontSize: 13,
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
              speaking={speakingId === item.id}
              onSpeak={() => speak(item)}
              onSuggestion={handleSuggestion}
              onSaveMemory={temporary ? undefined : handleSaveMemory}
              onLongPress={() => setActionsMessage(item)}
              onEditImage={(id) => {
                setEditingImageId(id);
                setEditInstruction("");
              }}
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
          {mode === "deep" && (
            <View style={{ flexDirection: "row" }}>
              <Pressable
                onPress={() => setMode("instant")}
                accessibilityLabel="Turn off Deep Thinking"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  alignSelf: "flex-start",
                  paddingVertical: 6,
                  paddingHorizontal: 12,
                  borderRadius: 999,
                  backgroundColor: c.secondary,
                  borderWidth: 1,
                  borderColor: c.border,
                }}
              >
                <Gauge size={14} color={tierAccent} />
                <Text style={{ color: c.foreground, fontFamily: "Inter_500Medium", fontSize: 13 }}>
                  Deep Thinking
                </Text>
                <X size={13} color={c.mutedForeground} />
              </Pressable>
            </View>
          )}

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

          {talkMode && (
            <View
              style={{
                backgroundColor: c.card,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: c.radius,
                padding: 12,
                gap: 10,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <View
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 17,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: speakingId ? c.primary : c.secondary,
                  }}
                >
                  <PhoneCall
                    size={18}
                    color={speakingId ? c.primaryForeground : c.mutedForeground}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text
                    style={{
                      color: c.foreground,
                      fontFamily: "Inter_600SemiBold",
                      fontSize: 14,
                    }}
                  >
                    {talkStatusTitle}
                  </Text>
                  <Text style={{ color: c.mutedForeground, fontSize: 12, marginTop: 2 }}>
                    {talkStatusSubtitle}
                  </Text>
                </View>
              </View>

              <View style={{ flexDirection: "row", gap: 8 }}>
                {speakingId && (
                  <Pressable
                    onPress={interruptTalkMode}
                    style={{
                      flex: 1,
                      minHeight: 38,
                      borderRadius: c.radius,
                      borderWidth: 1,
                      borderColor: c.border,
                      alignItems: "center",
                      justifyContent: "center",
                      flexDirection: "row",
                      gap: 6,
                    }}
                  >
                    <Square size={14} color={c.foreground} fill={c.foreground} />
                    <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold" }}>
                      Interrupt
                    </Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={toggleTalkModeMute}
                  style={{
                    flex: 1,
                    minHeight: 38,
                    borderRadius: c.radius,
                    borderWidth: 1,
                    borderColor: c.border,
                    alignItems: "center",
                    justifyContent: "center",
                    flexDirection: "row",
                    gap: 6,
                  }}
                >
                  {talkModeMuted ? (
                    <VolumeX size={14} color={c.foreground} />
                  ) : (
                    <Volume2 size={14} color={c.foreground} />
                  )}
                  <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold" }}>
                    {talkModeMuted ? "Unmute" : "Mute"}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={toggleTalkMode}
                  style={{
                    flex: 1,
                    minHeight: 38,
                    borderRadius: c.radius,
                    backgroundColor: c.secondary,
                    alignItems: "center",
                    justifyContent: "center",
                    flexDirection: "row",
                    gap: 6,
                  }}
                >
                  <X size={14} color={c.mutedForeground} />
                  <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold" }}>End</Text>
                </Pressable>
              </View>
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

          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
            {!recording && (
              <Pressable
                onPress={() => setShowPlusMenu(true)}
                disabled={uploading}
                accessibilityLabel="Add attachment or choose tools"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: c.radius,
                  backgroundColor: c.secondary,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color={c.mutedForeground} />
                ) : (
                  <Plus size={22} color={c.mutedForeground} />
                )}
              </Pressable>
            )}
            <Pressable
              onPress={recording ? stopRecording : startRecording}
              disabled={transcribing}
              accessibilityRole="button"
              accessibilityLabel={recording ? "Stop recording" : "Record a voice message"}
              style={{
                width: 44,
                height: 44,
                borderRadius: c.radius,
                backgroundColor: recording ? c.destructive : c.secondary,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {transcribing ? (
                <ActivityIndicator size="small" color={c.mutedForeground} />
              ) : recording ? (
                <Square size={18} color={c.primaryForeground} fill={c.primaryForeground} />
              ) : (
                <Mic size={20} color={c.mutedForeground} />
              )}
            </Pressable>
            {recording ? (
              <RecordingIndicator
                recorder={recorder}
                autoStopOnSilence={talkMode}
                onAutoStop={autoStopTalkRecording}
              />
            ) : (
              <>
                <TextInput
                  value={input}
                  onChangeText={setInput}
                  placeholder="Message Ora…"
                  placeholderTextColor={c.mutedForeground}
                  multiline
                  style={{
                    flex: 1,
                    maxHeight: 120,
                    minHeight: 44,
                    backgroundColor: c.card,
                    borderWidth: 1,
                    borderColor: c.border,
                    borderRadius: 20,
                    paddingHorizontal: 14,
                    paddingTop: 12,
                    paddingBottom: 12,
                    color: c.foreground,
                    fontFamily: "Inter_400Regular",
                    fontSize: 15,
                  }}
                />
                <Pressable
                  onPress={handleSend}
                  disabled={sending || (!input.trim() && !attachment)}
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: c.radius,
                    backgroundColor:
                      sending || (!input.trim() && !attachment) ? c.secondary : c.primary,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={c.primaryForeground} />
                  ) : (
                    <ArrowUp
                      size={20}
                      color={!input.trim() && !attachment ? c.mutedForeground : c.primaryForeground}
                    />
                  )}
                </Pressable>
              </>
            )}
          </View>
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
        mode={mode}
        language={language}
        deepAllowed={deepAllowed}
        accentColor={tierAccent}
        onClose={() => setShowPlusMenu(false)}
        onTakePhoto={() => {
          setShowPlusMenu(false);
          void handleCameraCapture();
        }}
        onPickPhoto={() => {
          setShowPlusMenu(false);
          void handleGalleryPick();
        }}
        onBrowseFiles={() => {
          setShowPlusMenu(false);
          void handleBrowseFiles();
        }}
        onSelectMode={(m) => {
          setMode(m);
          setShowPlusMenu(false);
        }}
        onSelectLanguage={(lang) => setLanguage(lang)}
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
  autoStopOnSilence = false,
  onAutoStop,
}: {
  recorder: AudioRecorder;
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
        flex: 1,
        minHeight: 44,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        backgroundColor: c.card,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: c.radius,
        paddingHorizontal: 14,
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
              backgroundColor: c.destructive,
              opacity: 0.55 + level * 0.45,
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

function MessageBubble({
  message,
  speaking,
  onSpeak,
  onSuggestion,
  onSaveMemory,
  onLongPress,
  onEditImage,
}: {
  message: OraMessage;
  speaking: boolean;
  onSpeak: () => void;
  onSuggestion: (text: string) => void;
  onSaveMemory?: (message: OraMessage) => Promise<void>;
  onLongPress: () => void;
  onEditImage?: (imageId: number) => void;
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
            backgroundColor: c.primary,
            borderRadius: 18,
            borderBottomRightRadius: 4,
            paddingHorizontal: 14,
            paddingVertical: 10,
            maxWidth: "86%",
          }}
        >
          <OraAttachmentChip attachment={message.attachment} />
          {!!message.content && (
            <Text
              style={{
                color: c.primaryForeground,
                fontFamily: "Inter_400Regular",
                fontSize: 15,
                lineHeight: 21,
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
    <View style={{ alignItems: "flex-start", maxWidth: "92%" }}>
      <Pressable
        onLongPress={triggerLongPress}
        delayLongPress={300}
        style={{
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.cardBorder,
          borderRadius: 18,
          borderBottomLeftRadius: 4,
          paddingHorizontal: 14,
          paddingVertical: 10,
          width: "100%",
        }}
      >
        {message.pending ? (
          <ActivityIndicator size="small" color={c.mutedForeground} />
        ) : message.error ? (
          <Text style={{ color: c.destructive, fontSize: 14 }}>{message.content}</Text>
        ) : (
          <>
            <Markdown>{message.content}</Markdown>

            {message.imageUrl && (
              <View style={{ marginTop: 10 }}>
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
              <Pressable
                onPress={handleSaveFile}
                disabled={savingFile}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 10,
                  padding: 10,
                  borderRadius: 10,
                  backgroundColor: c.muted,
                }}
              >
                <FileText size={18} color={c.accentForeground} />
                <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 13, flex: 1 }}>
                  {message.generatedFile.fileName}
                </Text>
                {savingFile ? (
                  <ActivityIndicator size="small" color={c.mutedForeground} />
                ) : isImageFile(message.generatedFile.mimeType) ? (
                  <Download size={16} color={c.accentForeground} />
                ) : (
                  <Share2 size={16} color={c.accentForeground} />
                )}
              </Pressable>
            )}

            {safeSources.length > 0 && (
              <View style={{ marginTop: 10, gap: 6 }}>
                <Text
                  style={{
                    color: c.mutedForeground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 12,
                  }}
                >
                  Sources
                </Text>
                {safeSources.map((s, i) => (
                  <Pressable
                    key={`${s.url}-${i}`}
                    onPress={() => WebBrowser.openBrowserAsync(s.url)}
                  >
                    <Text
                      numberOfLines={1}
                      style={{
                        color: c.accentForeground,
                        fontSize: 13,
                        textDecorationLine: "underline",
                      }}
                    >
                      {s.title || s.url}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            <OraAssistantExtras
              message={message}
              onSuggestion={onSuggestion}
              onSaveMemory={onSaveMemory}
            />
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
    </View>
  );
}

function ConversationRow({
  conv,
  active,
  indented,
  onSelect,
  onDelete,
  onMove,
}: {
  conv: OraConversationSummary;
  active: boolean;
  indented?: boolean;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
  onMove: (conversation: OraConversationSummary) => void;
}) {
  const c = useColors();
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
      <MessageSquare size={16} color={c.mutedForeground} />
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
      </Pressable>
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
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  // Always expand the active project when it changes (mirrors the website, which
  // keeps the current project open). The user can still manually collapse it.
  useEffect(() => {
    if (activeProjectId != null) {
      setExpanded((prev) => ({ ...prev, [activeProjectId]: true }));
    }
  }, [activeProjectId]);

  // Standalone chats (no project) live under "Recent"; the rest nest under
  // their project. Server returns projectId per conversation.
  const standalone = conversations.filter((cv) => cv.projectId == null);

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

          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginVertical: 32 }} />
          ) : (
            <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 8 }}>
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

function PlusMenu({
  visible,
  mode,
  language,
  deepAllowed,
  accentColor,
  onClose,
  onTakePhoto,
  onPickPhoto,
  onBrowseFiles,
  onSelectMode,
  onSelectLanguage,
}: {
  visible: boolean;
  mode: OraMode;
  language: string;
  deepAllowed: boolean;
  accentColor: string;
  onClose: () => void;
  onTakePhoto: () => void;
  onPickPhoto: () => void;
  onBrowseFiles: () => void;
  onSelectMode: (mode: OraMode) => void;
  onSelectLanguage: (lang: string) => void;
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
          <SheetSectionLabel label="Attach" />
          <ActionRow icon={Camera} label="Take photo" onPress={onTakePhoto} />
          <ActionRow icon={Images} label="Photo library" onPress={onPickPhoto} />
          <ActionRow icon={FolderOpen} label="Browse files" onPress={onBrowseFiles} />

          <SheetSectionLabel label="Tools" />
          <ToolRow
            icon={Zap}
            label="Instant"
            active={mode === "instant"}
            accentColor={accentColor}
            onPress={() => onSelectMode("instant")}
          />
          <ToolRow
            icon={deepAllowed ? Gauge : Lock}
            label="Deep Thinking"
            sublabel={deepAllowed ? "Step-by-step" : "Upgrade"}
            active={mode === "deep" && deepAllowed}
            disabled={!deepAllowed}
            accentColor={accentColor}
            onPress={() => {
              if (deepAllowed) {
                onSelectMode("deep");
              } else {
                onClose();
                Alert.alert(
                  "Deep Thinking",
                  "Deep Thinking is available with Core Pack or Deep Wave. Upgrade in Settings.",
                  [{ text: "OK" }],
                );
              }
            }}
          />

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
                  label="RTF Document"
                  onPress={() => onExportWord(message)}
                />
              )}
              {isAssistant && hasContent && (
                <ActionRow
                  icon={FileSpreadsheet}
                  label="CSV Export"
                  onPress={() => onExportExcel(message)}
                />
              )}
              {isAssistant && hasContent && (
                <ActionRow
                  icon={Presentation}
                  label="HTML Slides"
                  onPress={() => onExportPresentation(message)}
                />
              )}
              {isAssistant && hasContent && (
                <ActionRow
                  icon={FileDown}
                  label="HTML Report"
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
}: {
  icon: React.ComponentType<{ size?: number; color?: string }>;
  label: string;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 14,
        paddingHorizontal: 20,
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
