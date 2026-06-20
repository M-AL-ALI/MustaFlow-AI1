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
  Copy,
  Download,
  FileText,
  Gauge,
  History,
  Image as ImageIcon,
  Mic,
  Paperclip,
  PhoneCall,
  Plus,
  Share2,
  Sparkles,
  Square,
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
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Markdown } from "@/components/Markdown";
import { ScreenHeader } from "@/components/ScreenHeader";
import { EmptyState, Pill } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { saveGeneratedFile, saveImageFromUrl } from "@/lib/files";
import {
  analyzeDataset,
  analyzeDocument,
  analyzeImage,
  createConversation,
  deleteConversation,
  getConversation,
  getOraSession,
  getPreferences,
  listConversations,
  saveConversationMessages,
  sendChat,
  streamChatNative,
  synthesizeSpeech,
  transcribeAudio,
  uploadFile,
} from "@/lib/api";
import type {
  Attachment,
  OraConversationSummary,
  OraMessage,
  OraMode,
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

const DATASET_TYPES = ["csv", "xlsx", "xls"];

function attachmentKind(fileType: string, isImage: boolean): Attachment["kind"] {
  if (isImage) return "image";
  if (DATASET_TYPES.includes(fileType.toLowerCase())) return "dataset";
  return "document";
}

function isImageFile(mimeType?: string): boolean {
  return !!mimeType && mimeType.toLowerCase().startsWith("image/");
}

export default function OraChatScreen() {
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

  const [voiceLang, setVoiceLang] = useState("en");
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
  }, [loadPreferences]);

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
    async (msgs: OraMessage[]) => {
      try {
        let convId = conversationId;
        if (!convId) {
          const title = msgs.find((m) => m.role === "user")?.content.slice(0, 60) || "New chat";
          const created = await createConversation(title, null);
          convId = created.conversation.id;
          setConversationId(convId);
        }
        await saveConversationMessages(convId, msgs);
      } catch {
        /* persistence is best-effort */
      }
    },
    [conversationId],
  );

  const sendMessage = useCallback(
    async (text: string, attch: Attachment | null) => {
      if ((!text && !attch) || sending) return;

      // Abort any previous in-flight stream before starting a new one.
      streamAbortRef.current?.abort();
      const abortController = new AbortController();
      streamAbortRef.current = abortController;

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
        let assistant: OraMessage;

        if (attch) {
          // Attachment analysis — no streaming on these specialized endpoints.
          const prompt = text || "Please analyze this attachment.";
          let reply: string;
          if (attch.kind === "image") {
            reply = (await analyzeImage(attch.ref, prompt, history)).reply;
          } else if (attch.kind === "dataset") {
            reply = (await analyzeDataset(attch.ref, prompt, history)).reply;
          } else {
            reply = (await analyzeDocument(attch.ref, prompt, history)).reply;
          }
          assistant = { id: pendingId, role: "assistant", content: reply };
        } else {
          // Plain chat — attempt SSE streaming first.
          const chatReq = {
            message: text,
            messages: history,
            mode,
            referenceSavedMemories: true as const,
            referenceChatHistory: true as const,
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
              sources: res.sources,
              imageUrl: res.imageUrl,
              imageId: res.imageId,
              viaFallback: true,
              ...(res.fileName && res.fileData && res.mimeType
                ? {
                    file: {
                      fileName: res.fileName,
                      fileData: res.fileData,
                      mimeType: res.mimeType,
                    },
                  }
                : {}),
            };
            if (res.msgCount != null && res.msgLimit != null) {
              setSession((s) =>
                s ? { ...s, msgCount: res.msgCount!, msgLimit: res.msgLimit! } : s,
              );
            }
          } else if (streamResult.ok) {
            // Streaming succeeded — apply final metadata from the done payload.
            assistant = {
              id: pendingId,
              role: "assistant",
              content: streamResult.reply || streamedContent,
              isStreaming: false,
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
              sources: res.sources,
              imageUrl: res.imageUrl,
              imageId: res.imageId,
              viaFallback: true,
              file:
                res.fileName && res.fileData && res.mimeType
                  ? { fileName: res.fileName, fileData: res.fileData, mimeType: res.mimeType }
                  : undefined,
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
        void persist(finalMsgs);
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
    [sending, messages, mode, scrollToEnd, persist, scheduleTalkRestart],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && !attachment) || sending) return;
    const attch = attachment;
    setInput("");
    setAttachment(null);
    await sendMessage(text, attch);
  }, [input, attachment, sending, sendMessage]);

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
    async (file: { uri: string; name: string; type: string }, isImage: boolean) => {
      setUploading(true);
      try {
        const res = await uploadFile({ uri: file.uri, name: file.name, type: file.type });
        const ref = res.imageRef ?? res.fileRef;
        if (!ref) throw new Error("Upload failed");
        setAttachment({
          ref,
          kind: attachmentKind(res.fileType, isImage || res.kind === "image"),
          filename: res.filename ?? file.name,
          fileType: res.fileType,
        });
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const handleCameraCapture = useCallback(async () => {
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
      },
      true,
    );
  }, [doUpload]);

  const handleGalleryPick = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Photo library access is required to choose photos.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    await doUpload(
      {
        uri: asset.uri,
        name: asset.fileName ?? `image_${Date.now()}.jpg`,
        type: asset.mimeType ?? "image/jpeg",
      },
      true,
    );
  }, [doUpload]);

  const handleAttach = useCallback(() => {
    Alert.alert("Attach", "Choose a source", [
      { text: "Take Photo", onPress: () => void handleCameraCapture() },
      { text: "Photo Library", onPress: () => void handleGalleryPick() },
      {
        text: "Browse Files",
        onPress: () =>
          void (async () => {
            try {
              const picked = await DocumentPicker.getDocumentAsync({
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
              if (picked.canceled || !picked.assets?.[0]) return;
              const file = picked.assets[0];
              const isImage = (file.mimeType ?? "").startsWith("image/");
              await doUpload(
                { uri: file.uri, name: file.name, type: file.mimeType ?? "application/octet-stream" },
                isImage,
              );
            } catch {
              /* surfaced by absence of chip */
            }
          })(),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [handleCameraCapture, handleGalleryPick, doUpload]);

  const newChat = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setAttachment(null);
    setInput("");
  }, []);

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
    setShowConversations(true);
    setLoadingConversations(true);
    try {
      setConversations(await listConversations());
    } catch {
      setConversations([]);
    } finally {
      setLoadingConversations(false);
    }
  }, []);

  const loadConversation = useCallback(
    async (id: number) => {
      setShowConversations(false);
      try {
        const detail = await getConversation(id);
        setConversationId(id);
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

  const usageText = session
    ? `${session.msgCount}/${session.msgLimit} messages${session.tier ? ` · ${session.tier}` : ""}`
    : "Loading…";

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

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader
        title="Ora"
        subtitle={usageText}
        right={
          <View style={{ flexDirection: "row", gap: 4 }}>
            <Pressable
              onPress={toggleTalkMode}
              hitSlop={8}
              style={{ padding: 6 }}
              accessibilityLabel={talkMode ? "Exit Talk to Ora" : "Talk to Ora"}
            >
              <PhoneCall size={22} color={talkMode ? c.accentForeground : c.foreground} />
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
            <View style={{ flex: 1, justifyContent: "center" }}>
              <EmptyState
                icon={Sparkles}
                title="Ask Ora anything"
                subtitle="Brainstorm ideas, analyze files and images, search the web, or generate documents — all in one conversation."
              />
            </View>
          }
          renderItem={({ item }) => (
            <MessageBubble
              message={item}
              speaking={speakingId === item.id}
              onSpeak={() => speak(item)}
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
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pill
              label="Instant"
              icon={Zap}
              active={mode === "instant"}
              onPress={() => setMode("instant")}
            />
            <Pill
              label="Deep"
              icon={Gauge}
              active={mode === "deep"}
              onPress={() => setMode("deep")}
            />
          </View>

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
                onPress={handleAttach}
                disabled={uploading}
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
                  <Paperclip size={20} color={c.mutedForeground} />
                )}
              </Pressable>
            )}
            <Pressable
              onPress={recording ? stopRecording : startRecording}
              disabled={transcribing}
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
                    borderRadius: c.radius,
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

      <ConversationsModal
        visible={showConversations}
        loading={loadingConversations}
        conversations={conversations}
        activeId={conversationId}
        onClose={() => setShowConversations(false)}
        onSelect={loadConversation}
        onDelete={removeConversation}
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
}: {
  message: OraMessage;
  speaking: boolean;
  onSpeak: () => void;
}) {
  const c = useColors();
  const isUser = message.role === "user";
  const [savingFile, setSavingFile] = useState(false);
  const [savingImage, setSavingImage] = useState(false);

  const copy = () => Clipboard.setStringAsync(message.content);

  const handleSaveFile = useCallback(async () => {
    if (!message.file || savingFile) return;
    setSavingFile(true);
    try {
      const outcome = await saveGeneratedFile(message.file);
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
  }, [message.file, savingFile]);

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
        <View
          style={{
            backgroundColor: c.primary,
            borderRadius: 18,
            borderBottomRightRadius: 4,
            paddingHorizontal: 14,
            paddingVertical: 10,
            maxWidth: "86%",
          }}
        >
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
        </View>
      </View>
    );
  }

  return (
    <View style={{ alignItems: "flex-start", maxWidth: "92%" }}>
      <View
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
              </View>
            )}

            {message.file && (
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
                  {message.file.fileName}
                </Text>
                {savingFile ? (
                  <ActivityIndicator size="small" color={c.mutedForeground} />
                ) : isImageFile(message.file.mimeType) ? (
                  <Download size={16} color={c.accentForeground} />
                ) : (
                  <Share2 size={16} color={c.accentForeground} />
                )}
              </Pressable>
            )}

            {message.sources && message.sources.length > 0 && (
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
                {message.sources.map((s, i) => (
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
          </>
        )}
      </View>
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

function ConversationsModal({
  visible,
  loading,
  conversations,
  activeId,
  onClose,
  onSelect,
  onDelete,
}: {
  visible: boolean;
  loading: boolean;
  conversations: OraConversationSummary[];
  activeId: number | null;
  onClose: () => void;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
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
            maxHeight: "75%",
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
            <Text
              style={{
                color: c.foreground,
                fontFamily: "Inter_700Bold",
                fontSize: 18,
              }}
            >
              Conversations
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={22} color={c.mutedForeground} />
            </Pressable>
          </View>

          {loading ? (
            <ActivityIndicator color={c.primary} style={{ marginVertical: 32 }} />
          ) : conversations.length === 0 ? (
            <EmptyState icon={History} title="No conversations yet" />
          ) : (
            <ScrollView contentContainerStyle={{ paddingHorizontal: 12 }}>
              {conversations.map((conv) => (
                <View
                  key={conv.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingVertical: 12,
                    paddingHorizontal: 12,
                    borderRadius: c.radius,
                    backgroundColor: conv.id === activeId ? c.accent : "transparent",
                  }}
                >
                  <Pressable style={{ flex: 1 }} onPress={() => onSelect(conv.id)}>
                    <Text
                      numberOfLines={1}
                      style={{
                        color: c.foreground,
                        fontFamily: "Inter_500Medium",
                        fontSize: 15,
                      }}
                    >
                      {conv.title || "Untitled"}
                    </Text>
                    {conv.preview ? (
                      <Text
                        numberOfLines={1}
                        style={{
                          color: c.mutedForeground,
                          fontSize: 13,
                          marginTop: 2,
                        }}
                      >
                        {conv.preview}
                      </Text>
                    ) : null}
                  </Pressable>
                  <Pressable onPress={() => onDelete(conv.id)} hitSlop={8}>
                    <X size={18} color={c.mutedForeground} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}
